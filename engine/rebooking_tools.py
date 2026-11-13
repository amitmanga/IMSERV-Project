"""
Plain Python tool functions, OpenAI-compatible JSON schemas, argument validation,
and execution guardrails for the Rebooking Agent.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

from engine.rebooking_store import (
    append_audit_entry,
    get_job_record,
    get_region_daily_utilisation,
    get_slot_by_id,
    insert_dno_request,
    query_slots,
    reserve_slot,
    update_job_fields,
    upsert_escalation,
)
from engine.rules_loader import (
    evaluate_dependencies_and_d36,
    evaluate_dependencies_and_d30,
    evaluate_dno_flow,
    load_rules,
    required_skill_for_job,
)


@dataclass
class AgentRunContext:
    """Mutable per-run guardrail state shared across tool invocations."""
    run_id: str
    job_ref: str
    mode: str = "assisted"  # "assisted" | "autonomous"
    human_approved: bool = False
    db_path: Path | None = None
    candidate_slots_by_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    ranked_result: dict[str, Any] | None = None
    dno_earliest_date: str | None = None
    dependencies_clear: bool | None = None
    dno_blocked: bool = False
    rebooked_slot: dict[str, Any] | None = None
    proposed_slot: dict[str, Any] | None = None
    message_preview: dict[str, Any] | None = None
    escalation: dict[str, Any] | None = None
    audit_entries: list[dict[str, Any]] = field(default_factory=list)


# ─── JSON Schemas (OpenAI / Hugging Face tool-calling format) ────────────────

TOOL_SPEC_DEFS: dict[str, dict[str, Any]] = {
    "get_job": {
        "description": (
            "Step 1 (Detect): Fetch full job details including cancellation/abort reason, "
            "job type, meter type, required skill, region, supplier, customer contact preference, "
            "preferred time of day, SLA due date, and vulnerability flag."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
            },
            "required": ["job_ref"],
            "additionalProperties": False,
        },
    },
    "check_dependencies_and_d36": {
        "description": (
            "Step 2 (Dependencies / D36): Evaluate third-party dependency flags and D36 workflow "
            "status against config/rules.yaml. Returns whether the job is clear or blocked."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
            },
            "required": ["job_ref"],
            "additionalProperties": False,
        },
    },
    "check_dependencies_and_d30": {
        "description": (
            "Step 2 (Dependencies / D36): Evaluate third-party dependency flags and D36 workflow "
            "status against config/rules.yaml. Returns whether the job is clear or blocked."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
            },
            "required": ["job_ref"],
            "additionalProperties": False,
        },
    },
    "check_dno_flow": {
        "description": (
            "Step 3 (DNO Flow): Determine whether the job requires DNO involvement and return "
            "status: NOT_REQUIRED, COMPLETE, PENDING, or BLOCKED."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
            },
            "required": ["job_ref"],
            "additionalProperties": False,
        },
    },
    "raise_dno_request": {
        "description": (
            "Step 3b (Simulated DNO Request): Raise a simulated DNO clearance request when DNO "
            "status is PENDING and calculate the earliest eligible booking date after DNO lead time."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
                "reason": {"type": "string", "description": "Operational reason for DNO request."},
                "lead_time_days": {
                    "type": "integer",
                    "description": "Optional lead time override in days; defaults to rules.yaml value.",
                },
            },
            "required": ["job_ref", "reason"],
            "additionalProperties": False,
        },
    },
    "get_capacity": {
        "description": (
            "Step 4 (Capacity): Query available engineer appointment slots and regional daily "
            "utilisation for up to the next 28 days matching region, job type, and skill."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "region_code": {"type": "string", "description": "UK region code (e.g., NW, SE, NE, WAL)."},
                "job_type": {"type": "string", "description": "Job type (NEW_INSTALL, EXCHANGE, REPAIR, REMOVAL)."},
                "required_skill": {"type": "string", "description": "Engineer skill code."},
                "start_date": {"type": "string", "description": "Earliest search date in YYYY-MM-DD format."},
                "end_date": {"type": "string", "description": "Latest search date in YYYY-MM-DD format."},
            },
            "required": ["region_code", "job_type", "required_skill", "start_date", "end_date"],
            "additionalProperties": False,
        },
    },
    "rank_slots": {
        "description": (
            "Step 5 (Decide): Rank candidate slots returned by get_capacity using explainable rules: "
            "within SLA, regional utilisation below threshold (default 90%), matching skill, preferred "
            "time of day, and avoiding the engineer/supplier behind a no-access abort where possible. "
            "Returns the best slot or the 3 nearest alternatives if none fit within SLA."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
                "candidate_slot_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of slot_ids from get_capacity; omit to rank all loaded candidate slots.",
                },
                "preferred_window": {
                    "type": "string",
                    "enum": ["Morning", "Afternoon", "Evening"],
                    "description": "Customer preferred time of day.",
                },
                "sla_due_date": {"type": "string", "description": "SLA due date in YYYY-MM-DD format."},
                "avoid_engineer_id": {"type": "string", "description": "Previous engineer ID to avoid for no-access aborts."},
                "avoid_supplier": {"type": "string", "description": "Previous supplier to deprioritise on no-access aborts."},
            },
            "required": ["job_ref", "sla_due_date"],
            "additionalProperties": False,
        },
    },
    "rebook_job": {
        "description": (
            "Step 6 (Rebook): Execute the rebooking using a valid slot_id returned by get_capacity, "
            "set the rebook flag, and update job status. Guardrail: blocked in Assisted mode or for "
            "vulnerable customers until a human planner approves."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
                "slot_id": {"type": "string", "description": "Exact slot_id returned by get_capacity."},
                "reason_summary": {"type": "string", "description": "One-line justification for choosing this slot."},
            },
            "required": ["job_ref", "slot_id", "reason_summary"],
            "additionalProperties": False,
        },
    },
    "draft_customer_message": {
        "description": (
            "Step 7 (Message Customer): Draft a polite customer notification with the new date/time "
            "window and rescheduling instructions. Always marked 'Simulated send' and never sent externally."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
                "channel": {"type": "string", "description": "Customer contact channel (SMS, Phone, Email, App, Web)."},
                "new_date": {"type": "string", "description": "Proposed or booked appointment date (YYYY-MM-DD)."},
                "new_window": {"type": "string", "description": "Appointment time window (Morning, Afternoon, Evening)."},
                "awaiting_approval": {
                    "type": "boolean",
                    "description": "True when awaiting human planner approval before execution.",
                },
                "dno_lead_note": {
                    "type": "string",
                    "description": "Optional note explaining DNO lead-time clearance.",
                },
            },
            "required": ["job_ref", "channel", "new_date", "new_window"],
            "additionalProperties": False,
        },
    },
    "escalate_to_planner": {
        "description": (
            "Escalate a blocked, non-SLA-compliant, or policy-restricted job to the planner queue "
            "with explicit blocking reason and up to 3 nearest alternative slot options."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
                "reason": {"type": "string", "description": "Clear explanation of why the job is escalated."},
                "category": {
                    "type": "string",
                    "enum": ["D36_OR_DEPENDENCY", "D30_OR_DEPENDENCY", "DNO_BLOCKED", "NO_SLOT_WITHIN_SLA", "VULNERABLE_APPROVAL", "POLICY_EXCEPTION"],
                    "description": "Escalation category.",
                },
                "nearest_options": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Up to 3 nearest alternative slots when escalating capacity/SLA issues.",
                },
            },
            "required": ["job_ref", "reason", "category"],
            "additionalProperties": False,
        },
    },
    "write_audit": {
        "description": (
            "Step 8 (Log): Write a structured audit entry recording the step, decision, and "
            "concise reasoning summary."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "job_ref": {"type": "string", "description": "Unique job reference identifier."},
                "step_name": {"type": "string", "description": "Timeline step name (e.g., Detect, Log)."},
                "status": {"type": "string", "description": "Outcome status (REBOOKED, ESCALATED, AWAITING_APPROVAL, etc.)."},
                "decision": {"type": "string", "description": "Final decision taken for the job."},
                "reasoning_summary": {"type": "string", "description": "Concise explanation of the decision path."},
            },
            "required": ["job_ref", "step_name", "status", "decision", "reasoning_summary"],
            "additionalProperties": False,
        },
    },
}

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": name,
            "description": spec["description"],
            "parameters": spec["parameters"],
        },
    }
    for name, spec in TOOL_SPEC_DEFS.items()
]


# ─── Argument Validation ─────────────────────────────────────────────────────

def _matches_type(val: Any, expected_type: str) -> bool:
    if expected_type == "string":
        return isinstance(val, str)
    if expected_type == "integer":
        return isinstance(val, int) and not isinstance(val, bool)
    if expected_type == "number":
        return isinstance(val, (int, float)) and not isinstance(val, bool)
    if expected_type == "boolean":
        return isinstance(val, bool)
    if expected_type == "array":
        return isinstance(val, list)
    if expected_type == "object":
        return isinstance(val, dict)
    return True


def validate_tool_args(tool_name: str, args: Any) -> tuple[bool, str | None]:
    """Validate tool arguments strictly against TOOL_SPEC_DEFS JSON Schema."""
    spec = TOOL_SPEC_DEFS.get(tool_name)
    if not spec:
        return False, f"Unknown tool '{tool_name}'."

    if not isinstance(args, dict):
        return False, f"Arguments for '{tool_name}' must be a JSON object."

    schema = spec["parameters"]
    props = schema.get("properties", {})
    required = schema.get("required", [])

    for req in required:
        if req not in args or args[req] is None:
            return False, f"Missing required argument '{req}' for '{tool_name}'."
        if props.get(req, {}).get("type") == "string" and not str(args[req]).strip():
            return False, f"Required string argument '{req}' for '{tool_name}' cannot be empty."

    if schema.get("additionalProperties") is False:
        unknown = [k for k in args if k not in props]
        if unknown:
            return False, f"Unexpected argument(s) {unknown} for '{tool_name}'."

    for key, val in args.items():
        if key not in props or val is None:
            continue
        pspec = props[key]
        expected_type = pspec.get("type")
        if expected_type and not _matches_type(val, expected_type):
            return False, f"Argument '{key}' for '{tool_name}' must be of type {expected_type}."
        if "enum" in pspec and val not in pspec["enum"]:
            return False, f"Argument '{key}' for '{tool_name}' must be one of {pspec['enum']}."
        if expected_type == "array" and "items" in pspec:
            item_type = pspec["items"].get("type")
            if item_type and any(not _matches_type(item, item_type) for item in val):
                return False, f"All elements of '{key}' for '{tool_name}' must be of type {item_type}."
        if key.endswith("_date") and isinstance(val, str):
            try:
                date.fromisoformat(val[:10])
            except ValueError:
                return False, f"Argument '{key}' ('{val}') must be a valid YYYY-MM-DD date."

    return True, None


# ─── Tool Implementations ────────────────────────────────────────────────────

def get_job(ctx: AgentRunContext, job_ref: str) -> dict[str, Any]:
    """Read job details, reason, SLA, contact preference, and vulnerability status."""
    job = get_job_record(job_ref, db_path=ctx.db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found in rebooking queue."}

    reason = job.get("cancellation_reason") or job.get("abort_reason") or "Unspecified"
    skill = job.get("required_skill") or required_skill_for_job(job.get("job_type", ""), job.get("meter_type", ""))
    return {
        "ok": True,
        "job_ref": job["job_ref"],
        "scenario_tag": job.get("scenario_tag"),
        "status": job.get("status"),
        "original_status": job.get("original_status"),
        "reason": reason,
        "job_type": job.get("job_type"),
        "meter_type": job.get("meter_type"),
        "required_skill": skill,
        "region_code": job.get("region_code"),
        "region_name": job.get("region_name"),
        "patch_code": job.get("patch_code"),
        "supplier_name": job.get("supplier_name"),
        "original_engineer_id": job.get("original_engineer_id") or "",
        "customer_alias": job.get("customer_alias"),
        "contact_preference": job.get("contact_preference"),
        "preferred_time_of_day": job.get("preferred_time_of_day") or "Morning",
        "sla_due_date": job.get("sla_due_date"),
        "d36_status": job.get("d36_status") or job.get("d30_status"),
        "d30_status": job.get("d36_status") or job.get("d30_status"),
        "dependency_flags": job.get("dependency_flags"),
        "dno_status": job.get("dno_status"),
        "is_vulnerable": bool(job.get("is_vulnerable")),
        "vulnerability_reason": job.get("vulnerability_reason") or "",
    }


def check_dependencies_and_d36(ctx: AgentRunContext, job_ref: str) -> dict[str, Any]:
    """Check third-party dependencies and D36 workflow status using config/rules.yaml."""
    job = get_job_record(job_ref, db_path=ctx.db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    rules = load_rules()
    status = job.get("d36_status") or job.get("d30_status", "CLEAR")
    result = evaluate_dependencies_and_d36(status, job.get("dependency_flags", "NONE"), rules)
    ctx.dependencies_clear = result["clear"]
    return {"ok": True, "job_ref": job_ref, **result}


check_dependencies_and_d30 = check_dependencies_and_d36


def check_dno_flow(ctx: AgentRunContext, job_ref: str) -> dict[str, Any]:
    """Evaluate DNO involvement and current status: NOT_REQUIRED, COMPLETE, PENDING, or BLOCKED."""
    job = get_job_record(job_ref, db_path=ctx.db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    rules = load_rules()
    reason = job.get("cancellation_reason") or job.get("abort_reason") or ""
    result = evaluate_dno_flow(job.get("job_type", ""), reason, job.get("dno_status"), rules)
    ctx.dno_blocked = result["blocked"]
    if result["dno_status"] == "PENDING_REQUESTED" and job.get("dno_earliest_date"):
        ctx.dno_earliest_date = job["dno_earliest_date"]
        result["dno_earliest_date"] = job["dno_earliest_date"]
        result["dno_ref"] = job.get("dno_ref", "")
    elif result["dno_status"] in {"COMPLETE", "NOT_REQUIRED"}:
        ctx.dno_earliest_date = (date.today() + timedelta(days=1)).isoformat()
    return {"ok": True, "job_ref": job_ref, **result}


def raise_dno_request(
    ctx: AgentRunContext,
    job_ref: str,
    reason: str,
    lead_time_days: int | None = None,
) -> dict[str, Any]:
    """Raise a simulated DNO clearance request and return earliest eligible slot date."""
    job = get_job_record(job_ref, db_path=ctx.db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    rules = load_rules()
    days = int(lead_time_days if lead_time_days is not None else rules.get("dno", {}).get("default_lead_time_days", 7))
    earliest = (date.today() + timedelta(days=days)).isoformat()
    dno_ref = f"DNO-SIM-{job_ref.split('-')[-1]}-{uuid.uuid4().hex[:4].upper()}"

    record = insert_dno_request(
        dno_ref=dno_ref,
        job_ref=job_ref,
        region_code=job["region_code"],
        job_type=job["job_type"],
        reason=reason,
        lead_time_days=days,
        earliest_eligible_date=earliest,
        db_path=ctx.db_path,
    )
    update_job_fields(
        job_ref,
        {"dno_ref": dno_ref, "dno_earliest_date": earliest, "dno_status": "PENDING_REQUESTED"},
        db_path=ctx.db_path,
    )
    ctx.dno_earliest_date = earliest
    return {"ok": True, "simulated": True, **record}


def get_capacity(
    ctx: AgentRunContext,
    region_code: str,
    job_type: str,
    required_skill: str,
    start_date: str,
    end_date: str,
) -> dict[str, Any]:
    """Query candidate slots and daily regional utilisation over the search window."""
    rules = load_rules()
    horizon_days = int(rules.get("capacity_and_ranking", {}).get("horizon_days", 28))
    max_end = (date.today() + timedelta(days=horizon_days)).isoformat()
    bounded_end = min(end_date[:10], max_end)
    bounded_start = max(start_date[:10], (date.today() + timedelta(days=1)).isoformat())

    slots = query_slots(
        region_code=region_code,
        start_date=bounded_start,
        end_date=bounded_end,
        required_skill=required_skill,
        only_available=True,
        db_path=ctx.db_path,
    )
    for s in slots:
        ctx.candidate_slots_by_id[s["slot_id"]] = s

    daily_util = get_region_daily_utilisation(region_code, db_path=ctx.db_path)
    threshold = float(rules.get("capacity_and_ranking", {}).get("utilisation_threshold_pct", 90.0))

    # Provide compact summary so LLM context stays lean while keeping exact slot_ids
    compact_slots = [
        {
            "slot_id": s["slot_id"],
            "slot_date": s["slot_date"],
            "day_of_week": s["day_of_week"],
            "time_window": s["time_window"],
            "engineer_id": s["engineer_id"],
            "engineer_name": s.get("engineer_name") or s["engineer_id"],
            "supplier_affiliation": s["supplier_affiliation"],
            "regional_utilisation_pct": s["regional_utilisation_pct"],
        }
        for s in slots[:60]
    ]

    return {
        "ok": True,
        "region_code": region_code,
        "job_type": job_type,
        "required_skill": required_skill,
        "search_start": bounded_start,
        "search_end": bounded_end,
        "utilisation_threshold_pct": threshold,
        "total_candidate_slots": len(slots),
        "candidate_slots": compact_slots,
        "daily_utilisation": daily_util,
    }


def rank_slots(
    ctx: AgentRunContext,
    job_ref: str,
    sla_due_date: str,
    candidate_slot_ids: list[str] | None = None,
    preferred_window: str | None = None,
    avoid_engineer_id: str | None = None,
    avoid_supplier: str | None = None,
) -> dict[str, Any]:
    """
    Rank candidate slots returned by get_capacity using explainable deterministic rules:
    1. Must be within SLA (slot_date <= sla_due_date)
    2. Regional utilisation must be <= threshold (default 90%)
    3. Preferred time of day (Morning/Afternoon/Evening)
    4. Avoid previous engineer/supplier for no-access aborts where possible
    5. Earliest date, then lowest regional utilisation
    If no slot fits within SLA + threshold, returns up to 3 nearest compliant post-SLA options.
    """
    if not ctx.candidate_slots_by_id:
        return {
            "ok": False,
            "error": "Guardrail violation: get_capacity must be called before rank_slots.",
        }

    ids_to_check = candidate_slot_ids or []
    unknown_ids = [sid for sid in ids_to_check if sid not in ctx.candidate_slots_by_id]
    if unknown_ids:
        return {
            "ok": False,
            "error": f"Guardrail violation: slot_id(s) {unknown_ids[:3]} were not returned by get_capacity.",
        }

    job = get_job_record(job_ref, db_path=ctx.db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    rules = load_rules()
    cap_cfg = rules.get("capacity_and_ranking", {})
    threshold = float(cap_cfg.get("utilisation_threshold_pct", 90.0))
    no_access_reasons = {r.strip().lower() for r in cap_cfg.get("no_access_reasons", [])}
    nearest_count = int(cap_cfg.get("nearest_options_count", 3))

    reason_norm = (job.get("cancellation_reason") or job.get("abort_reason") or "").strip().lower()
    is_no_access = reason_norm in no_access_reasons
    pref = preferred_window or job.get("preferred_time_of_day") or "Morning"
    avoid_eng = avoid_engineer_id or (job.get("original_engineer_id") if is_no_access else "")
    avoid_sup = avoid_supplier or (job.get("supplier_name") if is_no_access else "")

    pool = [ctx.candidate_slots_by_id[sid] for sid in candidate_slot_ids] if candidate_slot_ids else list(ctx.candidate_slots_by_id.values())

    # Filter out slots above utilisation threshold first, track skipped high-util dates
    skipped_high_util_dates = sorted({
        s["slot_date"] for s in pool if float(s["regional_utilisation_pct"]) > threshold
    })
    below_threshold = [s for s in pool if float(s["regional_utilisation_pct"]) <= threshold]
    within_sla = [s for s in below_threshold if s["slot_date"] <= sla_due_date[:10]]

    def score_key(slot: dict[str, Any]) -> tuple:
        same_eng_penalty = 1 if (is_no_access and avoid_eng and slot["engineer_id"] == avoid_eng) else 0
        same_sup_penalty = 1 if (is_no_access and avoid_sup and slot["supplier_affiliation"] == avoid_sup) else 0
        window_penalty = 0 if slot["time_window"] == pref else 1
        return (
            slot["slot_date"],
            window_penalty,
            same_eng_penalty,
            same_sup_penalty,
            float(slot["regional_utilisation_pct"]),
            slot["engineer_id"],
        )

    ranked_within_sla = sorted(within_sla, key=score_key)
    ranked_outside_sla = sorted([s for s in below_threshold if s["slot_date"] > sla_due_date[:10]], key=score_key)

    if ranked_within_sla:
        best = dict(ranked_within_sla[0])
        notes = [f"Within SLA (<= {sla_due_date[:10]})", f"Capacity utilisation {best['regional_utilisation_pct']}% (within {threshold:.0f}% threshold)"]
        if best["time_window"] == pref:
            notes.append(f"Matches customer preference ({pref})")
        if skipped_high_util_dates:
            notes.append(f"Skipped high-utilisation dates (> {threshold:.0f}%): {', '.join(skipped_high_util_dates[:3])}")
        if is_no_access and avoid_eng and best["engineer_id"] != avoid_eng:
            eng_label = best.get("engineer_name") or avoid_eng
            notes.append(f"Avoided previous engineer ({eng_label})")
        best["selection_rationale"] = "; ".join(notes)
        ctx.proposed_slot = best
        result = {
            "ok": True,
            "within_sla_available": True,
            "best_slot": best,
            "nearest_options": ranked_within_sla[:nearest_count],
            "skipped_high_utilisation_dates": skipped_high_util_dates,
            "why": best["selection_rationale"],
        }
    else:
        nearest = ranked_outside_sla[:nearest_count]
        why = (
            f"No compliant slot (utilisation <= {threshold:.0f}%) found on or before SLA due date {sla_due_date[:10]}; "
            f"surfaced {len(nearest)} nearest post-SLA options."
        )
        result = {
            "ok": True,
            "within_sla_available": False,
            "best_slot": None,
            "nearest_options": nearest,
            "skipped_high_utilisation_dates": skipped_high_util_dates,
            "why": why,
        }

    ctx.ranked_result = result
    return result


def rebook_job(
    ctx: AgentRunContext,
    job_ref: str,
    slot_id: str,
    reason_summary: str,
) -> dict[str, Any]:
    """
    Commit the rebooking in the operational store.
    Enforces strict guardrails:
      1. slot_id must exist in get_capacity results for this run.
      2. Assisted mode cannot auto-execute without human approval.
      3. Vulnerable (PSR) customers ALWAYS require human approval.
      4. Dependencies/D36 and DNO must not be blocked.
    """
    job = get_job_record(job_ref, db_path=ctx.db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    rules = load_rules()
    vuln_requires_approval = bool(rules.get("agent", {}).get("vulnerable_always_requires_approval", True))

    if ctx.dependencies_clear is False or ctx.dno_blocked:
        return {
            "ok": False,
            "guardrail_blocked": True,
            "error": "Guardrail violation: cannot rebook a job with blocking D36, dependency, or DNO status.",
        }

    if ctx.mode == "assisted" and not ctx.human_approved:
        return {
            "ok": False,
            "guardrail_blocked": True,
            "requires_human_approval": True,
            "error": "Guardrail: rebook_job cannot execute in Assisted mode until a human planner approves.",
        }

    if job.get("is_vulnerable") and vuln_requires_approval and not ctx.human_approved:
        return {
            "ok": False,
            "guardrail_blocked": True,
            "requires_human_approval": True,
            "error": "Guardrail: vulnerable / PSR customer requires mandatory human approval before rebooking.",
        }

    slot = ctx.candidate_slots_by_id.get(slot_id)
    if not slot:
        if ctx.human_approved:
            # Allow human-approved proposal execution from stored slot record
            slot = get_slot_by_id(slot_id, db_path=ctx.db_path)
        if not slot:
            return {
                "ok": False,
                "guardrail_blocked": True,
                "error": f"Guardrail violation: slot '{slot_id}' was not returned by get_capacity.",
            }

    if ctx.dno_earliest_date and slot["slot_date"] < ctx.dno_earliest_date:
        return {
            "ok": False,
            "guardrail_blocked": True,
            "error": f"Guardrail violation: slot date {slot['slot_date']} is earlier than DNO lead-time date {ctx.dno_earliest_date}.",
        }

    reserved = reserve_slot(slot_id, db_path=ctx.db_path)
    if not reserved:
        return {"ok": False, "error": f"Slot '{slot_id}' is no longer available."}

    sla_due = (job.get("sla_due_date") or "")[:10]
    sla_safe = 1 if (not sla_due or reserved["slot_date"] <= sla_due) else 0

    update_job_fields(
        job_ref,
        {
            "status": "Rebooked",
            "rebook_flag": 1,
            "rebooked_slot_id": slot_id,
            "rebooked_date": reserved["slot_date"],
            "rebooked_window": f"{reserved['time_window']} ({reserved['window_hours']})",
            "rebooked_engineer_id": reserved["engineer_id"],
            "sla_safe": sla_safe,
            "agent_outcome": "REBOOKED",
        },
        db_path=ctx.db_path,
    )
    ctx.rebooked_slot = reserved
    return {
        "ok": True,
        "job_ref": job_ref,
        "status": "Rebooked",
        "rebook_flag": True,
        "slot_id": slot_id,
        "rebooked_date": reserved["slot_date"],
        "time_window": reserved["time_window"],
        "window_hours": reserved["window_hours"],
        "engineer_id": reserved["engineer_id"],
        "engineer_name": reserved["engineer_name"],
        "sla_safe": bool(sla_safe),
        "reason_summary": reason_summary,
    }


def draft_customer_message(
    ctx: AgentRunContext,
    job_ref: str,
    channel: str,
    new_date: str,
    new_window: str,
    awaiting_approval: bool = False,
    dno_lead_note: str | None = None,
) -> dict[str, Any]:
    """Draft a polite customer notification marked 'Simulated send' (never sends externally)."""
    job = get_job_record(job_ref, db_path=ctx.db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    rules = load_rules()
    windows_map = rules.get("capacity_and_ranking", {}).get("time_windows", {})
    disclaimer = rules.get("agent", {}).get("simulated_message_disclaimer", "Simulated send")
    hours = windows_map.get(new_window, "")
    window_text = f"{new_window} ({hours})" if hours else new_window

    alias = job.get("customer_alias") or "Customer"
    supplier = job.get("supplier_name") or "your energy supplier"
    extra_dno = f" {dno_lead_note.strip()}" if dno_lead_note else ""
    vuln_note = " An engineer briefed for Priority Services support has been allocated." if job.get("is_vulnerable") else ""

    body = (
        f"Hello {alias}, on behalf of {supplier}, we have arranged a new smart meter appointment "
        f"for {new_date} during the {window_text} window.{extra_dno}{vuln_note} "
        f"To change or reschedule this slot, reply 'CHANGE' or visit your {supplier} customer portal "
        f"(ref: {job_ref})."
    )

    msg_status = "PENDING_APPROVAL (Simulated send)" if awaiting_approval else disclaimer
    update_job_fields(
        job_ref,
        {
            "customer_message": body,
            "customer_message_channel": channel,
            "message_status": msg_status,
        },
        db_path=ctx.db_path,
    )

    payload = {
        "ok": True,
        "job_ref": job_ref,
        "channel": channel,
        "message": body,
        "new_date": new_date,
        "new_window": window_text,
        "simulated_send": True,
        "send_label": disclaimer,
        "awaiting_approval": awaiting_approval,
        "message_status": msg_status,
    }
    ctx.message_preview = payload
    return payload


def escalate_to_planner(
    ctx: AgentRunContext,
    job_ref: str,
    reason: str,
    category: str,
    nearest_options: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Escalate a job to the human planner queue with reason and optional nearest slots."""
    job = get_job_record(job_ref, db_path=ctx.db_path)
    if not job:
        return {"ok": False, "error": f"Job '{job_ref}' not found."}

    esc_id = f"ESC-{job_ref.split('-')[-1]}-{uuid.uuid4().hex[:5].upper()}"
    compact_options = [
        {
            "slot_id": opt.get("slot_id"),
            "slot_date": opt.get("slot_date"),
            "time_window": opt.get("time_window"),
            "window_hours": opt.get("window_hours"),
            "engineer_id": opt.get("engineer_id"),
            "engineer_name": opt.get("engineer_name"),
            "regional_utilisation_pct": opt.get("regional_utilisation_pct"),
        }
        for opt in (nearest_options or [])[:3]
    ]

    esc = upsert_escalation(
        escalation_id=esc_id,
        job_ref=job_ref,
        region_code=job["region_code"],
        category=category,
        reason=reason,
        nearest_options=compact_options,
        db_path=ctx.db_path,
    )

    outcome = "AWAITING_APPROVAL" if category == "VULNERABLE_APPROVAL" else "ESCALATED"
    new_status = "Awaiting Approval" if category == "VULNERABLE_APPROVAL" else "Escalated"
    sla_safe = 0 if category == "NO_SLOT_WITHIN_SLA" else 1
    update_job_fields(
        job_ref,
        {
            "status": new_status,
            "agent_outcome": outcome,
            "sla_safe": sla_safe,
        },
        db_path=ctx.db_path,
    )
    ctx.escalation = esc
    return {"ok": True, **esc}


def write_audit(
    ctx: AgentRunContext,
    job_ref: str,
    step_name: str,
    status: str,
    decision: str,
    reasoning_summary: str,
    tool_name: str = "write_audit",
    input_data: Any = None,
    output_data: Any = None,
) -> dict[str, Any]:
    """Persist a structured audit entry for a step or final agent decision."""
    job = get_job_record(job_ref, db_path=ctx.db_path)
    region_code = job["region_code"] if job else ""
    entry = append_audit_entry(
        run_id=ctx.run_id,
        job_ref=job_ref,
        region_code=region_code,
        mode=ctx.mode,
        step_name=step_name,
        tool_name=tool_name,
        status=status,
        input_data=input_data if input_data is not None else {"job_ref": job_ref, "decision": decision},
        output_data=output_data if output_data is not None else {"status": status},
        decision=decision,
        reasoning_summary=reasoning_summary,
        db_path=ctx.db_path,
    )
    ctx.audit_entries.append(entry)
    return {"ok": True, "audit_id": entry["audit_id"], "step_name": step_name, "decision": decision}


# ─── Dispatch Registry ───────────────────────────────────────────────────────

TOOL_FUNCTIONS: dict[str, Callable[..., dict[str, Any]]] = {
    "get_job": get_job,
    "check_dependencies_and_d36": check_dependencies_and_d36,
    "check_dependencies_and_d30": check_dependencies_and_d30,
    "check_dno_flow": check_dno_flow,
    "raise_dno_request": raise_dno_request,
    "get_capacity": get_capacity,
    "rank_slots": rank_slots,
    "rebook_job": rebook_job,
    "draft_customer_message": draft_customer_message,
    "escalate_to_planner": escalate_to_planner,
    "write_audit": write_audit,
}


def execute_tool(ctx: AgentRunContext, tool_name: str, args: Any) -> dict[str, Any]:
    """Validate arguments and execute the requested tool within the run context."""
    valid, err = validate_tool_args(tool_name, args)
    if not valid:
        return {"ok": False, "validation_error": True, "error": err}

    fn = TOOL_FUNCTIONS[tool_name]
    try:
        return fn(ctx, **args)
    except TypeError as exc:
        return {"ok": False, "validation_error": True, "error": f"Invalid arguments for '{tool_name}': {exc}"}
    except Exception as exc:
        return {"ok": False, "error": f"Tool '{tool_name}' failed: {exc}"}
