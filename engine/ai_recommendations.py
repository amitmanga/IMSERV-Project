"""
EXL Platform — AI Recommendation Engine
Generates intelligent operational recommendations from cross-module signals.
Produces prioritised alerts for the executive dashboard.
"""
from datetime import date

from engine.ingestion import get_capacity_demand, to_float, to_int
from engine.cancellation_engine import get_regional_cancellation_heatmap
from engine.field_ops_engine import predict_understaffing
from engine.financial_engine import get_financial_kpis

# ─────────────────────────────────────────────────────────────────────────────

REGIONS = ["NW", "NE", "MID", "SE", "SW", "WAL", "SCO", "YRK"]

PRIORITY_ORDER = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}


# ─── Recommendation Builders ──────────────────────────────────────────────────

def _capacity_alerts(year: int = 2025) -> list:
    """Identify regions with critical capacity shortfalls."""
    alerts = []
    capacity = get_capacity_demand()
    capacity = [r for r in capacity if to_int(r.get("year")) == year]

    by_region: dict = {}
    for r in capacity:
        rc = r["region_code"]
        if rc not in by_region:
            by_region[rc] = []
        by_region[rc].append(to_float(r["utilisation_pct"]))

    for rc, utils in by_region.items():
        if not utils:
            continue
        avg_util = sum(utils) / len(utils)
        red_weeks = sum(1 for u in utils if u > 90)
        if avg_util > 85:
            alerts.append({
                "type":           "capacity_alert",
                "priority":       "Critical" if avg_util > 90 else "High",
                "region_code":    rc,
                "title":          f"Capacity Risk — {rc} Region",
                "body":           f"Average utilisation {round(avg_util, 1)}% with {red_weeks} weeks >90%."
                                  f" Immediate workforce rebalancing recommended.",
                "metric_value":   round(avg_util, 1),
                "metric_label":   "Avg Utilisation %",
                "action_required":True,
            })
    return alerts


def _cancellation_alerts(year: int = 2025) -> list:
    """Flag regions with high or rising cancellation rates."""
    alerts = []
    try:
        regional = get_regional_cancellation_heatmap(year)
    except Exception:
        return alerts

    for kpis in regional:
        rc = kpis["region_code"]
        cr = kpis["cancel_rate"]
        ar = kpis["abort_rate"]
        if cr > 18:
            alerts.append({
                "type":           "cancellation_risk",
                "priority":       "Critical",
                "region_code":    rc,
                "title":          f"High Cancellation Rate - {rc}",
                "body":           f"{rc} cancellation rate at {cr}% (threshold: 18%). "
                                  f"Abort rate: {ar}%. Investigate root causes immediately.",
                "metric_value":   cr,
                "metric_label":   "Cancellation %",
                "action_required":True,
            })
        elif cr > 14:
            alerts.append({
                "type":           "cancellation_risk",
                "priority":       "High",
                "region_code":    rc,
                "title":          f"Elevated Cancellation Rate - {rc}",
                "body":           f"{rc} cancellation rate at {cr}%. Monitor closely and "
                                  f"consider pre-visit confirmation programme.",
                "metric_value":   cr,
                "metric_label":   "Cancellation %",
                "action_required":False,
            })
    return alerts


def _financial_alerts(year: int = 2025) -> list:
    """Flag regions or job types with deteriorating margin."""
    alerts = []
    try:
        kpis = get_financial_kpis(year=year)
        margin_pct = kpis["margin_pct"]
        cpp        = kpis["avg_cost_per_completion"]

        if margin_pct < 15:
            alerts.append({
                "type":           "financial_risk",
                "priority":       "Critical" if margin_pct < 10 else "High",
                "region_code":    None,
                "title":          "Margin Below Target",
                "body":           f"Overall margin at {margin_pct}% — below 15% threshold. "
                                  f"Average cost per completion £{cpp}. "
                                  f"Review engineer productivity and job mix.",
                "metric_value":   margin_pct,
                "metric_label":   "Margin %",
                "action_required": margin_pct < 10,
            })

        # Flag low-margin job types
        for jt in kpis.get("job_type_breakdown", []):
            if jt["margin_pct"] < 10:
                alerts.append({
                    "type":           "financial_risk",
                    "priority":       "Medium",
                    "region_code":    None,
                    "title":          f"Low Margin — {jt['job_type']}",
                    "body":           f"{jt['job_type']} delivering only {jt['margin_pct']}% margin. "
                                      f"Review pricing or cost model for this job type.",
                    "metric_value":   jt["margin_pct"],
                    "metric_label":   "Margin %",
                    "action_required":False,
                })
    except Exception:
        pass
    return alerts


def _understaffing_alerts(year: int = 2025) -> list:
    """Flag upcoming understaffing weeks from predictive engine."""
    alerts = []
    for rc in REGIONS:
        try:
            predictions = predict_understaffing(rc, look_ahead_weeks=4)
            critical_weeks = [p for p in predictions if p["risk_level"] in ("Critical", "High")]
            if critical_weeks:
                worst = critical_weeks[0]
                alerts.append({
                    "type":           "understaffing",
                    "priority":       worst["risk_level"],
                    "region_code":    rc,
                    "title":          f"Understaffing Forecast — {rc} Week {worst['week_number']}",
                    "body":           worst.get("recommendation", f"{rc} predicted at {worst['utilisation_pct']}% utilisation."),
                    "metric_value":   worst["utilisation_pct"],
                    "metric_label":   "Predicted Utilisation %",
                    "action_required":worst["risk_level"] == "Critical",
                })
        except Exception:
            continue
    return alerts


def _positive_insights(year: int = 2025) -> list:
    """Surface positive operational insights and opportunities."""
    insights = []
    try:
        kpis = get_financial_kpis(year=year)
        if kpis["margin_pct"] > 25:
            insights.append({
                "type":           "opportunity",
                "priority":       "Low",
                "region_code":    None,
                "title":          "Strong Margin Performance",
                "body":           f"Overall margin at {kpis['margin_pct']}% — above target. "
                                  f"Consider reinvesting in engineer training or capacity expansion.",
                "metric_value":   kpis["margin_pct"],
                "metric_label":   "Margin %",
                "action_required":False,
            })
    except Exception:
        pass

    return insights


# ─── Main Public API ─────────────────────────────────────────────────────────

def get_all_recommendations(year: int = 2025, max_results: int = 20) -> dict:
    """
    Generate all cross-module AI recommendations for the dashboard.

    Parameters:
        year: Operational year to analyse
        max_results: Maximum number of recommendations to return

    Returns:
        dict with prioritised recommendations, summary counts, and last_updated
    """
    all_recs = []
    all_recs.extend(_capacity_alerts(year))
    all_recs.extend(_cancellation_alerts(year))
    all_recs.extend(_financial_alerts(year))
    all_recs.extend(_understaffing_alerts(year))
    all_recs.extend(_positive_insights(year))

    # Sort by priority
    all_recs.sort(key=lambda x: PRIORITY_ORDER.get(x["priority"], 9))

    # Trim
    all_recs = all_recs[:max_results]

    # Summary counts
    by_priority = {"Critical": 0, "High": 0, "Medium": 0, "Low": 0}
    for r in all_recs:
        p = r.get("priority", "Low")
        by_priority[p] = by_priority.get(p, 0) + 1

    # Assign IDs
    for i, r in enumerate(all_recs):
        r["id"] = i + 1

    return {
        "recommendations":    all_recs,
        "total_count":        len(all_recs),
        "critical_count":     by_priority["Critical"],
        "high_count":         by_priority["High"],
        "medium_count":       by_priority["Medium"],
        "action_required_count": sum(1 for r in all_recs if r.get("action_required")),
        "last_updated":       date.today().isoformat(),
    }


def get_natural_language_summary(year: int = 2025, recommendations: dict = None) -> str:
    """
    Generate a natural language executive summary of operational health.

    Returns:
        str — executive summary paragraph
    """
    try:
        fin   = get_financial_kpis(year=year)
        recs  = recommendations or get_all_recommendations(year)

        margin = fin["margin_pct"]
        crit   = recs["critical_count"]
        high   = recs["high_count"]
        total  = recs["total_count"]

        health = "strong" if margin > 22 and crit == 0 else ("at risk" if crit > 2 else "stable")

        summary = (
            f"EXL operational health is {health} for {year}. "
            f"Overall margin is {margin}% with {fin['total_completions']:,} completions "
            f"at £{fin['avg_cost_per_completion']:.0f} average cost per job. "
        )
        if crit > 0:
            summary += f"There are {crit} critical alerts requiring immediate attention. "
        if high > 0:
            summary += f"{high} high-priority items need monitoring. "
        summary += (
            f"AI analysis has identified {total} operational insights across all regions. "
            f"Review the recommendations panel for detailed actions."
        )
        return summary
    except Exception as e:
        return f"Operational health summary unavailable. Error: {e}"
