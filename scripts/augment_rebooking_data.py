"""
Reproducible seed and augmentation script for the Rebooking Agent.

Reads existing master_operations.csv and engineers.csv WITHOUT altering them,
and generates two cleanly separated operational datasets:
  - data/inputs/rebooking_jobs.csv
  - data/inputs/rebooking_slots_28d.csv

Fixed RANDOM_SEED = 42 ensures deterministic synthetic augmentation for:
  - DNO status, D36 workflow status, third-party dependency flags
  - Customer contact preference & preferred time of day (synthetic aliases only)
  - SLA due dates and Priority Services Register (vulnerability) flags
  - Forward 28-day engineer-slot availability & regional daily utilisation
  - Six guaranteed demo scenarios (a)-(f)
"""
from __future__ import annotations

import csv
import random
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from engine.rules_loader import compute_sla_due_date, load_rules, required_skill_for_job

RANDOM_SEED = 42
INPUTS_DIR = BASE_DIR / "data" / "inputs"

DEMO_SCENARIOS = [
    {
        "job_ref": "RBK-DEMO-A",
        "scenario_tag": "A_CLEAN_REBOOK",
        "scenario_label": "(a) Clean Rebook",
        "supplier_name": "Octopus Energy Limited",
        "region_code": "NW",
        "region_name": "North West",
        "patch_code": "NW-P1",
        "primary_channel": "SMS",
        "contact_preference": "SMS",
        "preferred_time_of_day": "Morning",
        "meter_type": "SMETS2",
        "job_type": "EXCHANGE",
        "required_skill": "SMETS2_ELEC",
        "original_status": "Cancelled",
        "status": "Cancelled",
        "cancellation_reason": "Customer not home",
        "abort_reason": "",
        "original_engineer_id": "ENG-NW-002",
        "customer_alias": "Customer #A101",
        "sla_days_offset": 10,
        "d36_status": "CLEAR",
        "d30_status": "CLEAR",
        "dependency_flags": "NONE",
        "dno_status": "NOT_REQUIRED",
        "is_vulnerable": "0",
        "vulnerability_reason": "",
    },
    {
        "job_ref": "RBK-DEMO-B",
        "scenario_tag": "B_HIGH_UTILISATION",
        "scenario_label": "(b) High Utilisation (Later Slot)",
        "supplier_name": "Centrica Plc",
        "region_code": "SE",
        "region_name": "South East",
        "patch_code": "SE-P2",
        "primary_channel": "Phone",
        "contact_preference": "Phone",
        "preferred_time_of_day": "Afternoon",
        "meter_type": "SMETS2",
        "job_type": "EXCHANGE",
        "required_skill": "SMETS2_ELEC",
        "original_status": "Aborted",
        "status": "Aborted",
        "cancellation_reason": "",
        "abort_reason": "No access",
        "original_engineer_id": "ENG-SE-001",
        "customer_alias": "Customer #B204",
        "sla_days_offset": 12,
        "d36_status": "CLEAR",
        "d30_status": "CLEAR",
        "dependency_flags": "NONE",
        "dno_status": "NOT_REQUIRED",
        "is_vulnerable": "0",
        "vulnerability_reason": "",
    },
    {
        "job_ref": "RBK-DEMO-C",
        "scenario_tag": "C_DNO_PENDING",
        "scenario_label": "(c) DNO Pending (Lead Time)",
        "supplier_name": "E.ON Next Energy Limited",
        "region_code": "NE",
        "region_name": "North East",
        "patch_code": "NE-P1",
        "primary_channel": "Web",
        "contact_preference": "Email",
        "preferred_time_of_day": "Morning",
        "meter_type": "SMETS2_GAS",
        "job_type": "NEW_INSTALL",
        "required_skill": "DUAL_FUEL",
        "original_status": "Cancelled",
        "status": "Cancelled",
        "cancellation_reason": "Safety concern",
        "abort_reason": "",
        "original_engineer_id": "ENG-NE-001",
        "customer_alias": "Customer #C309",
        "sla_days_offset": 18,
        "d36_status": "CLEAR",
        "d30_status": "CLEAR",
        "dependency_flags": "NONE",
        "dno_status": "PENDING",
        "is_vulnerable": "0",
        "vulnerability_reason": "",
    },
    {
        "job_ref": "RBK-DEMO-D",
        "scenario_tag": "D_BLOCKED_D36_DEP",
        "scenario_label": "(d) Blocked by D36 / Dependency",
        "supplier_name": "EDF Energy Customers Ltd",
        "region_code": "YRK",
        "region_name": "Yorkshire",
        "patch_code": "YRK-P2",
        "primary_channel": "Phone",
        "contact_preference": "Phone",
        "preferred_time_of_day": "Morning",
        "meter_type": "SMETS1",
        "job_type": "REPAIR",
        "required_skill": "SMETS_REPAIR",
        "original_status": "Aborted",
        "status": "Aborted",
        "cancellation_reason": "",
        "abort_reason": "Parts not available",
        "original_engineer_id": "ENG-YRK-001",
        "customer_alias": "Customer #D412",
        "sla_days_offset": 7,
        "d36_status": "DATA_MISMATCH",
        "d30_status": "DATA_MISMATCH",
        "dependency_flags": "ASBESTOS_CHECK",
        "dno_status": "NOT_REQUIRED",
        "is_vulnerable": "0",
        "vulnerability_reason": "",
    },
    {
        "job_ref": "RBK-DEMO-E",
        "scenario_tag": "E_NO_SLOT_WITHIN_SLA",
        "scenario_label": "(e) No Slot Within SLA",
        "supplier_name": "OVO Energy Ltd",
        "region_code": "WAL",
        "region_name": "Wales",
        "patch_code": "WAL-P1",
        "primary_channel": "App",
        "contact_preference": "App",
        "preferred_time_of_day": "Afternoon",
        "meter_type": "SMETS2",
        "job_type": "REPAIR",
        "required_skill": "SMETS_REPAIR",
        "original_status": "Cancelled",
        "status": "Cancelled",
        "cancellation_reason": "Customer refused",
        "abort_reason": "",
        "original_engineer_id": "ENG-WAL-001",
        "customer_alias": "Customer #E515",
        "sla_days_offset": 2,
        "d36_status": "CLEAR",
        "d30_status": "CLEAR",
        "dependency_flags": "NONE",
        "dno_status": "NOT_REQUIRED",
        "is_vulnerable": "0",
        "vulnerability_reason": "",
    },
    {
        "job_ref": "RBK-DEMO-F",
        "scenario_tag": "F_VULNERABLE_CUSTOMER",
        "scenario_label": "(f) Vulnerable Customer (PSR)",
        "supplier_name": "ScottishPower Energy Retail Ltd",
        "region_code": "SW",
        "region_name": "South West",
        "patch_code": "SW-P1",
        "primary_channel": "Phone",
        "contact_preference": "Phone",
        "preferred_time_of_day": "Morning",
        "meter_type": "SMETS2",
        "job_type": "EXCHANGE",
        "required_skill": "SMETS2_ELEC",
        "original_status": "Aborted",
        "status": "Aborted",
        "cancellation_reason": "",
        "abort_reason": "Customer unavailable",
        "original_engineer_id": "ENG-SW-001",
        "customer_alias": "Customer #F620",
        "sla_days_offset": 10,
        "d36_status": "CLEAR",
        "d30_status": "CLEAR",
        "dependency_flags": "NONE",
        "dno_status": "NOT_REQUIRED",
        "is_vulnerable": "1",
        "vulnerability_reason": "Priority Services Register (PSR) - Medical Equipment",
    },
]

JOB_FIELDNAMES = [
    "job_ref",
    "scenario_tag",
    "scenario_label",
    "supplier_name",
    "region_code",
    "region_name",
    "patch_code",
    "primary_channel",
    "contact_preference",
    "preferred_time_of_day",
    "meter_type",
    "job_type",
    "required_skill",
    "original_status",
    "status",
    "requested_date",
    "booked_date",
    "sla_due_date",
    "cancellation_reason",
    "abort_reason",
    "original_engineer_id",
    "customer_alias",
    "d36_status",
    "d30_status",
    "dependency_flags",
    "dno_status",
    "dno_ref",
    "is_vulnerable",
    "vulnerability_reason",
]

SLOT_FIELDNAMES = [
    "slot_id",
    "slot_date",
    "day_offset",
    "day_of_week",
    "time_window",
    "window_hours",
    "region_code",
    "region_name",
    "patch_code",
    "engineer_id",
    "engineer_name",
    "skills",
    "supplier_affiliation",
    "slot_capacity",
    "slot_booked",
    "slot_available",
    "regional_utilisation_pct",
]

_SUPPLIERS_DEFAULT = [
    "Octopus Energy Limited",
    "Centrica Plc",
    "E.ON Next Energy Limited",
    "EDF Energy Customers Ltd",
    "OVO Energy Ltd",
    "ScottishPower Energy Retail Ltd",
]

_PREF_CHANNEL_MAP = {
    "Phone": "Phone",
    "SMS": "SMS",
    "Web": "Email",
    "App": "App",
    "IVR": "Phone",
    "Agent Callback": "Phone",
}

_SKILL_POOL = [
    "SMETS2_ELEC",
    "DUAL_FUEL",
    "SMETS2_INSTALL",
    "SMETS_REPAIR",
    "IHD_TECH",
]


def _load_engineers() -> dict[str, list[dict]]:
    path = INPUTS_DIR / "engineers.csv"
    by_region: dict[str, list[dict]] = defaultdict(list)
    if path.exists():
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                rc = row.get("region_code", "").strip()
                if rc:
                    by_region[rc].append(row)
    return by_region


def _sample_master_fallout_jobs(limit_per_region: int = 3) -> list[dict]:
    """Read a balanced sample of Cancelled/Aborted actual jobs from master_operations.csv."""
    path = INPUTS_DIR / "master_operations.csv"
    if not path.exists():
        return []

    by_region: dict[str, list[dict]] = defaultdict(list)
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("is_forecast", "0") != "0":
                continue
            if row.get("status") not in {"Cancelled", "Aborted"}:
                continue
            rc = row.get("region_code", "").strip()
            if rc and len(by_region[rc]) < limit_per_region * 5:
                by_region[rc].append(row)

    sampled: list[dict] = []
    for rc in sorted(by_region.keys()):
        candidates = by_region[rc]
        # Prefer a mix of Cancelled and Aborted
        cancels = [r for r in candidates if r.get("status") == "Cancelled"][:limit_per_region]
        aborts = [r for r in candidates if r.get("status") == "Aborted"][:max(1, limit_per_region - 1)]
        sampled.extend((cancels + aborts)[:limit_per_region])
    return sampled


def generate_rebooking_datasets(anchor_date: date | None = None) -> dict[str, int]:
    """Generate rebooking_jobs.csv and rebooking_slots_28d.csv deterministically."""
    INPUTS_DIR.mkdir(parents=True, exist_ok=True)
    rng = random.Random(RANDOM_SEED)
    rules = load_rules()
    today = anchor_date or date.today()
    horizon_days = int(rules.get("capacity_and_ranking", {}).get("horizon_days", 28))
    window_hours_map = rules.get("capacity_and_ranking", {}).get(
        "time_windows",
        {"Morning": "08:00 - 12:00", "Afternoon": "12:00 - 16:00", "Evening": "16:00 - 20:00"},
    )

    # ── 1. Build rebooking_jobs.csv ───────────────────────────────────────────
    jobs_out: list[dict] = []
    for idx, demo in enumerate(DEMO_SCENARIOS, start=1):
        sla_due = (today + timedelta(days=demo["sla_days_offset"])).isoformat()
        jobs_out.append({
            "job_ref": demo["job_ref"],
            "scenario_tag": demo["scenario_tag"],
            "scenario_label": demo["scenario_label"],
            "supplier_name": demo["supplier_name"],
            "region_code": demo["region_code"],
            "region_name": demo["region_name"],
            "patch_code": demo["patch_code"],
            "primary_channel": demo["primary_channel"],
            "contact_preference": demo["contact_preference"],
            "preferred_time_of_day": demo["preferred_time_of_day"],
            "meter_type": demo["meter_type"],
            "job_type": demo["job_type"],
            "required_skill": demo["required_skill"],
            "original_status": demo["original_status"],
            "status": demo["status"],
            "requested_date": (today - timedelta(days=6 + idx)).isoformat(),
            "booked_date": (today - timedelta(days=1)).isoformat(),
            "sla_due_date": sla_due,
            "cancellation_reason": demo["cancellation_reason"],
            "abort_reason": demo["abort_reason"],
            "original_engineer_id": demo["original_engineer_id"],
            "customer_alias": demo["customer_alias"],
            "d36_status": demo.get("d36_status") or demo.get("d30_status", "CLEAR"),
            "d30_status": demo.get("d36_status") or demo.get("d30_status", "CLEAR"),
            "dependency_flags": demo["dependency_flags"],
            "dno_status": demo["dno_status"],
            "dno_ref": "",
            "is_vulnerable": demo["is_vulnerable"],
            "vulnerability_reason": demo["vulnerability_reason"],
        })

    sampled = _sample_master_fallout_jobs(limit_per_region=3)
    for idx, raw in enumerate(sampled, start=1):
        job_type = raw.get("job_type") or "EXCHANGE"
        meter_type = raw.get("meter_type") or "SMETS2"
        reason = raw.get("cancellation_reason") or raw.get("abort_reason") or "Customer not home"
        channel = raw.get("primary_channel") or "Phone"
        pref_channel = _PREF_CHANNEL_MAP.get(channel, "SMS")
        pref_window = rng.choice(["Morning", "Afternoon", "Evening"])

        # Weighted synthetic D36/dependency/DNO/PSR realism
        d36_roll = rng.random()
        d36_status = "CLEAR" if d36_roll < 0.85 else rng.choice(["PENDING_SUPPLIER", "REJECTED", "DATA_MISMATCH"])

        dep_roll = rng.random()
        dep_flag = "NONE" if dep_roll < 0.86 else rng.choice(["LANDLORD_CONSENT", "SCAFFOLDING", "ASBESTOS_CHECK"])

        if job_type in {"NEW_INSTALL", "REMOVAL"}:
            dno_status = rng.choices(["COMPLETE", "PENDING", "BLOCKED"], weights=[0.55, 0.35, 0.10])[0]
        else:
            dno_status = "NOT_REQUIRED"

        is_vuln = "1" if rng.random() < 0.10 else "0"
        vuln_reason = "Priority Services Register (PSR) - Assisted Access" if is_vuln == "1" else ""
        sla_due = compute_sla_due_date(job_type, reason, anchor_date=today, rules=rules)

        jobs_out.append({
            "job_ref": raw.get("job_ref") or f"IMSERV-RBK-{idx:04d}",
            "scenario_tag": "STANDARD",
            "scenario_label": "Standard Queue",
            "supplier_name": raw.get("supplier_name") or rng.choice(_SUPPLIERS_DEFAULT),
            "region_code": raw.get("region_code") or "NW",
            "region_name": raw.get("region_name") or "North West",
            "patch_code": raw.get("patch_code") or "NW-P1",
            "primary_channel": channel,
            "contact_preference": pref_channel,
            "preferred_time_of_day": pref_window,
            "meter_type": meter_type,
            "job_type": job_type,
            "required_skill": required_skill_for_job(job_type, meter_type),
            "original_status": raw.get("status") or "Cancelled",
            "status": raw.get("status") or "Cancelled",
            "requested_date": raw.get("requested_date") or (today - timedelta(days=5)).isoformat(),
            "booked_date": raw.get("booked_date") or (today - timedelta(days=1)).isoformat(),
            "sla_due_date": sla_due,
            "cancellation_reason": raw.get("cancellation_reason", ""),
            "abort_reason": raw.get("abort_reason", ""),
            "original_engineer_id": raw.get("engineer_id") or "",
            "customer_alias": f"Customer #{1000 + idx}",
            "d36_status": d36_status,
            "d30_status": d36_status,
            "dependency_flags": dep_flag,
            "dno_status": dno_status,
            "dno_ref": "",
            "is_vulnerable": is_vuln,
            "vulnerability_reason": vuln_reason,
        })

    jobs_path = INPUTS_DIR / "rebooking_jobs.csv"
    with open(jobs_path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=JOB_FIELDNAMES)
        writer.writeheader()
        writer.writerows(jobs_out)

    # ── 2. Build rebooking_slots_28d.csv ──────────────────────────────────────
    engineers_by_region = _load_engineers()
    slots_out: list[dict] = []

    for rc, eng_list in sorted(engineers_by_region.items()):
        # Use up to 6 representative engineers per region for crisp 28-day slot matrix
        selected_engs = eng_list[:6]
        if not selected_engs:
            continue

        for day_offset in range(1, horizon_days + 1):
            slot_date = today + timedelta(days=day_offset)
            day_str = slot_date.isoformat()
            dow = slot_date.strftime("%A")
            is_weekend = slot_date.weekday() >= 5

            # Shape regional daily utilisation cleanly for realistic & demo scenarios
            if rc == "SE" and day_offset <= 4:
                # Scenario (b): SE Days 1-4 intentionally >90% threshold
                reg_util = round(92.5 + rng.uniform(0.5, 4.5), 1)
            elif rc == "SE" and day_offset >= 5:
                reg_util = round(72.0 + rng.uniform(0.0, 9.5), 1)
            elif rc == "WAL" and day_offset <= 2:
                # Scenario (e): WAL Days 1-2 have 0 compliant slots (100% / over threshold)
                reg_util = 98.5
            elif rc == "WAL" and 4 <= day_offset <= 7:
                reg_util = round(68.0 + rng.uniform(0.0, 10.0), 1)
            elif is_weekend:
                reg_util = round(84.0 + rng.uniform(0.0, 9.0), 1)
            else:
                reg_util = round(64.0 + rng.uniform(0.0, 19.0), 1)

            for eng_idx, eng in enumerate(selected_engs):
                eng_id = eng["engineer_id"]
                eng_name = eng.get("name") or f"Engineer {eng_id}"
                reg_name = eng.get("region_name") or rc
                patch_code = eng.get("patch_code") or f"{rc}-P1"

                # Guarantee full skill coverage across region engineers
                if eng_idx == 0:
                    skills = "SMETS2_ELEC,DUAL_FUEL,SMETS2_INSTALL,SMETS_REPAIR,IHD_TECH"
                elif eng_idx == 1:
                    skills = "SMETS2_ELEC,SMETS_REPAIR,SMETS2_INSTALL"
                elif eng_idx == 2:
                    skills = "DUAL_FUEL,SMETS2_ELEC,IHD_TECH"
                else:
                    chosen = rng.sample(_SKILL_POOL, k=3)
                    skills = ",".join(sorted(chosen))

                supplier_aff = _SUPPLIERS_DEFAULT[(eng_idx + len(rc)) % len(_SUPPLIERS_DEFAULT)]
                if rc == "SE" and eng_id == "ENG-SE-001":
                    supplier_aff = "Centrica Plc"

                for window in ("Morning", "Afternoon", "Evening"):
                    if is_weekend and window == "Evening":
                        continue

                    cap = 2
                    if rc == "WAL" and day_offset <= 2:
                        # Zero availability within 2-day SLA in WAL for Scenario (e)
                        booked = cap
                    elif rc == "SE" and day_offset <= 4:
                        # Slots exist but regional utilisation is >90%
                        booked = 1
                    elif is_weekend:
                        booked = 1 if rng.random() < 0.6 else 2
                    else:
                        # Guarantee open slots on demo windows so (a), (b), (c), (e), (f) never starve
                        if (
                            (rc == "NW" and day_offset in (1, 2, 3) and window == "Morning")
                            or (rc == "SE" and day_offset >= 5 and window == "Afternoon" and eng_idx in (1, 2))
                            or (rc == "NE" and day_offset >= 7 and window == "Morning" and eng_idx == 0)
                            or (rc == "WAL" and day_offset in (4, 5, 6) and eng_idx in (0, 1))
                            or (rc == "SW" and day_offset in (1, 2, 3) and window == "Morning" and eng_idx == 0)
                        ):
                            booked = 0
                        else:
                            booked = rng.choices([0, 1, 2], weights=[0.45, 0.35, 0.20])[0]

                    avail = max(cap - booked, 0)
                    slot_id = f"SLOT-{rc}-{day_str}-{window[:1]}-{eng_id}"
                    slots_out.append({
                        "slot_id": slot_id,
                        "slot_date": day_str,
                        "day_offset": day_offset,
                        "day_of_week": dow,
                        "time_window": window,
                        "window_hours": window_hours_map.get(window, ""),
                        "region_code": rc,
                        "region_name": reg_name,
                        "patch_code": patch_code,
                        "engineer_id": eng_id,
                        "engineer_name": eng_name,
                        "skills": skills,
                        "supplier_affiliation": supplier_aff,
                        "slot_capacity": cap,
                        "slot_booked": booked,
                        "slot_available": avail,
                        "regional_utilisation_pct": reg_util,
                    })

    slots_path = INPUTS_DIR / "rebooking_slots_28d.csv"
    with open(slots_path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=SLOT_FIELDNAMES)
        writer.writeheader()
        writer.writerows(slots_out)

    return {"jobs": len(jobs_out), "slots": len(slots_out)}


if __name__ == "__main__":
    counts = generate_rebooking_datasets()
    print(f"Rebooking datasets generated: {counts['jobs']} jobs, {counts['slots']} 28-day slots.")
