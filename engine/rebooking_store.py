"""
SQLite operational state store for the Rebooking Agent.

Seeds from data/inputs/rebooking_jobs.csv and data/inputs/rebooking_slots_28d.csv
without mutating master_operations.csv. Supports atomic updates for rebooking,
simulated DNO requests, planner escalations, approval workflows, and audit logs.
"""
from __future__ import annotations

import csv
import json
import os
import sqlite3
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from engine.rules_loader import load_rules

BASE_DIR = Path(__file__).resolve().parent.parent
INPUTS_DIR = BASE_DIR / "data" / "inputs"
DEFAULT_DB_PATH = BASE_DIR / "data" / "rebooking_state.db"

_LOCK = threading.RLock()


def get_db_path() -> Path:
    override = os.getenv("REBOOKING_DB_PATH")
    return Path(override).resolve() if override else DEFAULT_DB_PATH


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS rebooking_jobs (
            job_ref TEXT PRIMARY KEY,
            scenario_tag TEXT,
            scenario_label TEXT,
            supplier_name TEXT,
            region_code TEXT,
            region_name TEXT,
            patch_code TEXT,
            primary_channel TEXT,
            contact_preference TEXT,
            preferred_time_of_day TEXT,
            meter_type TEXT,
            job_type TEXT,
            required_skill TEXT,
            original_status TEXT,
            status TEXT,
            requested_date TEXT,
            booked_date TEXT,
            sla_due_date TEXT,
            cancellation_reason TEXT,
            abort_reason TEXT,
            original_engineer_id TEXT,
            customer_alias TEXT,
            d36_status TEXT,
            d30_status TEXT,
            dependency_flags TEXT,
            dno_status TEXT,
            dno_ref TEXT,
            dno_earliest_date TEXT DEFAULT '',
            is_vulnerable INTEGER DEFAULT 0,
            vulnerability_reason TEXT DEFAULT '',
            rebook_flag INTEGER DEFAULT 0,
            rebooked_slot_id TEXT DEFAULT '',
            rebooked_date TEXT DEFAULT '',
            rebooked_window TEXT DEFAULT '',
            rebooked_engineer_id TEXT DEFAULT '',
            proposed_slot_json TEXT DEFAULT '',
            agent_outcome TEXT DEFAULT 'PENDING',
            agent_mode TEXT DEFAULT '',
            agent_duration_ms INTEGER DEFAULT 0,
            sla_safe INTEGER DEFAULT 1,
            customer_message TEXT DEFAULT '',
            customer_message_channel TEXT DEFAULT '',
            message_status TEXT DEFAULT '',
            last_reasoning_json TEXT DEFAULT '[]',
            updated_at TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS rebooking_slots (
            slot_id TEXT PRIMARY KEY,
            slot_date TEXT,
            day_offset INTEGER,
            day_of_week TEXT,
            time_window TEXT,
            window_hours TEXT,
            region_code TEXT,
            region_name TEXT,
            patch_code TEXT,
            engineer_id TEXT,
            engineer_name TEXT,
            skills TEXT,
            supplier_affiliation TEXT,
            slot_capacity INTEGER,
            slot_booked INTEGER,
            slot_available INTEGER,
            regional_utilisation_pct REAL
        );

        CREATE INDEX IF NOT EXISTS idx_slots_region_date
            ON rebooking_slots(region_code, slot_date, slot_available);

        CREATE TABLE IF NOT EXISTS dno_requests (
            dno_ref TEXT PRIMARY KEY,
            job_ref TEXT,
            region_code TEXT,
            job_type TEXT,
            reason TEXT,
            lead_time_days INTEGER,
            earliest_eligible_date TEXT,
            status TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS planner_escalations (
            escalation_id TEXT PRIMARY KEY,
            job_ref TEXT,
            region_code TEXT,
            category TEXT,
            reason TEXT,
            nearest_options_json TEXT DEFAULT '[]',
            status TEXT DEFAULT 'OPEN',
            resolution_note TEXT DEFAULT '',
            created_at TEXT,
            resolved_at TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS rebooking_audit_log (
            audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT,
            job_ref TEXT,
            region_code TEXT,
            mode TEXT,
            step_name TEXT,
            tool_name TEXT,
            status TEXT,
            input_json TEXT,
            output_json TEXT,
            decision TEXT,
            reasoning_summary TEXT,
            created_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_job_created
            ON rebooking_audit_log(job_ref, created_at);

        CREATE TABLE IF NOT EXISTS rebooking_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    """)

    cursor = conn.execute("PRAGMA table_info(rebooking_jobs)")
    cols = {r["name"] for r in cursor.fetchall()}
    if cols and "d36_status" not in cols:
        conn.execute("ALTER TABLE rebooking_jobs ADD COLUMN d36_status TEXT")
        if "d30_status" in cols:
            conn.execute("UPDATE rebooking_jobs SET d36_status = d30_status WHERE d36_status IS NULL")
    if cols and "d30_status" not in cols:
        conn.execute("ALTER TABLE rebooking_jobs ADD COLUMN d30_status TEXT")
        if "d36_status" in cols:
            conn.execute("UPDATE rebooking_jobs SET d30_status = d36_status WHERE d30_status IS NULL")


def _ensure_source_csvs() -> None:
    jobs_csv = INPUTS_DIR / "rebooking_jobs.csv"
    slots_csv = INPUTS_DIR / "rebooking_slots_28d.csv"
    needs_regen = not (jobs_csv.exists() and slots_csv.exists())
    if not needs_regen:
        try:
            with open(slots_csv, encoding="utf-8-sig", newline="") as fh:
                first = next(csv.DictReader(fh), None)
                if not first or first.get("slot_date", "") < date.today().isoformat():
                    needs_regen = True
        except Exception:
            needs_regen = True

    if needs_regen:
        from scripts.augment_rebooking_data import generate_rebooking_datasets
        generate_rebooking_datasets()


def seed_rebooking_store(force: bool = False, db_path: Path | None = None) -> None:
    """Seed rebooking_state.db from augmented CSV files."""
    with _LOCK:
        _ensure_source_csvs()
        conn = _connect(db_path)
        try:
            _init_schema(conn)
            if not force:
                existing = conn.execute("SELECT COUNT(*) AS n FROM rebooking_jobs").fetchone()["n"]
                if existing > 0:
                    return

            conn.execute("DELETE FROM rebooking_jobs")
            conn.execute("DELETE FROM rebooking_slots")
            conn.execute("DELETE FROM dno_requests")
            conn.execute("DELETE FROM planner_escalations")
            conn.execute("DELETE FROM rebooking_audit_log")

            jobs_csv = INPUTS_DIR / "rebooking_jobs.csv"
            with open(jobs_csv, encoding="utf-8-sig", newline="") as fh:
                rows = list(csv.DictReader(fh))
                conn.executemany(
                    """
                    INSERT INTO rebooking_jobs (
                        job_ref, scenario_tag, scenario_label, supplier_name,
                        region_code, region_name, patch_code, primary_channel,
                        contact_preference, preferred_time_of_day, meter_type,
                        job_type, required_skill, original_status, status,
                        requested_date, booked_date, sla_due_date,
                        cancellation_reason, abort_reason, original_engineer_id,
                        customer_alias, d36_status, d30_status, dependency_flags, dno_status,
                        dno_ref, is_vulnerable, vulnerability_reason, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            r["job_ref"], r["scenario_tag"], r["scenario_label"], r["supplier_name"],
                            r["region_code"], r["region_name"], r["patch_code"], r["primary_channel"],
                            r["contact_preference"], r["preferred_time_of_day"], r["meter_type"],
                            r["job_type"], r["required_skill"], r["original_status"], r["status"],
                            r["requested_date"], r["booked_date"], r["sla_due_date"],
                            r["cancellation_reason"], r["abort_reason"], r["original_engineer_id"],
                            r["customer_alias"],
                            r.get("d36_status") or r.get("d30_status", "CLEAR"),
                            r.get("d36_status") or r.get("d30_status", "CLEAR"),
                            r["dependency_flags"], r["dno_status"],
                            r.get("dno_ref", ""), int(r.get("is_vulnerable") or 0),
                            r.get("vulnerability_reason", ""), _utc_now(),
                        )
                        for r in rows
                    ],
                )

            slots_csv = INPUTS_DIR / "rebooking_slots_28d.csv"
            with open(slots_csv, encoding="utf-8-sig", newline="") as fh:
                srows = list(csv.DictReader(fh))
                conn.executemany(
                    """
                    INSERT INTO rebooking_slots (
                        slot_id, slot_date, day_offset, day_of_week, time_window,
                        window_hours, region_code, region_name, patch_code,
                        engineer_id, engineer_name, skills, supplier_affiliation,
                        slot_capacity, slot_booked, slot_available, regional_utilisation_pct
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            s["slot_id"], s["slot_date"], int(s["day_offset"]), s["day_of_week"],
                            s["time_window"], s["window_hours"], s["region_code"], s["region_name"],
                            s["patch_code"], s["engineer_id"], s["engineer_name"], s["skills"],
                            s["supplier_affiliation"], int(s["slot_capacity"]), int(s["slot_booked"]),
                            int(s["slot_available"]), float(s["regional_utilisation_pct"]),
                        )
                        for s in srows
                    ],
                )

            conn.execute(
                "INSERT OR REPLACE INTO rebooking_meta (key, value) VALUES (?, ?)",
                ("seeded_at", _utc_now()),
            )
            conn.commit()
        finally:
            conn.close()


def ensure_rebooking_store(db_path: Path | None = None) -> None:
    seed_rebooking_store(force=False, db_path=db_path)


seed_initial_data = seed_rebooking_store


def reset_rebooking_store(regenerate_csv: bool = False, db_path: Path | None = None) -> dict[str, Any]:
    if regenerate_csv:
        from scripts.augment_rebooking_data import generate_rebooking_datasets
        generate_rebooking_datasets()
    seed_rebooking_store(force=True, db_path=db_path)
    return {"status": "reset", "timestamp": _utc_now()}


def _row_to_job(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    d = dict(row)
    d["is_vulnerable"] = bool(d.get("is_vulnerable"))
    d["rebook_flag"] = bool(d.get("rebook_flag"))
    d["sla_safe"] = bool(d.get("sla_safe"))
    d["reason"] = d.get("cancellation_reason") or d.get("abort_reason") or "Unspecified"
    try:
        d["proposed_slot"] = json.loads(d.get("proposed_slot_json") or "{}") if d.get("proposed_slot_json") else None
    except json.JSONDecodeError:
        d["proposed_slot"] = None
    try:
        d["last_reasoning"] = json.loads(d.get("last_reasoning_json") or "[]")
    except json.JSONDecodeError:
        d["last_reasoning"] = []
    return d


def list_jobs(
    region: str | None = None,
    reason: str | None = None,
    status: str | None = None,
    db_path: Path | None = None,
) -> list[dict[str, Any]]:
    ensure_rebooking_store(db_path)
    where = []
    params: list[Any] = []
    if region:
        where.append("region_code = ?")
        params.append(region)
    if reason:
        where.append("(cancellation_reason = ? OR abort_reason = ?)")
        params.extend([reason, reason])
    if status:
        where.append("status = ?")
        params.append(status)

    sql = "SELECT * FROM rebooking_jobs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY CASE WHEN scenario_tag LIKE '%DEMO%' OR scenario_tag != 'STANDARD' THEN 0 ELSE 1 END, job_ref ASC"

    with _LOCK:
        conn = _connect(db_path)
        try:
            rows = conn.execute(sql, params).fetchall()
            return [_row_to_job(r) for r in rows]
        finally:
            conn.close()


def get_job_record(job_ref: str, db_path: Path | None = None) -> dict[str, Any] | None:
    ensure_rebooking_store(db_path)
    with _LOCK:
        conn = _connect(db_path)
        try:
            row = conn.execute("SELECT * FROM rebooking_jobs WHERE job_ref = ?", (job_ref,)).fetchone()
            return _row_to_job(row)
        finally:
            conn.close()


def update_job_fields(job_ref: str, fields: dict[str, Any], db_path: Path | None = None) -> dict[str, Any] | None:
    ensure_rebooking_store(db_path)
    if not fields:
        return get_job_record(job_ref, db_path)
    allowed = {
        "status", "dno_status", "dno_ref", "dno_earliest_date",
        "rebook_flag", "rebooked_slot_id", "rebooked_date", "rebooked_window",
        "rebooked_engineer_id", "proposed_slot_json", "agent_outcome",
        "agent_mode", "agent_duration_ms", "sla_safe", "customer_message",
        "customer_message_channel", "message_status", "last_reasoning_json",
    }
    clean = {k: v for k, v in fields.items() if k in allowed}
    clean["updated_at"] = _utc_now()
    assignments = ", ".join(f"{k} = ?" for k in clean)
    params = list(clean.values()) + [job_ref]
    with _LOCK:
        conn = _connect(db_path)
        try:
            conn.execute(f"UPDATE rebooking_jobs SET {assignments} WHERE job_ref = ?", params)
            conn.commit()
            row = conn.execute("SELECT * FROM rebooking_jobs WHERE job_ref = ?", (job_ref,)).fetchone()
            return _row_to_job(row)
        finally:
            conn.close()


def query_slots(
    region_code: str,
    start_date: str,
    end_date: str,
    required_skill: str | None = None,
    only_available: bool = True,
    db_path: Path | None = None,
) -> list[dict[str, Any]]:
    ensure_rebooking_store(db_path)
    sql = """
        SELECT * FROM rebooking_slots
        WHERE region_code = ?
          AND slot_date >= ?
          AND slot_date <= ?
    """
    params: list[Any] = [region_code, start_date, end_date]
    if only_available:
        sql += " AND slot_available > 0"
    sql += " ORDER BY slot_date ASC, CASE time_window WHEN 'Morning' THEN 1 WHEN 'Afternoon' THEN 2 ELSE 3 END, engineer_id ASC"

    with _LOCK:
        conn = _connect(db_path)
        try:
            rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        finally:
            conn.close()

    if required_skill:
        req = required_skill.strip().upper()
        matched = [r for r in rows if req in {s.strip().upper() for s in (r.get("skills") or "").split(",")}]
        return matched
    return rows


def get_slot_by_id(slot_id: str, db_path: Path | None = None) -> dict[str, Any] | None:
    ensure_rebooking_store(db_path)
    with _LOCK:
        conn = _connect(db_path)
        try:
            row = conn.execute("SELECT * FROM rebooking_slots WHERE slot_id = ?", (slot_id,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def reserve_slot(slot_id: str, db_path: Path | None = None) -> dict[str, Any] | None:
    """Decrement slot_available by 1 atomically when executing a rebooking."""
    ensure_rebooking_store(db_path)
    with _LOCK:
        conn = _connect(db_path)
        try:
            row = conn.execute("SELECT * FROM rebooking_slots WHERE slot_id = ?", (slot_id,)).fetchone()
            if not row or int(row["slot_available"]) <= 0:
                return None
            new_booked = int(row["slot_booked"]) + 1
            new_avail = int(row["slot_available"]) - 1
            conn.execute(
                "UPDATE rebooking_slots SET slot_booked = ?, slot_available = ? WHERE slot_id = ?",
                (new_booked, new_avail, slot_id),
            )
            conn.commit()
            updated = conn.execute("SELECT * FROM rebooking_slots WHERE slot_id = ?", (slot_id,)).fetchone()
            return dict(updated) if updated else None
        finally:
            conn.close()


def get_region_daily_utilisation(region_code: str, db_path: Path | None = None) -> list[dict[str, Any]]:
    """Return 28-day daily utilisation and available capacity for a region."""
    ensure_rebooking_store(db_path)
    with _LOCK:
        conn = _connect(db_path)
        try:
            rows = conn.execute(
                """
                SELECT slot_date,
                       MIN(day_offset) AS day_offset,
                       MIN(day_of_week) AS day_of_week,
                       ROUND(AVG(regional_utilisation_pct), 1) AS utilisation_pct,
                       SUM(slot_capacity) AS total_capacity,
                       SUM(slot_booked) AS total_booked,
                       SUM(slot_available) AS total_available
                FROM rebooking_slots
                WHERE region_code = ?
                GROUP BY slot_date
                ORDER BY slot_date ASC
                """,
                (region_code,),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def insert_dno_request(
    dno_ref: str,
    job_ref: str,
    region_code: str,
    job_type: str,
    reason: str,
    lead_time_days: int,
    earliest_eligible_date: str,
    db_path: Path | None = None,
) -> dict[str, Any]:
    ensure_rebooking_store(db_path)
    now = _utc_now()
    with _LOCK:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                INSERT OR REPLACE INTO dno_requests (
                    dno_ref, job_ref, region_code, job_type, reason,
                    lead_time_days, earliest_eligible_date, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED_SIMULATED', ?)
                """,
                (dno_ref, job_ref, region_code, job_type, reason, lead_time_days, earliest_eligible_date, now),
            )
            conn.commit()
        finally:
            conn.close()
    return {
        "dno_ref": dno_ref,
        "job_ref": job_ref,
        "lead_time_days": lead_time_days,
        "earliest_eligible_date": earliest_eligible_date,
        "status": "SUBMITTED_SIMULATED",
        "created_at": now,
    }


def upsert_escalation(
    escalation_id: str,
    job_ref: str,
    region_code: str,
    category: str,
    reason: str,
    nearest_options: list[dict[str, Any]] | None = None,
    db_path: Path | None = None,
) -> dict[str, Any]:
    ensure_rebooking_store(db_path)
    now = _utc_now()
    options_json = json.dumps(nearest_options or [])
    with _LOCK:
        conn = _connect(db_path)
        try:
            # Close any stale open escalation for the same job_ref to prevent duplicates on re-run
            conn.execute(
                "UPDATE planner_escalations SET status = 'SUPERSEDED' WHERE job_ref = ? AND status = 'OPEN'",
                (job_ref,),
            )
            conn.execute(
                """
                INSERT INTO planner_escalations (
                    escalation_id, job_ref, region_code, category, reason,
                    nearest_options_json, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)
                """,
                (escalation_id, job_ref, region_code, category, reason, options_json, now),
            )
            conn.commit()
        finally:
            conn.close()
    return {
        "escalation_id": escalation_id,
        "job_ref": job_ref,
        "region_code": region_code,
        "category": category,
        "reason": reason,
        "nearest_options": nearest_options or [],
        "status": "OPEN",
        "created_at": now,
    }


def list_escalations(status: str | None = None, db_path: Path | None = None) -> list[dict[str, Any]]:
    ensure_rebooking_store(db_path)
    sql = """
        SELECT e.*, j.scenario_label, j.job_type, j.supplier_name, j.sla_due_date,
               j.is_vulnerable, j.customer_alias, j.d36_status, j.d30_status, j.dependency_flags, j.dno_status
        FROM planner_escalations e
        LEFT JOIN rebooking_jobs j ON j.job_ref = e.job_ref
        WHERE e.status != 'SUPERSEDED'
    """
    params: list[Any] = []
    if status:
        sql += " AND e.status = ?"
        params.append(status)
    sql += " ORDER BY e.created_at DESC"

    with _LOCK:
        conn = _connect(db_path)
        try:
            rows = conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    out = []
    for r in rows:
        d = dict(r)
        try:
            d["nearest_options"] = json.loads(d.get("nearest_options_json") or "[]")
        except json.JSONDecodeError:
            d["nearest_options"] = []
        d["is_vulnerable"] = bool(d.get("is_vulnerable"))
        out.append(d)
    return out


def resolve_escalation(
    escalation_id: str,
    resolution_note: str,
    db_path: Path | None = None,
) -> dict[str, Any] | None:
    ensure_rebooking_store(db_path)
    now = _utc_now()
    with _LOCK:
        conn = _connect(db_path)
        try:
            conn.execute(
                """
                UPDATE planner_escalations
                SET status = 'RESOLVED', resolution_note = ?, resolved_at = ?
                WHERE escalation_id = ?
                """,
                (resolution_note, now, escalation_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM planner_escalations WHERE escalation_id = ?", (escalation_id,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def append_audit_entry(
    run_id: str,
    job_ref: str,
    region_code: str,
    mode: str,
    step_name: str,
    tool_name: str,
    status: str,
    input_data: Any,
    output_data: Any,
    decision: str,
    reasoning_summary: str,
    db_path: Path | None = None,
) -> dict[str, Any]:
    ensure_rebooking_store(db_path)
    now = _utc_now()
    in_json = json.dumps(input_data, default=str)
    out_json = json.dumps(output_data, default=str)
    with _LOCK:
        conn = _connect(db_path)
        try:
            cur = conn.execute(
                """
                INSERT INTO rebooking_audit_log (
                    run_id, job_ref, region_code, mode, step_name, tool_name,
                    status, input_json, output_json, decision, reasoning_summary, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, job_ref, region_code, mode, step_name, tool_name, status,
                 in_json, out_json, decision, reasoning_summary, now),
            )
            conn.commit()
            audit_id = cur.lastrowid
        finally:
            conn.close()
    return {
        "audit_id": audit_id,
        "run_id": run_id,
        "job_ref": job_ref,
        "region_code": region_code,
        "mode": mode,
        "step_name": step_name,
        "tool_name": tool_name,
        "status": status,
        "input_data": input_data,
        "output_data": output_data,
        "decision": decision,
        "reasoning_summary": reasoning_summary,
        "created_at": now,
    }


def list_audit_entries(
    job_ref: str | None = None,
    step_name: str | None = None,
    status: str | None = None,
    region_code: str | None = None,
    limit: int = 200,
    db_path: Path | None = None,
) -> list[dict[str, Any]]:
    ensure_rebooking_store(db_path)
    where = []
    params: list[Any] = []
    if job_ref:
        where.append("job_ref LIKE ?")
        params.append(f"%{job_ref}%")
    if step_name:
        where.append("step_name = ?")
        params.append(step_name)
    if status:
        where.append("status = ?")
        params.append(status)
    if region_code:
        where.append("region_code = ?")
        params.append(region_code)

    sql = "SELECT * FROM rebooking_audit_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY audit_id DESC LIMIT ?"
    params.append(int(limit))

    with _LOCK:
        conn = _connect(db_path)
        try:
            rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        finally:
            conn.close()

    for r in rows:
        try:
            r["input_data"] = json.loads(r.get("input_json") or "{}")
        except json.JSONDecodeError:
            r["input_data"] = {}
        try:
            r["output_data"] = json.loads(r.get("output_json") or "{}")
        except json.JSONDecodeError:
            r["output_data"] = {}
    return rows


def get_rebooking_kpis(db_path: Path | None = None) -> dict[str, Any]:
    """Compute top-level KPI tiles for the Rebooking Agent dashboard."""
    ensure_rebooking_store(db_path)
    rules = load_rules()
    benchmark_mins = float(rules.get("agent", {}).get("manual_benchmark_minutes", 12.0))

    with _LOCK:
        conn = _connect(db_path)
        try:
            rows = [dict(r) for r in conn.execute("SELECT * FROM rebooking_jobs").fetchall()]
            open_escalations = conn.execute(
                "SELECT COUNT(*) AS n FROM planner_escalations WHERE status = 'OPEN'"
            ).fetchone()["n"]
        finally:
            conn.close()

    processed = [r for r in rows if r.get("agent_outcome") not in ("", "PENDING", None)]
    auto_rebooked = sum(1 for r in processed if r.get("agent_outcome") == "REBOOKED")
    awaiting_approval = sum(1 for r in processed if r.get("agent_outcome") == "AWAITING_APPROVAL")
    escalated = sum(1 for r in processed if r.get("agent_outcome") == "ESCALATED")

    durations_ms = [int(r.get("agent_duration_ms") or 0) for r in processed if int(r.get("agent_duration_ms") or 0) > 0]
    avg_seconds = round(sum(durations_ms) / len(durations_ms) / 1000.0, 2) if durations_ms else 0.0
    sla_safe_count = sum(1 for r in processed if int(r.get("sla_safe") or 0) == 1)
    sla_safe_pct = round((sla_safe_count / len(processed)) * 100, 1) if processed else 100.0

    time_saved_mins = round(max(benchmark_mins - (avg_seconds / 60.0), 0.0), 2) if processed else benchmark_mins

    return {
        "total_queue": len(rows),
        "jobs_processed": len(processed),
        "auto_rebooked": auto_rebooked,
        "awaiting_approval": awaiting_approval,
        "escalated": escalated,
        "open_escalations": open_escalations,
        "avg_agent_seconds": avg_seconds,
        "manual_benchmark_minutes": benchmark_mins,
        "time_saved_minutes_per_job": time_saved_mins,
        "sla_safe_pct": sla_safe_pct,
    }
