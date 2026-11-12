"""
Agentic Rebooking Loop for Smart Metering Cancelled/Aborted Jobs.

Implements:
  - Tool-calling loop with max-step ceiling and strict argument/guardrail checks
  - Reuse of existing Hugging Face / OpenAI-compatible LLM configuration
  - Deterministic MOCK_LLM=true mode running the exact same tool-calling flow
  - Live SSE event streaming for the 8-step reasoning timeline
  - Assisted (human-in-the-loop) & Autonomous execution modes
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Generator

from engine.rebooking_store import (
    append_audit_entry,
    get_job_record,
    get_region_daily_utilisation,
    get_slot_by_id,
    list_escalations,
    resolve_escalation,
    update_job_fields,
)
from engine.rebooking_tools import (
    AgentRunContext,
    TOOL_SCHEMAS,
    draft_customer_message,
    escalate_to_planner,
    execute_tool,
    rebook_job,
    write_audit,
)
from engine.rules_loader import load_rules

CANONICAL_STEPS = [
    "Detect",
    "Dependencies/D30",
    "DNO",
    "Capacity",
    "Decide",
    "Rebook",
    "Message",
    "Log",
]

TOOL_TO_STEP = {
    "get_job": "Detect",
    "check_dependencies_and_d30": "Dependencies/D30",
    "check_dno_flow": "DNO",
    "raise_dno_request": "DNO",
    "get_capacity": "Capacity",
    "rank_slots": "Decide",
    "rebook_job": "Rebook",
    "draft_customer_message": "Message",
    "escalate_to_planner": "Decide",
    "write_audit": "Log",
}


def is_mock_llm_enabled(override: bool | None = None) -> bool:
    if override is not None:
        return bool(override)
    return os.getenv("MOCK_LLM", "false").lower() == "true"


def _system_prompt(mode: str, job_ref: str, rules: dict[str, Any]) -> str:
    threshold = rules.get("capacity_and_ranking", {}).get("utilisation_threshold_pct", 90.0)
    lead_days = rules.get("dno", {}).get("default_lead_time_days", 7)
    return (
        f"You are the EXL Smart Metering Rebooking Agent. Today's date is {date.today().isoformat()}. "
        "Handle a cancelled or aborted job end-to-end by calling the provided tools in order:\n"
        "1. Call get_job to detect job details, reason, SLA due date, contact preference, and vulnerability.\n"
        "2. Call check_dependencies_and_d30. If blocked, call escalate_to_planner (category D30_OR_DEPENDENCY) "
        "and write_audit, then stop.\n"
        "3. Call check_dno_flow. If BLOCKED, escalate_to_planner (category DNO_BLOCKED) and write_audit, then stop. "
        f"If PENDING, call raise_dno_request (lead time {lead_days} days) and search capacity starting on/after "
        "earliest_eligible_date.\n"
        "4. Call get_capacity for the job's region and required_skill within the 28-day horizon.\n"
        f"5. Call rank_slots for the job's sla_due_date (you may omit candidate_slot_ids to rank all slots loaded by get_capacity; threshold <= {threshold}%). "
        "If within_sla_available is false, call escalate_to_planner (category NO_SLOT_WITHIN_SLA) with the "
        "3 nearest_options, write_audit, and stop.\n"
        f"6. Current execution mode is '{mode}'. If mode is 'assisted' OR is_vulnerable is true, NEVER call "
        "rebook_job; instead, if vulnerable call escalate_to_planner (category VULNERABLE_APPROVAL) with the "
        "best_slot, call draft_customer_message with awaiting_approval=true, and call write_audit with "
        "status='AWAITING_APPROVAL'. Only in 'autonomous' mode for non-vulnerable jobs, call rebook_job with the "
        "exact best_slot slot_id, then draft_customer_message (awaiting_approval=false), then write_audit.\n"
        f"Target job_ref: {job_ref}."
    )


# ─── Live LLM Adapter (OpenRouter / Hugging Face unified client) ──────────────

def _call_live_llm(messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
    """Call the configured OpenRouter / Hugging Face chat completions API with tools."""
    from engine.llm_client import call_chat_completion
    return call_chat_completion(
        messages,
        tools=tools,
        tool_choice="auto",
        timeout=float(os.getenv("REBOOKING_AGENT_TIMEOUT_SECONDS") or os.getenv("HF_CHAT_TIMEOUT_SECONDS", "45")),
        max_tokens=int(os.getenv("REBOOKING_AGENT_MAX_TOKENS", "512")),
        temperature=float(os.getenv("OPENROUTER_TEMPERATURE", "0.15")),
    )


# ─── Deterministic Mock LLM (exercises the exact same tool-calling loop) ─────

class MockToolCallingLLM:
    """Deterministic scripted tool-calling brain used when MOCK_LLM=true."""

    def __init__(self, job_ref: str, mode: str, rules: dict[str, Any]):
        self.job_ref = job_ref
        self.mode = mode
        self.rules = rules
        self.call_seq = 0
        self.state: dict[str, Any] = {}

    def _tc(self, name: str, args: dict[str, Any], thought: str = "") -> dict[str, Any]:
        self.call_seq += 1
        return {
            "content": thought,
            "tool_calls": [
                {
                    "id": f"mock_call_{self.call_seq}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)},
                }
            ],
        }

    def next_response(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        tool_results = [m for m in messages if m.get("role") == "tool"]
        if not tool_results:
            return self._tc("get_job", {"job_ref": self.job_ref}, "Detecting job context and SLA.")

        last_msg = tool_results[-1]
        last_name = last_msg.get("name", "")
        last_data = json.loads(last_msg.get("content") or "{}")
        self.state[last_name] = last_data

        if not last_data.get("ok") and last_name == "get_job":
            return {"content": f"Job {self.job_ref} could not be found.", "tool_calls": []}

        if last_name == "get_job":
            return self._tc(
                "check_dependencies_and_d30",
                {"job_ref": self.job_ref},
                "Checking D30 workflow status and third-party dependencies.",
            )

        if last_name == "check_dependencies_and_d30":
            if last_data.get("blocked"):
                self.state["terminal_status"] = "ESCALATED"
                self.state["terminal_decision"] = "Escalated due to blocking D30/dependency"
                self.state["terminal_reason"] = last_data.get("summary", "Blocked by D30/dependency")
                return self._tc(
                    "escalate_to_planner",
                    {
                        "job_ref": self.job_ref,
                        "reason": last_data.get("summary", "Blocked by D30/dependency"),
                        "category": "D30_OR_DEPENDENCY",
                        "nearest_options": [],
                    },
                    "Dependencies or D30 blocked; escalating to planner.",
                )
            return self._tc("check_dno_flow", {"job_ref": self.job_ref}, "Evaluating DNO clearance status.")

        if last_name == "check_dno_flow":
            dno_status = last_data.get("dno_status")
            if dno_status == "BLOCKED":
                self.state["terminal_status"] = "ESCALATED"
                self.state["terminal_decision"] = "Escalated due to DNO_BLOCKED"
                self.state["terminal_reason"] = "DNO workflow is BLOCKED; planner intervention required."
                return self._tc(
                    "escalate_to_planner",
                    {
                        "job_ref": self.job_ref,
                        "reason": self.state["terminal_reason"],
                        "category": "DNO_BLOCKED",
                        "nearest_options": [],
                    },
                    "DNO blocked; escalating.",
                )
            if dno_status == "PENDING":
                job = self.state["get_job"]
                return self._tc(
                    "raise_dno_request",
                    {
                        "job_ref": self.job_ref,
                        "reason": f"DNO clearance required for {job.get('job_type')} ({job.get('reason')})",
                    },
                    "DNO pending; raising simulated DNO clearance request.",
                )
            job = self.state["get_job"]
            horizon = int(self.rules.get("capacity_and_ranking", {}).get("horizon_days", 28))
            start_dt = (date.today() + timedelta(days=1)).isoformat()
            end_dt = (date.today() + timedelta(days=horizon)).isoformat()
            return self._tc(
                "get_capacity",
                {
                    "region_code": job["region_code"],
                    "job_type": job["job_type"],
                    "required_skill": job["required_skill"],
                    "start_date": start_dt,
                    "end_date": end_dt,
                },
                "DNO clear; querying 28-day regional engineer capacity.",
            )

        if last_name == "raise_dno_request":
            job = self.state["get_job"]
            horizon = int(self.rules.get("capacity_and_ranking", {}).get("horizon_days", 28))
            start_dt = last_data.get("earliest_eligible_date") or (date.today() + timedelta(days=7)).isoformat()
            end_dt = (date.today() + timedelta(days=horizon)).isoformat()
            return self._tc(
                "get_capacity",
                {
                    "region_code": job["region_code"],
                    "job_type": job["job_type"],
                    "required_skill": job["required_skill"],
                    "start_date": start_dt,
                    "end_date": end_dt,
                },
                f"DNO request raised ({last_data.get('dno_ref')}); searching capacity from {start_dt}.",
            )

        if last_name == "get_capacity":
            job = self.state["get_job"]
            slot_ids = [s["slot_id"] for s in last_data.get("candidate_slots", [])]
            return self._tc(
                "rank_slots",
                {
                    "job_ref": self.job_ref,
                    "candidate_slot_ids": slot_ids,
                    "preferred_window": job.get("preferred_time_of_day", "Morning"),
                    "sla_due_date": job["sla_due_date"],
                    "avoid_engineer_id": job.get("original_engineer_id") or "",
                    "avoid_supplier": job.get("supplier_name") or "",
                },
                "Ranking candidate slots by SLA, utilisation threshold, skill, preference, and no-access avoidance.",
            )

        if last_name == "rank_slots":
            job = self.state["get_job"]
            if not last_data.get("within_sla_available"):
                nearest = last_data.get("nearest_options", [])
                self.state["terminal_status"] = "ESCALATED"
                self.state["terminal_decision"] = "Escalated with 3 nearest post-SLA options"
                self.state["terminal_reason"] = last_data.get("why", "No compliant slot within SLA")
                return self._tc(
                    "escalate_to_planner",
                    {
                        "job_ref": self.job_ref,
                        "reason": self.state["terminal_reason"],
                        "category": "NO_SLOT_WITHIN_SLA",
                        "nearest_options": nearest,
                    },
                    "No slot within SLA; escalating with nearest alternatives.",
                )

            best = last_data["best_slot"]
            dno_info = self.state.get("raise_dno_request")
            dno_note = (
                f"Following DNO clearance ({dno_info.get('dno_ref')}, {dno_info.get('lead_time_days')}-day lead time), "
                if dno_info
                else None
            )
            if self.mode == "autonomous" and not job.get("is_vulnerable"):
                return self._tc(
                    "rebook_job",
                    {
                        "job_ref": self.job_ref,
                        "slot_id": best["slot_id"],
                        "reason_summary": last_data.get("why", "Best compliant slot"),
                    },
                    "Autonomous mode and non-vulnerable customer: executing rebooking.",
                )

            # Assisted mode or vulnerable customer: cannot auto-rebook
            if job.get("is_vulnerable"):
                self.state["terminal_status"] = "AWAITING_APPROVAL"
                self.state["terminal_decision"] = f"Prepared slot {best['slot_date']} {best['time_window']} (Vulnerable customer — mandatory human approval)"
                self.state["terminal_reason"] = f"PSR / Vulnerable customer ({job.get('vulnerability_reason') or 'flag set'}) requires planner approval."
                return self._tc(
                    "escalate_to_planner",
                    {
                        "job_ref": self.job_ref,
                        "reason": self.state["terminal_reason"],
                        "category": "VULNERABLE_APPROVAL",
                        "nearest_options": [best],
                    },
                    "Vulnerable customer guardrail triggered; flagging for mandatory human approval.",
                )

            self.state["terminal_status"] = "AWAITING_APPROVAL"
            self.state["terminal_decision"] = f"Proposed {best['slot_date']} {best['time_window']} with {best['engineer_id']}"
            self.state["terminal_reason"] = last_data.get("why", "Awaiting planner approval in Assisted mode")
            return self._tc(
                "draft_customer_message",
                {
                    "job_ref": self.job_ref,
                    "channel": job.get("contact_preference", "SMS"),
                    "new_date": best["slot_date"],
                    "new_window": best["time_window"],
                    "awaiting_approval": True,
                    **({"dno_lead_note": dno_note} if dno_note else {}),
                },
                "Assisted mode: drafting customer message preview for planner approval.",
            )

        if last_name == "rebook_job":
            job = self.state["get_job"]
            best = self.state["rank_slots"]["best_slot"]
            dno_info = self.state.get("raise_dno_request")
            dno_note = (
                f"Following DNO clearance ({dno_info.get('dno_ref')}, {dno_info.get('lead_time_days')}-day lead time), "
                if dno_info
                else None
            )
            self.state["terminal_status"] = "REBOOKED"
            self.state["terminal_decision"] = f"Rebooked to {best['slot_date']} {best['time_window']} ({best['engineer_id']})"
            self.state["terminal_reason"] = self.state["rank_slots"].get("why", "Auto-rebooked within SLA")
            return self._tc(
                "draft_customer_message",
                {
                    "job_ref": self.job_ref,
                    "channel": job.get("contact_preference", "SMS"),
                    "new_date": best["slot_date"],
                    "new_window": best["time_window"],
                    "awaiting_approval": False,
                    **({"dno_lead_note": dno_note} if dno_note else {}),
                },
                "Drafting simulated customer confirmation message.",
            )

        if last_name == "escalate_to_planner":
            job = self.state["get_job"]
            if last_data.get("category") == "VULNERABLE_APPROVAL" and "draft_customer_message" not in self.state:
                best = self.state["rank_slots"]["best_slot"]
                return self._tc(
                    "draft_customer_message",
                    {
                        "job_ref": self.job_ref,
                        "channel": job.get("contact_preference", "Phone"),
                        "new_date": best["slot_date"],
                        "new_window": best["time_window"],
                        "awaiting_approval": True,
                    },
                    "Drafting proposed message for vulnerable customer pending human approval.",
                )
            return self._tc(
                "write_audit",
                {
                    "job_ref": self.job_ref,
                    "step_name": "Log",
                    "status": self.state.get("terminal_status", "ESCALATED"),
                    "decision": self.state.get("terminal_decision", "Escalated to planner"),
                    "reasoning_summary": self.state.get("terminal_reason", last_data.get("reason", "Escalated")),
                },
                "Writing final audit record.",
            )

        if last_name == "draft_customer_message":
            return self._tc(
                "write_audit",
                {
                    "job_ref": self.job_ref,
                    "step_name": "Log",
                    "status": self.state.get("terminal_status", "AWAITING_APPROVAL"),
                    "decision": self.state.get("terminal_decision", "Prepared rebook proposal"),
                    "reasoning_summary": self.state.get("terminal_reason", "Completed workflow"),
                },
                "Writing final audit trail.",
            )

        if last_name == "write_audit":
            return {
                "content": self.state.get("terminal_decision", "Completed rebooking workflow."),
                "tool_calls": [],
            }

        return {"content": "Workflow complete.", "tool_calls": []}


# ─── Step Card Builder & Reasoning Summaries ─────────────────────────────────

def _one_line_why(tool_name: str, args: dict[str, Any], result: dict[str, Any], ctx: AgentRunContext) -> str:
    if not result.get("ok"):
        return result.get("error", "Step failed")
    if tool_name == "get_job":
        vuln = " | PSR Vulnerable" if result.get("is_vulnerable") else ""
        return f"{result.get('original_status')} ({result.get('reason')}), {result.get('job_type')} in {result.get('region_code')}, SLA {result.get('sla_due_date')}{vuln}."
    if tool_name == "check_dependencies_and_d30":
        return result.get("summary", "")
    if tool_name == "check_dno_flow":
        st = result.get("dno_status")
        if st == "PENDING":
            return f"DNO involvement required ({result.get('default_lead_time_days')}d default lead time)."
        if st == "BLOCKED":
            return "DNO status is BLOCKED — cannot proceed."
        return f"DNO status is {st}; no delay required."
    if tool_name == "raise_dno_request":
        return f"Simulated DNO request {result.get('dno_ref')} raised; earliest slot {result.get('earliest_eligible_date')}."
    if tool_name == "get_capacity":
        return (
            f"Found {result.get('total_candidate_slots')} open {result.get('required_skill')} slots in "
            f"{result.get('region_code')} ({result.get('search_start')} to {result.get('search_end')})."
        )
    if tool_name == "rank_slots":
        return result.get("why", "Slots ranked.")
    if tool_name == "rebook_job":
        return (
            f"Rebooked to {result.get('rebooked_date')} {result.get('time_window')} "
            f"with {result.get('engineer_id')} (rebook_flag=True)."
        )
    if tool_name == "draft_customer_message":
        return f"Drafted {result.get('channel')} message ({result.get('message_status')})."
    if tool_name == "escalate_to_planner":
        opts = len(result.get("nearest_options") or [])
        extra = f" with {opts} nearest options" if opts else ""
        return f"Escalated ({result.get('category')}){extra}: {result.get('reason')}"
    if tool_name == "write_audit":
        return result.get("decision", "Audit entry logged.")
    return "Step completed."


def _step_status_for(tool_name: str, result: dict[str, Any], ctx: AgentRunContext) -> str:
    if not result.get("ok"):
        return "blocked" if result.get("guardrail_blocked") else "error"
    if tool_name == "check_dependencies_and_d30":
        return "blocked" if result.get("blocked") else "ok"
    if tool_name == "check_dno_flow":
        if result.get("blocked"):
            return "blocked"
        if result.get("dno_status") == "PENDING":
            return "warn"
        return "ok"
    if tool_name == "rank_slots":
        return "ok" if result.get("within_sla_available") else "warn"
    if tool_name == "escalate_to_planner":
        return "awaiting_approval" if result.get("category") == "VULNERABLE_APPROVAL" else "blocked"
    if tool_name == "rebook_job":
        return "completed"
    return "ok"


def _compact_output_for_ui(tool_name: str, result: dict[str, Any]) -> dict[str, Any]:
    """Keep SSE card output crisp without dumping 60 raw slot dicts."""
    if tool_name == "get_capacity" and result.get("ok"):
        return {
            "region_code": result.get("region_code"),
            "search_start": result.get("search_start"),
            "search_end": result.get("search_end"),
            "total_candidate_slots": result.get("total_candidate_slots"),
            "utilisation_threshold_pct": result.get("utilisation_threshold_pct"),
            "sample_slots": (result.get("candidate_slots") or [])[:3],
        }
    if tool_name == "rank_slots" and result.get("ok"):
        return {
            "within_sla_available": result.get("within_sla_available"),
            "best_slot": result.get("best_slot"),
            "skipped_high_utilisation_dates": result.get("skipped_high_utilisation_dates"),
            "nearest_options_count": len(result.get("nearest_options") or []),
            "nearest_options": (result.get("nearest_options") or [])[:3],
        }
    return {k: v for k, v in result.items() if k not in ("candidate_slots", "ok") or (k == "ok" and not v)}


# ─── Main Streaming Runner ───────────────────────────────────────────────────

def stream_rebooking_agent(
    job_ref: str,
    mode: str = "assisted",
    mock_llm: bool | None = None,
    db_path: Path | None = None,
    step_delay_s: float = 0.0,
) -> Generator[dict[str, Any], None, None]:
    """
    Execute the Rebooking Agent tool-calling loop and yield structured SSE events.
    """
    mode = "autonomous" if str(mode).lower() == "autonomous" else "assisted"
    use_mock = is_mock_llm_enabled(mock_llm)
    rules = load_rules()
    max_steps = int(rules.get("agent", {}).get("max_steps", 15))
    run_id = f"RUN-{uuid.uuid4().hex[:8].upper()}"
    start_ts = time.perf_counter()

    job = get_job_record(job_ref, db_path=db_path)
    if not job:
        yield {
            "event": "error",
            "data": {"job_ref": job_ref, "error": f"Job '{job_ref}' was not found."},
        }
        return

    ctx = AgentRunContext(run_id=run_id, job_ref=job_ref, mode=mode, db_path=db_path)
    timeline_by_step: dict[str, dict[str, Any]] = {
        step: {"step": step, "status": "pending", "inputs": {}, "outputs": {}, "why": "Pending"}
        for step in CANONICAL_STEPS
    }

    yield {
        "event": "run_started",
        "data": {
            "run_id": run_id,
            "job_ref": job_ref,
            "mode": mode,
            "mock_llm": use_mock,
            "timeline": [timeline_by_step[s] for s in CANONICAL_STEPS],
        },
    }

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": _system_prompt(mode, job_ref, rules)},
        {
            "role": "user",
            "content": (
                f"Process cancelled/aborted job '{job_ref}' in '{mode}' mode. "
                "Follow all rules, validate dependencies/D30 and DNO, rank capacity, and complete the audit log."
            ),
        },
    ]

    mock_driver = MockToolCallingLLM(job_ref, mode, rules) if use_mock else None
    final_assistant_text = ""

    try:
        for turn in range(max_steps):
            if use_mock and mock_driver is not None:
                llm_resp = mock_driver.next_response(messages)
            else:
                llm_resp = _call_live_llm(messages, TOOL_SCHEMAS)

            tool_calls = llm_resp.get("tool_calls") or []
            if not tool_calls:
                final_assistant_text = llm_resp.get("content") or "Completed."
                break

            messages.append({
                "role": "assistant",
                "content": llm_resp.get("content") or "",
                "tool_calls": tool_calls,
            })

            for tc in tool_calls:
                fn = tc.get("function") or {}
                tool_name = fn.get("name", "")
                raw_args = fn.get("arguments") or "{}"
                step_name = TOOL_TO_STEP.get(tool_name, "Log")

                yield {
                    "event": "step_started",
                    "data": {"run_id": run_id, "job_ref": job_ref, "step": step_name, "tool": tool_name},
                }

                try:
                    parsed_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                except json.JSONDecodeError as exc:
                    result = {
                        "ok": False,
                        "validation_error": True,
                        "error": f"Malformed JSON arguments for '{tool_name}': {exc}",
                    }
                    parsed_args = {"raw_arguments": str(raw_args)[:200]}
                else:
                    result = execute_tool(ctx, tool_name, parsed_args)

                why = _one_line_why(tool_name, parsed_args if isinstance(parsed_args, dict) else {}, result, ctx)
                step_status = _step_status_for(tool_name, result, ctx)
                compact_out = _compact_output_for_ui(tool_name, result)

                # Record every tool call into the audit table for full traceability
                if tool_name != "write_audit":
                    append_audit_entry(
                        run_id=run_id,
                        job_ref=job_ref,
                        region_code=job["region_code"],
                        mode=mode,
                        step_name=step_name,
                        tool_name=tool_name,
                        status=step_status.upper(),
                        input_data=parsed_args,
                        output_data=compact_out,
                        decision=why,
                        reasoning_summary=why,
                        db_path=db_path,
                    )

                rank_candidates = parsed_args.get("candidate_slot_ids") or []
                card = {
                    "step": step_name,
                    "tool": tool_name,
                    "status": step_status,
                    "inputs": parsed_args if tool_name != "rank_slots" else {
                        "job_ref": parsed_args.get("job_ref"),
                        "candidate_count": len(rank_candidates) if rank_candidates else len(ctx.candidate_slots_by_id),
                        "preferred_window": parsed_args.get("preferred_window"),
                        "sla_due_date": parsed_args.get("sla_due_date"),
                    },
                    "outputs": compact_out,
                    "why": why,
                }
                timeline_by_step[step_name] = card

                yield {"event": "tool_call", "data": {"step": step_name, "tool": tool_name, "args": card["inputs"]}}
                yield {"event": "step_completed", "data": card}

                llm_tool_payload = compact_out if tool_name == "get_capacity" else result
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id") or f"tc_{turn}",
                    "name": tool_name,
                    "content": json.dumps(llm_tool_payload, default=str),
                })

                if step_delay_s > 0:
                    time.sleep(step_delay_s)

        # Ensure consistent terminal state if Assisted / Vulnerable / Escalated
        duration_ms = max(int((time.perf_counter() - start_ts) * 1000), 1)
        refreshed = get_job_record(job_ref, db_path=db_path) or job

        if ctx.escalation:
            outcome = "AWAITING_APPROVAL" if ctx.escalation.get("category") == "VULNERABLE_APPROVAL" else "ESCALATED"
        elif ctx.rebooked_slot:
            outcome = "REBOOKED"
        elif ctx.proposed_slot:
            outcome = "AWAITING_APPROVAL"
            timeline_by_step["Rebook"] = {
                "step": "Rebook",
                "tool": "rebook_job",
                "status": "awaiting_approval",
                "inputs": {"slot_id": ctx.proposed_slot["slot_id"], "mode": mode},
                "outputs": {
                    "proposed_slot": ctx.proposed_slot,
                    "requires_human_approval": True,
                },
                "why": (
                    "Vulnerable / PSR customer — human approval required."
                    if refreshed.get("is_vulnerable")
                    else "Assisted mode — slot prepared; click 'Approve & Execute' to confirm."
                ),
            }
            yield {"event": "step_completed", "data": timeline_by_step["Rebook"]}
        else:
            outcome = refreshed.get("agent_outcome") or "ESCALATED"

        # Mark remaining untouched steps cleanly as skipped so the 8-step timeline is crystal clear
        for step_name in CANONICAL_STEPS:
            if timeline_by_step[step_name]["status"] == "pending":
                reason_skip = (
                    "Skipped — workflow stopped at earlier blocking/escalation step."
                    if outcome == "ESCALATED"
                    else "Skipped — awaiting human approval."
                )
                timeline_by_step[step_name] = {
                    "step": step_name,
                    "tool": None,
                    "status": "skipped",
                    "inputs": {},
                    "outputs": {},
                    "why": reason_skip,
                }
                yield {"event": "step_completed", "data": timeline_by_step[step_name]}

        timeline_list = [timeline_by_step[s] for s in CANONICAL_STEPS]
        sla_due = (refreshed.get("sla_due_date") or "")[:10]
        chosen = ctx.rebooked_slot or ctx.proposed_slot
        sla_safe = 1
        if outcome == "ESCALATED" and ctx.escalation and ctx.escalation.get("category") == "NO_SLOT_WITHIN_SLA":
            sla_safe = 0
        elif chosen and sla_due and chosen.get("slot_date", "") > sla_due:
            sla_safe = 0

        status_map = {
            "REBOOKED": "Rebooked",
            "AWAITING_APPROVAL": "Awaiting Approval",
            "ESCALATED": "Escalated",
        }
        updated_job = update_job_fields(
            job_ref,
            {
                "status": status_map.get(outcome, refreshed.get("status")),
                "agent_outcome": outcome,
                "agent_mode": mode,
                "agent_duration_ms": duration_ms,
                "sla_safe": sla_safe,
                "proposed_slot_json": json.dumps(ctx.proposed_slot or {}),
                "last_reasoning_json": json.dumps(timeline_list),
            },
            db_path=db_path,
        )

        daily_util = get_region_daily_utilisation(job["region_code"], db_path=db_path)

        yield {
            "event": "run_completed",
            "data": {
                "run_id": run_id,
                "job_ref": job_ref,
                "mode": mode,
                "mock_llm": use_mock,
                "outcome": outcome,
                "duration_ms": duration_ms,
                "job": updated_job,
                "timeline": timeline_list,
                "chosen_slot": chosen,
                "message_preview": ctx.message_preview,
                "escalation": ctx.escalation,
                "daily_utilisation": daily_util,
                "summary": final_assistant_text or outcome,
            },
        }
    except (TimeoutError, RuntimeError) as exc:
        append_audit_entry(
            run_id=run_id,
            job_ref=job_ref,
            region_code=job["region_code"],
            mode=mode,
            step_name="Agent",
            tool_name="llm_client",
            status="ERROR",
            input_data={"mode": mode, "mock_llm": use_mock},
            output_data={"error": str(exc)},
            decision="LLM error / timeout",
            reasoning_summary=str(exc),
            db_path=db_path,
        )
        yield {
            "event": "error",
            "data": {
                "run_id": run_id,
                "job_ref": job_ref,
                "error": str(exc),
                "friendly_message": (
                    f"The AI model could not complete this run ({exc}). "
                    "You can switch to 'Mock LLM (Demo)' mode in the toolbar to run deterministically."
                ),
            },
        }


def run_rebooking_agent(
    job_ref: str,
    mode: str = "assisted",
    mock_llm: bool | None = None,
    db_path: Path | None = None,
) -> dict[str, Any]:
    """Synchronous wrapper returning the final run_completed or error payload."""
    final_payload: dict[str, Any] = {}
    for evt in stream_rebooking_agent(job_ref, mode=mode, mock_llm=mock_llm, db_path=db_path):
        if evt["event"] == "run_completed":
            final_payload = evt["data"]
        elif evt["event"] == "error":
            final_payload = {"error": evt["data"].get("error"), **evt["data"]}
    return final_payload


# ─── Human-in-the-loop Actions (Assisted Mode / Vulnerable Approval) ─────────

def approve_and_execute_rebooking(
    job_ref: str,
    edited_message: str | None = None,
    slot_id_override: str | None = None,
    db_path: Path | None = None,
) -> dict[str, Any]:
    """Approve a prepared or escalated proposal and execute rebook_job with human_approved=True."""
    job = get_job_record(job_ref, db_path=db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    proposed = job.get("proposed_slot") or {}
    slot_id = slot_id_override or proposed.get("slot_id")
    if not slot_id:
        return {"ok": False, "error": f"No proposed slot found for '{job_ref}'."}

    slot = get_slot_by_id(slot_id, db_path=db_path)
    if not slot:
        return {"ok": False, "error": f"Slot '{slot_id}' does not exist."}

    run_id = f"APR-{uuid.uuid4().hex[:8].upper()}"
    ctx = AgentRunContext(
        run_id=run_id,
        job_ref=job_ref,
        mode=job.get("agent_mode") or "assisted",
        human_approved=True,
        db_path=db_path,
        candidate_slots_by_id={slot_id: slot},
        dependencies_clear=True,
        dno_blocked=False,
        dno_earliest_date=job.get("dno_earliest_date") or None,
    )

    rebook_res = rebook_job(
        ctx,
        job_ref=job_ref,
        slot_id=slot_id,
        reason_summary="Human planner approved & executed proposed slot.",
    )
    if not rebook_res.get("ok"):
        return rebook_res

    rules = load_rules()
    disclaimer = rules.get("agent", {}).get("simulated_message_disclaimer", "Simulated send")
    channel = job.get("customer_message_channel") or job.get("contact_preference") or "SMS"

    if edited_message and edited_message.strip():
        update_job_fields(
            job_ref,
            {
                "customer_message": edited_message.strip(),
                "customer_message_channel": channel,
                "message_status": disclaimer,
            },
            db_path=db_path,
        )
        msg_res = {
            "ok": True,
            "job_ref": job_ref,
            "channel": channel,
            "message": edited_message.strip(),
            "simulated_send": True,
            "send_label": disclaimer,
            "message_status": disclaimer,
        }
    else:
        msg_res = draft_customer_message(
            ctx,
            job_ref=job_ref,
            channel=channel,
            new_date=slot["slot_date"],
            new_window=slot["time_window"],
            awaiting_approval=False,
        )

    # Resolve any open approval/SLA escalation for this job
    for esc in list_escalations(status="OPEN", db_path=db_path):
        if esc["job_ref"] == job_ref:
            resolve_escalation(esc["escalation_id"], f"Approved & rebooked to {slot_id}", db_path=db_path)

    # Update timeline cards cleanly
    timeline = job.get("last_reasoning") or []
    updated_timeline = []
    for card in timeline:
        if card.get("step") == "Rebook":
            updated_timeline.append({
                "step": "Rebook",
                "tool": "rebook_job",
                "status": "completed",
                "inputs": {"slot_id": slot_id, "human_approved": True},
                "outputs": rebook_res,
                "why": f"Planner approved and executed booking on {slot['slot_date']} {slot['time_window']} ({slot['engineer_id']}).",
            })
        elif card.get("step") == "Message":
            updated_timeline.append({
                "step": "Message",
                "tool": "draft_customer_message",
                "status": "ok",
                "inputs": {"channel": channel},
                "outputs": msg_res,
                "why": f"Customer notification marked '{disclaimer}'.",
            })
        else:
            updated_timeline.append(card)

    write_audit(
        ctx,
        job_ref=job_ref,
        step_name="Approve",
        status="REBOOKED",
        decision=f"Human approved rebooking to {slot['slot_date']} {slot['time_window']} ({slot['engineer_id']})",
        reasoning_summary="Planner clicked Approve & Execute; simulated customer message confirmed.",
        tool_name="approve_and_execute_rebooking",
        input_data={"slot_id": slot_id, "edited_message": bool(edited_message)},
        output_data=rebook_res,
    )

    final_job = update_job_fields(
        job_ref,
        {"last_reasoning_json": json.dumps(updated_timeline)},
        db_path=db_path,
    )
    return {
        "ok": True,
        "job": final_job,
        "rebook": rebook_res,
        "message_preview": msg_res,
        "timeline": updated_timeline,
    }


def reject_rebooking_proposal(
    job_ref: str,
    reason: str = "Rejected by planner",
    db_path: Path | None = None,
) -> dict[str, Any]:
    """Reject a proposed rebooking and move it to the planner escalation queue."""
    job = get_job_record(job_ref, db_path=db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    run_id = f"REJ-{uuid.uuid4().hex[:8].upper()}"
    ctx = AgentRunContext(run_id=run_id, job_ref=job_ref, mode=job.get("agent_mode") or "assisted", db_path=db_path)
    esc = escalate_to_planner(
        ctx,
        job_ref=job_ref,
        reason=reason,
        category="POLICY_EXCEPTION",
        nearest_options=[job["proposed_slot"]] if job.get("proposed_slot") else [],
    )
    write_audit(
        ctx,
        job_ref=job_ref,
        step_name="Reject",
        status="ESCALATED",
        decision="Proposal rejected by planner",
        reasoning_summary=reason,
        tool_name="reject_rebooking_proposal",
        input_data={"reason": reason},
        output_data=esc,
    )
    return {"ok": True, "job": get_job_record(job_ref, db_path=db_path), "escalation": esc}
