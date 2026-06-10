import os
import json
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("FLASK_ENV", "testing")
os.environ.setdefault("ENABLE_AI_RECOMMENDATIONS", "false")
os.environ.setdefault("IMSERV_AUTO_GENERATE_DATA", "false")

from app import app  # noqa: E402


class AppSmokeTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def assert_json_response(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, path)
        self.assertTrue(response.is_json, path)
        payload = response.get_json()
        self.assertIsNotNone(payload, path)
        return payload

    def test_dashboard_page_renders(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"EXL", response.data)

    def test_health_reports_required_data_available(self):
        response = self.client.get("/api/health")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "ok")
        missing = [
            filename
            for filename, health in payload["data_health"].items()
            if not health["exists"]
        ]
        self.assertEqual(missing, [])

    def test_region_reference_endpoint(self):
        payload = self.assert_json_response("/api/regions")
        codes = {region["code"] for region in payload}

        self.assertIn("NW", codes)
        self.assertIn("SE", codes)

    def test_global_filters_use_actual_period_months(self):
        payload = self.assert_json_response("/api/filters")
        months = payload["months"]
        forecast_months = payload["forecast_months"]
        manifest = json.loads(
            (Path(__file__).resolve().parent.parent / "data" / "inputs" / "manifest.json").read_text()
        )
        actual_start, actual_end = manifest["actual_period"].split(" to ")
        forecast_start, forecast_end = manifest["forecast_period"].split(" to ")

        self.assertEqual(months[0]["value"], actual_start[:7])
        self.assertEqual(months[-1]["value"], actual_end[:7])
        self.assertEqual(len(months), 12)
        self.assertEqual(forecast_months[0]["value"], forecast_start[:7])
        self.assertEqual(forecast_months[-1]["value"], forecast_end[:7])
        self.assertEqual(len(forecast_months), 12)

    def test_financial_dashboard_uses_future_months(self):
        payload = self.assert_json_response("/api/financial/kpis?year=2026")
        months = [row["month"] for row in payload["monthly_trend"]]

        self.assertEqual(months[0], "2026-06")
        self.assertEqual(months[-1], "2027-05")
        self.assertEqual(len(months), 12)

        single_month = self.assert_json_response("/api/financial/kpis?year=2026&month=2026-06")
        self.assertEqual([row["month"] for row in single_month["monthly_trend"]], ["2026-06"])

    def test_filters_supplier_list_falls_back_to_csv_without_sqlite(self):
        with patch("engine.sqlite_store.query_rows", return_value=None):
            payload = self.assert_json_response("/api/filters")

        self.assertGreater(len(payload["suppliers"]), 0)
        self.assertIn("Octopus Energy Limited", payload["suppliers"])

    def test_core_dashboard_api_endpoints(self):
        endpoints = [
            "/api/journey/kpis?year=2025",
            "/api/forecasting/channel-kpis?year=2025",
            "/api/cancellations/kpis?year=2025",
            "/api/field-ops/kpis?year=2025",
            "/api/financial/kpis?year=2026",
            "/api/ai/recommendations?year=2025",
        ]

        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint):
                self.assert_json_response(endpoint)

    def test_timeslot_dashboard_endpoint(self):
        payload = self.assert_json_response("/api/timeslot/dashboard?filter_type=all&filter_value=")

        self.assertIn("channel_booking", payload)
        self.assertIn("business_type", payload)
        self.assertIn("attempts_overview", payload)
        self.assertIn("agent_view", payload)
        self.assertIn("Morning", payload["attempts_overview"])


if __name__ == "__main__":
    unittest.main()
