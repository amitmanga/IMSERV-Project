"""
Rules loader and business-logic evaluator for the Rebooking Agent.

Reads configurable rules from config/rules.yaml (or REBOOKING_RULES_PATH)
with mtime-based auto-reload so operational changes take effect immediately.
"""
from __future__ import annotations

import os
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import yaml

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_RULES_PATH = BASE_DIR / "config" / "rules.yaml"

_RULES_CACHE: dict[str, Any] | None = None
_RULES_CACHE_PATH: Path | None = None
_RULES_CACHE_MTIME: int = 0


def get_rules_path() -> Path:
    """Return the active path to rules.yaml."""
    override = os.getenv("REBOOKING_RULES_PATH")
    return Path(override).resolve() if override else DEFAULT_RULES_PATH


def load_rules(force_reload: bool = False) -> dict[str, Any]:
    """Load and cache rules.yaml, reloading automatically when modified."""
    global _RULES_CACHE, _RULES_CACHE_PATH, _RULES_CACHE_MTIME
    path = get_rules_path()
    try:
        mtime = path.stat().st_mtime_ns
    except OSError as exc:
        raise FileNotFoundError(f"Rebooking rules file not found: {path}") from exc

    if (
        not force_reload
        and _RULES_CACHE is not None
        and _RULES_CACHE_PATH == path
        and _RULES_CACHE_MTIME == mtime
    ):
        return _RULES_CACHE

    with open(path, encoding="utf-8") as fh:
        parsed = yaml.safe_load(fh) or {}

    if not isinstance(parsed, dict):
        raise ValueError(f"Expected mapping at root of {path}")

    _RULES_CACHE = parsed
    _RULES_CACHE_PATH = path
    _RULES_CACHE_MTIME = mtime
    return parsed


def required_skill_for_job(job_type: str, meter_type: str) -> str:
    """Map job_type and meter_type to an engineer capability skill code."""
    meter = (meter_type or "SMETS2").upper()
    jtype = (job_type or "EXCHANGE").upper()
    if "GAS" in meter:
        return "DUAL_FUEL"
    if meter == "IHD":
        return "IHD_TECH"
    if jtype == "NEW_INSTALL":
        return "SMETS2_INSTALL"
    if jtype == "REPAIR":
        return "SMETS_REPAIR"
    return "SMETS2_ELEC"


def evaluate_dependencies_and_d30(
    d30_status: str,
    dependency_flags: str | list[str] | None,
    rules: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Evaluate whether third-party dependencies and D30 status block rebooking."""
    rules = rules or load_rules()
    d30_cfg = rules.get("d30", {})
    dep_cfg = rules.get("dependencies", {})

    clear_d30 = {str(s).upper() for s in d30_cfg.get("clear_statuses", ["CLEAR", "COMPLETE", "NOT_REQUIRED"])}
    blocking_d30 = {str(s).upper() for s in d30_cfg.get("blocking_statuses", [])}
    blocking_deps = {str(f).upper() for f in dep_cfg.get("blocking_flags", [])}

    norm_d30 = (d30_status or "CLEAR").strip().upper()
    if isinstance(dependency_flags, str):
        raw_flags = [f.strip().upper() for f in dependency_flags.split(",") if f.strip()]
    else:
        raw_flags = [str(f).strip().upper() for f in (dependency_flags or []) if str(f).strip()]
    active_flags = [f for f in raw_flags if f != "NONE"]

    blockers: list[str] = []
    if norm_d30 in blocking_d30 or (norm_d30 and norm_d30 not in clear_d30):
        blockers.append(f"D30 workflow status is '{norm_d30}' (not clear)")

    flagged_blockers = [f for f in active_flags if f in blocking_deps]
    if flagged_blockers:
        blockers.append(f"Blocking third-party dependencies: {', '.join(flagged_blockers)}")

    is_clear = len(blockers) == 0
    return {
        "clear": is_clear,
        "blocked": not is_clear,
        "d30_status": norm_d30,
        "dependency_flags": active_flags or ["NONE"],
        "blocking_reasons": blockers,
        "summary": "All D30 and third-party dependency checks cleared." if is_clear else "; ".join(blockers),
    }


def evaluate_dno_flow(
    job_type: str,
    reason: str,
    dno_status: str | None = None,
    rules: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Determine DNO involvement and current status:
    NOT_REQUIRED, COMPLETE, PENDING, or BLOCKED.
    """
    rules = rules or load_rules()
    dno_cfg = rules.get("dno", {})

    req_types = {str(t).upper() for t in dno_cfg.get("job_types_requiring_dno", [])}
    req_reasons = {str(r).strip().lower() for r in dno_cfg.get("reasons_requiring_dno", [])}
    clear_statuses = {str(s).upper() for s in dno_cfg.get("clear_statuses", ["NOT_REQUIRED", "COMPLETE"])}
    pending_statuses = {str(s).upper() for s in dno_cfg.get("pending_statuses", ["PENDING"])}
    blocking_statuses = {str(s).upper() for s in dno_cfg.get("blocking_statuses", ["BLOCKED"])}
    lead_days = int(dno_cfg.get("default_lead_time_days", 7))

    norm_type = (job_type or "").strip().upper()
    norm_reason = (reason or "").strip().lower()
    norm_status = (dno_status or "").strip().upper()

    needs_dno = (
        norm_type in req_types
        or norm_reason in req_reasons
        or norm_status in (pending_statuses | blocking_statuses | {"COMPLETE"})
    )

    if not needs_dno:
        resolved = "NOT_REQUIRED"
    elif norm_status in blocking_statuses:
        resolved = "BLOCKED"
    elif norm_status in pending_statuses:
        resolved = "PENDING"
    elif norm_status == "COMPLETE":
        resolved = "COMPLETE"
    elif norm_status in clear_statuses and norm_status != "NOT_REQUIRED":
        resolved = norm_status
    else:
        # Job requires DNO by rule and has not yet completed -> PENDING
        resolved = "PENDING" if needs_dno and norm_status in ("", "NOT_REQUIRED") else (norm_status or "PENDING")

    return {
        "dno_required": needs_dno,
        "dno_status": resolved,
        "default_lead_time_days": lead_days if resolved == "PENDING" else 0,
        "requires_request": resolved == "PENDING",
        "blocked": resolved == "BLOCKED",
        "clear": resolved in clear_statuses,
    }


def compute_sla_due_date(
    job_type: str,
    reason: str,
    anchor_date: date | None = None,
    explicit_sla_date: str | None = None,
    rules: dict[str, Any] | None = None,
) -> str:
    """Return ISO SLA due date from explicit override or configured rule defaults."""
    if explicit_sla_date:
        return str(explicit_sla_date)[:10]

    rules = rules or load_rules()
    sla_cfg = rules.get("sla", {})
    urgent = {str(k).strip().lower(): int(v) for k, v in sla_cfg.get("urgent_reasons_days", {}).items()}
    by_type = {str(k).upper(): int(v) for k, v in sla_cfg.get("default_days_by_job_type", {}).items()}

    base = anchor_date or date.today()
    reason_key = (reason or "").strip().lower()
    if reason_key in urgent:
        days = urgent[reason_key]
    else:
        days = by_type.get((job_type or "EXCHANGE").upper(), 14)
    return (base + timedelta(days=days)).isoformat()
