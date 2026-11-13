"""
IMSERV Platform — Monthly Rolling Data Refresh
================================================
Run this script on the 1st of every month (or on each app startup in production)
to keep all CSVs aligned with the rolling 12-month actuals window.

It checks whether regeneration is needed BEFORE touching any files, so it is
safe to schedule to run daily — it only writes when the anchor has changed.

Usage
-----
    python scripts/refresh_data.py              # check + regenerate if needed
    python scripts/refresh_data.py --force      # always regenerate (all files)
    python scripts/refresh_data.py --status     # print status and exit (no writes)

Schedule examples
-----------------
    # Linux / macOS cron (1st of every month at 00:05)
    5 0 1 * * /path/to/venv/bin/python /path/to/project/scripts/refresh_data.py

    # Windows Task Scheduler: run monthly, action = python scripts/refresh_data.py

    # Render Cron Job (render.yaml):
    #   - type: cron
    #     name: monthly-data-refresh
    #     schedule: "5 0 1 * *"
    #     command: python scripts/refresh_data.py
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, datetime, UTC
from pathlib import Path

# ── Make sure project root is on sys.path ─────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from engine.date_windows import (
    rolling_actual_window,
    rolling_forecast_window,
    rolling_generation_profile,
    parse_iso_date,
    week_start,
)

INPUTS_DIR  = PROJECT_ROOT / "data" / "inputs"
MANIFEST    = INPUTS_DIR / "manifest.json"
LOCK_FILE   = INPUTS_DIR / ".refresh.lock"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _read_manifest() -> dict:
    if not MANIFEST.exists():
        return {}
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _anchor_stale(current_anchor: str) -> bool:
    """Return True if manifest anchor differs from today's anchor."""
    return _read_manifest().get("rolling_anchor_month") != current_anchor


def _csv_dates_stale(actual_start: date, actual_end: date, forecast_start: date) -> bool:
    """
    Spot-check key CSVs for date-range coverage.
    Returns True (stale) if any check fails.
    """
    import csv

    # (path, date_field, requires_forecast_rows)
    checks = [
        (INPUTS_DIR / "master_operations.csv",       "requested_date", True),
        (INPUTS_DIR / "booking_journey.csv",          "week_start",     False),
        (INPUTS_DIR / "forecast_baseline_2025.csv",   "forecast_date",  False),
    ]

    for path, date_field, need_forecast in checks:
        if not path.exists():
            print(f"  [MISSING] {path.name}")
            return True

        has_actual   = False
        has_forecast = not need_forecast   # skip forecast check when not required
        valid_start = week_start(actual_start) if date_field == "week_start" else actual_start
        try:
            with open(path, encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    d = parse_iso_date(row.get(date_field, ""))
                    if d is None:
                        continue
                    if valid_start <= d <= actual_end:
                        has_actual = True
                    if not has_forecast and d >= forecast_start:
                        has_forecast = True
                    if has_actual and has_forecast:
                        break
        except Exception as e:
            print(f"  [ERROR] reading {path.name}: {e}")
            return True

        if not has_actual:
            print(f"  [STALE]  {path.name} -- no rows inside actuals window {actual_start} to {actual_end}")
            return True
        if not has_forecast:
            print(f"  [STALE]  {path.name} -- no forecast rows from {forecast_start}")
            return True

    return False


def _needs_refresh(current_anchor: str, actual_start: date, actual_end: date, forecast_start: date) -> bool:
    """Return True if any staleness condition is detected."""
    if not MANIFEST.exists() or not (INPUTS_DIR / "master_operations.csv").exists():
        print("  CSVs are missing — full generation required.")
        return True

    if _anchor_stale(current_anchor):
        stored = _read_manifest().get("rolling_anchor_month", "none")
        print(f"  Anchor stale: manifest={stored}, current={current_anchor}")
        return True

    if _csv_dates_stale(actual_start, actual_end, forecast_start):
        print("  CSV date-range check detected out-of-window data.")
        return True

    return False


# ─────────────────────────────────────────────────────────────────────────────
# Lock
# ─────────────────────────────────────────────────────────────────────────────

def _acquire_lock(timeout: int = 600) -> bool:
    INPUTS_DIR.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout
    while True:
        try:
            fd = __import__("os").open(
                str(LOCK_FILE),
                __import__("os").O_CREAT | __import__("os").O_EXCL | __import__("os").O_WRONLY,
            )
            with __import__("os").fdopen(fd, "w") as lf:
                lf.write(f"pid={__import__('os').getpid()}\nstarted={datetime.utcnow().isoformat()}Z\n")
            return True
        except FileExistsError:
            try:
                import os
                age = time.time() - LOCK_FILE.stat().st_mtime
                if age > timeout:
                    LOCK_FILE.unlink()
                    continue
            except OSError:
                pass
            if time.time() >= deadline:
                return False
            time.sleep(2)


def _release_lock() -> None:
    try:
        LOCK_FILE.unlink()
    except OSError:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Status printer
# ─────────────────────────────────────────────────────────────────────────────

def print_status() -> None:
    profile        = rolling_generation_profile()
    current_anchor = profile["anchor_month"]
    actual_start, actual_end     = rolling_actual_window()
    forecast_start, forecast_end = rolling_forecast_window()
    manifest_data  = _read_manifest()

    sep = "-" * 60
    print(sep)
    print("IMSERV Data Refresh -- Status Report")
    print(sep)
    print(f"  Today             : {date.today()}")
    print(f"  Current anchor    : {current_anchor}")
    print(f"  Manifest anchor   : {manifest_data.get('rolling_anchor_month', 'NOT FOUND')}")
    print(f"  Actuals window    : {actual_start}  to  {actual_end}")
    print(f"  Forecast window   : {forecast_start}  to  {forecast_end}")
    print()
    print("  CSV date-range checks:")
    import csv
    csv_checks = {
        "master_operations.csv":      ("requested_date", actual_start, actual_end),
        "booking_journey.csv":        ("week_start",     week_start(actual_start), actual_end),
        "channel_volume.csv":         ("contact_date",   actual_start, actual_end),
        "forecast_baseline_2025.csv": ("forecast_date",  actual_start, actual_end),
        "field_engineers.csv":        ("year",           None,         None),
    }
    for fname, (field, ws, we) in csv_checks.items():
        path = INPUTS_DIR / fname
        if not path.exists():
            print(f"    [MISSING]       {fname}")
            continue
        if ws is None:
            # field_engineers: check year column contains a year in the actuals range
            found = False
            with open(path, encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    yr = row.get(field, "")
                    if yr in (str(actual_start.year), str(actual_end.year)):
                        found = True
                        break
            status = "[OK]  in window" if found else "[STALE] out of window"
            print(f"    {status:<20s}  {fname}")
            continue
        found = False
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                d = parse_iso_date(row.get(field, ""))
                if d and ws <= d <= we:
                    found = True
                    break
        status = "[OK]  in window" if found else "[STALE] out of window"
        print(f"    {status:<20s}  {fname}")

    stale = _needs_refresh(current_anchor, actual_start, actual_end, forecast_start)
    print()
    print(f"  Refresh needed    : {'YES' if stale else 'NO -- all CSVs are aligned'}")
    print(sep)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="IMSERV monthly data refresh - checks and rolls CSV dates without regenerating data."
    )
    parser.add_argument(
        "--force",  action="store_true",
        help="Roll CSV dates unconditionally (ignores staleness check).",
    )
    parser.add_argument(
        "--status", action="store_true",
        help="Print staleness status and exit without writing any files.",
    )
    args = parser.parse_args()

    profile        = rolling_generation_profile()
    current_anchor = profile["anchor_month"]
    actual_start, actual_end     = rolling_actual_window()
    forecast_start, _            = rolling_forecast_window()

    print(f"IMSERV Data Refresh  |  anchor={current_anchor}  |  {datetime.now(UTC).isoformat()}")

    if args.status:
        print_status()
        return

    if not args.force and not _needs_refresh(current_anchor, actual_start, actual_end, forecast_start):
        print(f"  CSVs are already aligned to {current_anchor}. Nothing to do.")
        return

    reason = "forced by --force flag" if args.force else f"data stale for anchor {current_anchor}"
    print(f"  Generating data and replacing CSV files ({reason})...")

    if not _acquire_lock():
        print("  ERROR: Could not acquire refresh lock within timeout. Another process may be running.")
        sys.exit(1)

    t0 = time.time()
    try:
        from engine.data_generator import generate_all
        generate_all()

        try:
            from scripts.augment_rebooking_data import generate_rebooking_datasets
            generate_rebooking_datasets()
        except Exception as aug_err:
            print(f"  Warning during rebooking augmentation: {aug_err}")

        try:
            from engine.ingestion import build_sqlite_store
            build_sqlite_store(force=True)
            from engine.rebooking_store import seed_initial_data
            seed_initial_data(force=True)
        except Exception as ing_err:
            print(f"  Warning during SQLite store build: {ing_err}")

        elapsed = round(time.time() - t0, 1)
        print(f"\n  Done in {elapsed}s. All CSVs now cover:")
        print(f"    Actuals  : {actual_start} – {actual_end}")
        forecast_start2, forecast_end2 = rolling_forecast_window()
        print(f"    Forecast : {forecast_start2} – {forecast_end2}")
    except Exception as exc:
        print(f"\n  ERROR during data generation: {exc}")
        sys.exit(1)
    finally:
        _release_lock()


if __name__ == "__main__":
    main()
