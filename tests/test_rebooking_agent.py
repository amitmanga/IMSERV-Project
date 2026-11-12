"""
Unit and end-to-end tests for the agentic Rebooking Agent, rules engine,
tool schemas/guardrails, scenarios (a)-(f), LLM error handling, and Flask/SSE routes.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import app as app_module
from engine.rebooking_agent import (
    approve_and_execute_rebooking,
    reject_rebooking_proposal,
    run_rebooking_agent,
    stream_rebooking_agent,
)
from engine.rebooking_store import (
    get_job_record,
    list_audit_entries,
    list_escalations,
    reset_rebooking_store,
)
from engine.rebooking_tools import (
    AgentRunContext,
    TOOL_SPEC_DEFS,
    execute_tool,
    validate_tool_args,
)
from engine.rules_loader import (
    compute_sla_due_date,
    evaluate_dependencies_and_d30,
    evaluate_dno_flow,
    load_rules,
    required_skill_for_job,
)


class RebookingAgentTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_rebooking.db"
        reset_rebooking_store(regenerate_csv=False, db_path=self.db_path)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    # ── 1. Rules Engine Unit Tests ───────────────────────────────────────────

    def test_rules_yaml_loads_expected_sections(self) -> None:
        rules = load_rules(force_reload=True)
        for section in ("dno", "d30", "dependencies", "capacity_and_ranking", "sla", "agent"):
            self.assertIn(section, rules)
        self.assertEqual(rules["capacity_and_ranking"]["utilisation_threshold_pct"], 90.0)
        self.assertEqual(rules["agent"]["manual_benchmark_minutes"], 12.0)

    def test_evaluate_dependencies_and_d30(self) -> None:
        clear = evaluate_dependencies_and_d30("CLEAR", "NONE")
        self.assertTrue(clear["clear"])
        self.assertFalse(clear["blocked"])

        d30_blocked = evaluate_dependencies_and_d30("PENDING_SUPPLIER", "NONE")
        self.assertTrue(d30_blocked["blocked"])
        self.assertIn("D30 workflow status", d30_blocked["summary"])

        dep_blocked = evaluate_dependencies_and_d30("CLEAR", "ASBESTOS_CHECK")
        self.assertTrue(dep_blocked["blocked"])
        self.assertIn("ASBESTOS_CHECK", dep_blocked["summary"])

    def test_evaluate_dno_flow(self) -> None:
        not_req = evaluate_dno_flow("EXCHANGE", "Customer Cancelled", "NOT_REQUIRED")
        self.assertEqual(not_req["dno_status"], "NOT_REQUIRED")
        self.assertTrue(not_req["clear"])

        pending = evaluate_dno_flow("NEW_INSTALL", "Main Fuse Upgrade Required", "PENDING")
        self.assertEqual(pending["dno_status"], "PENDING")
        self.assertTrue(pending["requires_request"])
        self.assertGreaterEqual(pending["default_lead_time_days"], 1)

        complete = evaluate_dno_flow("NEW_INSTALL", "Isolation Switch", "COMPLETE")
        self.assertEqual(complete["dno_status"], "COMPLETE")
        self.assertTrue(complete["clear"])

        blocked = evaluate_dno_flow("NEW_INSTALL", "Substation Fault", "BLOCKED")
        self.assertEqual(blocked["dno_status"], "BLOCKED")
        self.assertTrue(blocked["blocked"])

    def test_sla_and_skill_mapping(self) -> None:
        anchor = date(2026, 11, 10)
        urgent_sla = compute_sla_due_date("REPAIR", "Safety concern", anchor_date=anchor)
        repair_sla = compute_sla_due_date("REPAIR", "No Supply", anchor_date=anchor)
        normal_sla = compute_sla_due_date("EXCHANGE", "Customer Reschedule", anchor_date=anchor)
        self.assertEqual(urgent_sla, "2026-11-13")
        self.assertEqual(repair_sla, "2026-11-15")
        self.assertEqual(normal_sla, "2026-11-24")
        self.assertEqual(required_skill_for_job("EXCHANGE", "SMETS2 GAS"), "DUAL_FUEL")
        self.assertEqual(required_skill_for_job("EXCHANGE", "SMETS2 DUAL FUEL"), "SMETS2_ELEC")
        self.assertEqual(required_skill_for_job("REPAIR", "SMETS2 ELEC"), "SMETS_REPAIR")

    # ── 2. Tool Schema Validation & Guardrails ───────────────────────────────

    def test_tool_schema_validation_rejects_bad_args(self) -> None:
        for tool_name in (
            "get_job",
            "check_dependencies_and_d30",
            "check_dno_flow",
            "raise_dno_request",
            "get_capacity",
            "rank_slots",
            "rebook_job",
            "draft_customer_message",
            "escalate_to_planner",
            "write_audit",
        ):
            self.assertIn(tool_name, TOOL_SPEC_DEFS)

        ok, err = validate_tool_args("unknown_tool", {})
        self.assertFalse(ok)
        self.assertIn("Unknown tool", err)

        ok, err = validate_tool_args("get_job", {})
        self.assertFalse(ok)
        self.assertIn("Missing required argument", err)

        ok, err = validate_tool_args("get_job", {"job_ref": "RBK-DEMO-A", "extra": 1})
        self.assertFalse(ok)
        self.assertIn("Unexpected argument", err)

        ok, err = validate_tool_args("escalate_to_planner", {
            "job_ref": "RBK-DEMO-A",
            "reason": "Testing invalid enum",
            "category": "INVALID_CAT",
        })
        self.assertFalse(ok)
        self.assertIn("must be one of", err)

        ok, err = validate_tool_args("draft_customer_message", {
            "job_ref": "RBK-DEMO-A",
            "channel": "SMS",
            "new_date": "bad-date",
            "new_window": "Morning",
        })
        self.assertFalse(ok)
        self.assertIn("YYYY-MM-DD", err)

    def test_guardrails_slot_invention_and_assisted_and_vulnerable(self) -> None:
        ctx_assisted = AgentRunContext(
            run_id="RUN-TEST-1",
            job_ref="RBK-DEMO-A",
            mode="assisted",
            db_path=self.db_path,
        )
        # Rebook before get_capacity / in assisted mode -> blocked
        res = execute_tool(ctx_assisted, "rebook_job", {
            "job_ref": "RBK-DEMO-A",
            "slot_id": "FAKE-SLOT-999",
            "reason_summary": "Attempted bypass",
        })
        self.assertFalse(res["ok"])
        self.assertTrue(res.get("guardrail_blocked"))
        self.assertTrue(res.get("requires_human_approval"))

        # Autonomous mode still blocks invented slot ID
        ctx_auto = AgentRunContext(
            run_id="RUN-TEST-2",
            job_ref="RBK-DEMO-A",
            mode="autonomous",
            db_path=self.db_path,
        )
        res_fake = execute_tool(ctx_auto, "rebook_job", {
            "job_ref": "RBK-DEMO-A",
            "slot_id": "SLOT-INVENTED-123",
            "reason_summary": "Hallucinated slot",
        })
        self.assertFalse(res_fake["ok"])
        self.assertIn("not returned by get_capacity", res_fake["error"])

        # Vulnerable job blocks rebook_job even in autonomous mode
        ctx_vuln = AgentRunContext(
            run_id="RUN-TEST-3",
            job_ref="RBK-DEMO-F",
            mode="autonomous",
            db_path=self.db_path,
        )
        job_f = execute_tool(ctx_vuln, "get_job", {"job_ref": "RBK-DEMO-F"})
        self.assertTrue(job_f["is_vulnerable"])
        cap_f = execute_tool(ctx_vuln, "get_capacity", {
            "region_code": job_f["region_code"],
            "job_type": job_f["job_type"],
            "required_skill": job_f["required_skill"],
            "start_date": (date.today() + timedelta(days=1)).isoformat(),
            "end_date": job_f["sla_due_date"],
        })
        self.assertGreater(len(cap_f["candidate_slots"]), 0)
        res_vuln = execute_tool(ctx_vuln, "rebook_job", {
            "job_ref": "RBK-DEMO-F",
            "slot_id": cap_f["candidate_slots"][0]["slot_id"],
            "reason_summary": "Should block for PSR customer",
        })
        self.assertFalse(res_vuln["ok"])
        self.assertTrue(res_vuln.get("requires_human_approval"))

    def test_all_ten_tools_direct_execution(self) -> None:
        ctx = AgentRunContext(
            run_id="RUN-TOOLS",
            job_ref="RBK-DEMO-C",
            mode="autonomous",
            db_path=self.db_path,
        )
        job = execute_tool(ctx, "get_job", {"job_ref": "RBK-DEMO-C"})
        self.assertTrue(job["ok"])
        dep = execute_tool(ctx, "check_dependencies_and_d30", {"job_ref": "RBK-DEMO-C"})
        self.assertTrue(dep["clear"])
        dno = execute_tool(ctx, "check_dno_flow", {"job_ref": "RBK-DEMO-C"})
        self.assertEqual(dno["dno_status"], "PENDING")
        dno_req = execute_tool(ctx, "raise_dno_request", {
            "job_ref": "RBK-DEMO-C",
            "reason": job["reason"],
            "lead_time_days": 7,
        })
        self.assertTrue(dno_req["ok"])
        self.assertEqual(dno_req["status"], "SUBMITTED_SIMULATED")
        cap = execute_tool(ctx, "get_capacity", {
            "region_code": job["region_code"],
            "job_type": job["job_type"],
            "required_skill": job["required_skill"],
            "start_date": dno_req["earliest_eligible_date"],
            "end_date": job["sla_due_date"],
        })
        self.assertGreater(len(cap["candidate_slots"]), 0)
        ranked = execute_tool(ctx, "rank_slots", {
            "job_ref": "RBK-DEMO-C",
            "candidate_slot_ids": [s["slot_id"] for s in cap["candidate_slots"]],
            "sla_due_date": job["sla_due_date"],
            "preferred_window": job["preferred_time_of_day"],
        })
        self.assertTrue(ranked["within_sla_available"])
        best = ranked["best_slot"]
        self.assertGreaterEqual(best["slot_date"], dno_req["earliest_eligible_date"])

        rebooked = execute_tool(ctx, "rebook_job", {
            "job_ref": "RBK-DEMO-C",
            "slot_id": best["slot_id"],
            "reason_summary": "Booked after DNO lead time",
        })
        self.assertTrue(rebooked["rebook_flag"])

        msg = execute_tool(ctx, "draft_customer_message", {
            "job_ref": "RBK-DEMO-C",
            "channel": "Email",
            "new_date": best["slot_date"],
            "new_window": best["time_window"],
        })
        self.assertEqual(msg["message_status"], "Simulated send")
        audit = execute_tool(ctx, "write_audit", {
            "job_ref": "RBK-DEMO-C",
            "step_name": "Log",
            "status": "REBOOKED",
            "decision": "Rebooked C",
            "reasoning_summary": "DNO request submitted and valid post-lead slot booked.",
        })
        self.assertTrue(audit["ok"])

    # ── 3. End-to-End Demo Scenarios (a)–(f) ─────────────────────────────────

    def test_scenario_a_clean_rebook_assisted_then_approve(self) -> None:
        res_assisted = run_rebooking_agent("RBK-DEMO-A", mode="assisted", mock_llm=True, db_path=self.db_path)
        self.assertEqual(res_assisted["outcome"], "AWAITING_APPROVAL")
        self.assertFalse(res_assisted["job"]["rebook_flag"])
        self.assertIn("Simulated send", res_assisted["job"]["message_status"])
        self.assertIsNotNone(res_assisted["chosen_slot"])

        approved = approve_and_execute_rebooking(
            "RBK-DEMO-A",
            edited_message="Updated polite test notification [RBK-DEMO-A]",
            db_path=self.db_path,
        )
        self.assertTrue(approved["ok"])
        self.assertTrue(approved["job"]["rebook_flag"])
        self.assertEqual(approved["job"]["status"], "Rebooked")
        self.assertEqual(approved["job"]["customer_message"], "Updated polite test notification [RBK-DEMO-A]")
        self.assertEqual(approved["job"]["message_status"], "Simulated send")

    def test_scenario_b_high_utilisation_and_no_access_avoidance(self) -> None:
        res = run_rebooking_agent("RBK-DEMO-B", mode="autonomous", mock_llm=True, db_path=self.db_path)
        self.assertEqual(res["outcome"], "REBOOKED")
        chosen = res["chosen_slot"]
        self.assertLessEqual(chosen["regional_utilisation_pct"], 90.0)
        self.assertNotEqual(chosen["engineer_id"], res["job"]["original_engineer_id"])
        self.assertLessEqual(chosen["slot_date"], res["job"]["sla_due_date"])

    def test_scenario_c_dno_pending_raises_request_and_respects_lead_time(self) -> None:
        res = run_rebooking_agent("RBK-DEMO-C", mode="autonomous", mock_llm=True, db_path=self.db_path)
        self.assertEqual(res["outcome"], "REBOOKED")
        job = res["job"]
        self.assertEqual(job["dno_status"], "PENDING_REQUESTED")
        self.assertTrue(job["dno_ref"].startswith("DNO-SIM-"))
        self.assertGreaterEqual(job["rebooked_date"], job["dno_earliest_date"])
        self.assertLessEqual(job["rebooked_date"], job["sla_due_date"])

    def test_scenario_d_blocked_by_d30_and_dependency_escalated(self) -> None:
        res = run_rebooking_agent("RBK-DEMO-D", mode="autonomous", mock_llm=True, db_path=self.db_path)
        self.assertEqual(res["outcome"], "ESCALATED")
        self.assertFalse(res["job"]["rebook_flag"])
        self.assertEqual(res["job"]["status"], "Escalated")
        escs = [e for e in list_escalations(db_path=self.db_path) if e["job_ref"] == "RBK-DEMO-D"]
        self.assertEqual(len(escs), 1)
        self.assertEqual(escs[0]["category"], "D30_OR_DEPENDENCY")

    def test_scenario_e_no_slot_within_sla_escalates_with_three_options(self) -> None:
        res = run_rebooking_agent("RBK-DEMO-E", mode="autonomous", mock_llm=True, db_path=self.db_path)
        self.assertEqual(res["outcome"], "ESCALATED")
        self.assertFalse(res["job"]["sla_safe"])
        escs = [e for e in list_escalations(db_path=self.db_path) if e["job_ref"] == "RBK-DEMO-E"]
        self.assertEqual(len(escs), 1)
        self.assertEqual(escs[0]["category"], "NO_SLOT_WITHIN_SLA")
        self.assertEqual(len(escs[0]["nearest_options"]), 3)

    def test_scenario_f_vulnerable_customer_requires_human_approval_in_autonomous(self) -> None:
        res = run_rebooking_agent("RBK-DEMO-F", mode="autonomous", mock_llm=True, db_path=self.db_path)
        self.assertEqual(res["outcome"], "AWAITING_APPROVAL")
        self.assertFalse(res["job"]["rebook_flag"])
        escs = [e for e in list_escalations(db_path=self.db_path) if e["job_ref"] == "RBK-DEMO-F"]
        self.assertEqual(len(escs), 1)
        self.assertEqual(escs[0]["category"], "VULNERABLE_APPROVAL")

        # Test reject path as well
        rejected = reject_rebooking_proposal("RBK-DEMO-F", reason="Customer prefers next week", db_path=self.db_path)
        self.assertTrue(rejected["ok"])
        self.assertEqual(rejected["job"]["agent_outcome"], "ESCALATED")
        self.assertEqual(rejected["job"]["status"], "Escalated")

    # ── 4. Graceful Live LLM Timeout / Error Handling ────────────────────────

    def test_live_llm_timeout_yields_friendly_sse_error(self) -> None:
        with patch("engine.rebooking_agent._call_live_llm", side_effect=TimeoutError("HF Router timed out")):
            events = list(
                stream_rebooking_agent(
                    "RBK-DEMO-A",
                    mode="assisted",
                    mock_llm=False,
                    db_path=self.db_path,
                    step_delay_s=0.0,
                )
            )
        error_events = [e for e in events if e["event"] == "error"]
        self.assertEqual(len(error_events), 1)
        self.assertIn("friendly_message", error_events[0]["data"])
        self.assertIn("Mock LLM", error_events[0]["data"]["friendly_message"])
        audits = list_audit_entries(job_ref="RBK-DEMO-A", status="ERROR", db_path=self.db_path)
        self.assertGreaterEqual(len(audits), 1)

    # ── 5. Flask Routes & SSE Integration Tests ──────────────────────────────

    def test_flask_routes_sse_and_csv_export(self) -> None:
        with patch.dict(os.environ, {"REBOOKING_DB_PATH": str(self.db_path), "MOCK_LLM": "true"}):
            client = app_module.app.test_client()

            home = client.get("/")
            self.assertEqual(home.status_code, 200)
            html = home.get_data(as_text=True)
            self.assertIn("Rebooking Agent", html)
            self.assertIn("rebooking_agent.js", html)

            jobs_resp = client.get("/api/rebooking-agent/jobs")
            self.assertEqual(jobs_resp.status_code, 200)
            jobs_data = jobs_resp.get_json()
            self.assertEqual(len(jobs_data["jobs"]), 30)

            sse_resp = client.get("/api/rebooking-agent/stream/RBK-DEMO-A?mode=autonomous&mock_llm=true&delay=0")
            self.assertEqual(sse_resp.status_code, 200)
            self.assertIn("text/event-stream", sse_resp.content_type)
            sse_body = sse_resp.get_data(as_text=True)
            self.assertIn("event: step_completed", sse_body)
            self.assertIn("event: run_completed", sse_body)

            # Assisted run -> approve via HTTP
            run_resp = client.post("/api/rebooking-agent/run/RBK-DEMO-C", json={"mode": "assisted", "mock_llm": True})
            self.assertEqual(run_resp.status_code, 200)
            self.assertEqual(run_resp.get_json()["outcome"], "AWAITING_APPROVAL")

            approve_resp = client.post("/api/rebooking-agent/jobs/RBK-DEMO-C/approve", json={})
            self.assertEqual(approve_resp.status_code, 200)
            self.assertTrue(approve_resp.get_json()["job"]["rebook_flag"])

            # CSV export of audit trail
            csv_resp = client.get("/api/rebooking-agent/audit?format=csv")
            self.assertEqual(csv_resp.status_code, 200)
            self.assertIn("text/csv", csv_resp.content_type)
            csv_text = csv_resp.get_data(as_text=True)
            self.assertIn("RBK-DEMO-A", csv_text)
            self.assertIn("reasoning_summary", csv_text)


if __name__ == "__main__":
    unittest.main()
