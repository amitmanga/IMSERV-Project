# IMSERV Smart Meter Field Planning & Utility Operations Platform

IMSERV is a Flask-based operations planning platform for smart meter appointment delivery. It brings appointment funnel performance, dialler outcomes, cancellation risk, engineer capacity, meter history, and financial scenario planning into one browser-based dashboard.

The app is designed for operational leaders, planning teams, field managers, and customer support teams who need a shared view of demand, capacity, appointment fallout, and commercial impact.

---

## Demo Video

<video src="demo/IMSERV_app_demo_3min.webm" controls poster="demo/IMSERV_app_demo_3min_preview.png" width="100%">
  Watch the 3-minute IMSERV app demo: demo/IMSERV_app_demo_3min.webm
</video>

[Open the 3-minute demo video](demo/IMSERV_app_demo_3min.webm)

---

## Key Capabilities

- Appointment journey analytics from customer job requests through to successful completion.
- Dialler performance views for booking conversion, contact outcomes, best call windows, and business-category behaviour.
- Cancellation and same-day abort analysis with root-cause breakdowns and recovery signals.
- Short-term engineer roster planning across regions, days, and appointment slots.
- Long-term demand, capacity, utilisation, and demand-gap forecasting.
- Single meter lookup for before-call context, including meter details, MOP/DC status, visit history, and dialler contacts.
- Financial scenario modelling for revenue, cost, margin, capacity status, and cost per executed appointment.
- AI-assisted operational summaries and recommendations through a server-side chatbot proxy.

---

## Architecture

| Layer | Technology |
|---|---|
| Backend | Flask 3, Python |
| Frontend | Vanilla JavaScript, HTML, CSS, Chart.js |
| Analytics | Python engine modules |
| Data Store | CSV/JSON inputs with optional SQLite build support |
| Deployment | Docker, Gunicorn, Render.com |

The application uses a Flask monolith for API routes, modular Python files for analytics logic, and a single-page frontend served from `templates/index.html` with feature-specific JavaScript modules in `static/js`.

---

## Application Modules

| Module | Purpose |
|---|---|
| Appointment Journey | Tracks job requests, dialler loads, contacts, bookings, D-1 cancellations, same-day aborts, completions, supplier performance, and regional success. |
| Dialler Performance | Analyses booking conversion, executed jobs, business categories, contact windows, channel booking, and dialler outcomes. |
| Risk & Recovery | Breaks down cancellation and abort reasons, recovery trends, regional risk, and rebooking performance. |
| Resource Planning | Shows short-term engineer-slot utilisation and long-term demand versus capacity forecasts. |
| Single Meter View | Looks up an MPXN and displays meter, supplier, MOP, DC, visit, and dialler contact history. |
| Scenario Impact | Simulates appointment volume, success rate, cancellation rate, cost, revenue, engineer count, and margin outcomes. |

---

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Generate or refresh local datasets when needed
python engine/data_generator.py

# 3. Start the application
python app.py
```

Open the app at:

```text
http://localhost:5000
```

On startup, the app checks whether the local CSV data is aligned to the current rolling reporting window and prepares data automatically when configured to do so.

---

## Configuration

Create a `.env` file from `.env.example` and adjust values as needed.

Common settings:

```bash
SECRET_KEY=change-me
PORT=5000
ENABLE_DATABASE=false
AUTO_GENERATE_DATA=true
```

### Hugging Face Chatbot

The floating app assistant uses a Flask proxy so the Hugging Face token stays server-side.

```bash
HF_TOKEN=hf_or_provider_key
HF_CHAT_PROVIDER=novita
HF_CHAT_MODEL=google/gemma-4-31B-it
HF_CHAT_BASE_URL=https://router.huggingface.co/v1
```

You can also point the chatbot at a dedicated endpoint:

```bash
HF_CHAT_ENDPOINT=https://your-endpoint.endpoints.huggingface.cloud/v1/chat/completions
```

---

## Docker

```bash
docker-compose up --build
```

Services:

```text
Application: http://localhost:5000
PostgreSQL: localhost:5432
```

---

## Render Deployment

1. Create a new Render Web Service.
2. Connect this repository.
3. Use `pip install -r requirements.txt` as the build command.
4. Use the following start command:

```bash
gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 2 --timeout 120 app:app
```

5. Add `SECRET_KEY` and any required chatbot secrets in Render environment variables.

The included `render.yaml` contains the non-secret deployment settings. Keep `HF_TOKEN` and other secrets in Render environment settings only.

---

## Project Structure

```text
IMSERV-Project/
|-- app.py                         # Flask application and API routes
|-- requirements.txt               # Python runtime dependencies
|-- render.yaml                    # Render deployment configuration
|-- Dockerfile
|-- docker-compose.yml
|-- demo/
|   |-- IMSERV_app_demo_3min.webm
|   |-- IMSERV_app_demo_3min_preview.png
|-- scripts/
|   |-- create_demo_video.py       # Playwright-based demo video recorder
|   |-- build_sqlite_store.py
|   |-- refresh_data.py
|-- engine/
|   |-- data_generator.py          # Synthetic data generation
|   |-- ingestion.py               # Data loading and cache helpers
|   |-- forecasting_engine.py      # Forecasting logic
|   |-- cancellation_engine.py     # Cancellation and abort analytics
|   |-- field_ops_engine.py        # Capacity and field operations planning
|   |-- financial_engine.py        # Financial scenario modelling
|   |-- ai_recommendations.py      # Operational recommendation logic
|-- static/
|   |-- css/style.css
|   |-- img/exl_service_logo.svg
|   |-- js/                        # Frontend modules
|-- templates/
|   |-- index.html                 # Single-page application shell
|-- data/
|   |-- inputs/                    # CSV input datasets
|-- deployment/
|   |-- schema.sql                 # Optional PostgreSQL schema
|-- tests/
```

---

## Data

The app uses local CSV files under `data/inputs` for appointment, engineer, financial, supplier, and capacity datasets.

Important input files include:

| File | Purpose |
|---|---|
| `master_operations.csv` | Source operational job ledger. |
| `booking_journey.csv` | Aggregated appointment journey funnel data. |
| `channel_volume.csv` | Daily dialler and channel volume data. |
| `capacity_demand.csv` | Demand and capacity planning data. |
| `engineers.csv` | Engineer dimension data. |
| `engineer_availability.csv` | Engineer-day availability and completed jobs. |
| `field_engineers.csv` | Field engineer planning data. |
| `financial_data.csv` | Revenue, cost, and margin inputs. |
| `suppliers.csv` | Supplier reference data. |

Regenerate synthetic datasets with:

```bash
python engine/data_generator.py
```

---

## API Overview

### Appointment Journey

| Endpoint | Method | Description |
|---|---|---|
| `/api/journey/dashboard` | GET | Combined journey dashboard payload. |
| `/api/journey/kpis` | GET | Funnel KPI metrics. |
| `/api/journey/weekly-trend` | GET | Weekly completion, cancellation, and abort trend. |
| `/api/journey/suppliers` | GET | Supplier performance data. |
| `/api/journey/regional-heatmap` | GET | Regional success-rate comparison. |
| `/api/journey/decomposition-tree` | GET | Journey decomposition data. |

### Dialler Performance

| Endpoint | Method | Description |
|---|---|---|
| `/api/timeslot/dashboard` | GET | Dialler performance dashboard payload. |
| `/api/timeslot/channel-booking` | GET | Channel booking analytics. |
| `/api/timeslot/business-type` | GET | Business-type booking and success view. |
| `/api/timeslot/attempts-overview` | GET | Attempt-level performance summary. |
| `/api/timeslot/agent-view` | GET | Agent-level dialler view. |
| `/api/timeslot/dialler-outcome` | GET | Dialler outcome analysis. |

### Risk & Recovery

| Endpoint | Method | Description |
|---|---|---|
| `/api/cancellations/dashboard` | GET | Combined cancellation and abort dashboard payload. |
| `/api/cancellations/kpis` | GET | Cancellation and abort KPIs. |
| `/api/cancellations/root-causes` | GET | Root-cause breakdown. |
| `/api/cancellations/trends` | GET | Cancellation trend analytics. |
| `/api/cancellations/heatmap` | GET | Regional cancellation comparison. |
| `/api/cancellations/predict` | GET | Risk scoring and recommendations. |
| `/api/cancellations/rebooking` | GET | Rebooking analytics. |

### Resource Planning

| Endpoint | Method | Description |
|---|---|---|
| `/api/roster/timeline` | GET | Short-term engineer roster timeline. |
| `/api/longterm/overview` | GET | Long-term demand and capacity overview. |
| `/api/field-ops/kpis` | GET | Field operations KPIs. |
| `/api/field-ops/capacity-matrix` | GET | Regional capacity matrix. |
| `/api/field-ops/patch-plan` | GET | Patch-level plan data. |
| `/api/field-ops/engineer-performance` | GET | Engineer performance ranking. |
| `/api/field-ops/capacity-forecast` | GET | Capacity forecast payload. |
| `/api/field-ops/optimise` | GET | Workforce optimisation recommendations. |

### Meter View

| Endpoint | Method | Description |
|---|---|---|
| `/api/meter-view` | GET | Meter history and operational context for an MPXN. |

### Financial Planning

| Endpoint | Method | Description |
|---|---|---|
| `/api/financial/kpis` | GET | Financial KPI summary. |
| `/api/financial/scenario` | POST | Run a financial scenario. |
| `/api/financial/compare-scenarios` | POST | Compare multiple scenarios. |
| `/api/financial/forecast-profitability` | GET | Profitability forecast. |

### AI and System

| Endpoint | Method | Description |
|---|---|---|
| `/api/ai/recommendations` | GET | Cross-module recommendations. |
| `/api/ai/summary` | GET | Natural-language operational summary. |
| `/api/ai/dashboard` | GET | Dashboard recommendation payload. |
| `/api/chatbot/message` | POST | Chatbot message proxy. |
| `/api/chatbot/config` | GET | Chatbot configuration status. |
| `/api/health` | GET | Health check and data status. |
| `/api/data/status` | GET | Rolling data-window status. |
| `/api/data/reload` | GET | Reload data caches. |
| `/api/data/generate` | GET | Regenerate data. |
| `/api/data/store-status` | GET | Data store status. |
| `/api/data/actual-window` | GET | Current actuals window. |
| `/api/regions` | GET | Region reference list. |
| `/api/filters` | GET | Filter values for the frontend. |

Common query parameters:

| Parameter | Description |
|---|---|
| `region` | Region code such as `NW`, `NE`, `MID`, `SE`, `SW`, `WAL`, `SCO`, or `YRK`. |
| `year` | Reporting or forecast year, depending on endpoint. |
| `month` | Optional month filter where supported. |

---

## Testing

Run the smoke tests with:

```bash
pytest
```

---

## Demo Video Generation

The demo video can be regenerated with:

```bash
python scripts/create_demo_video.py
```

The recorder expects the app to be available at `http://127.0.0.1:5000` and writes the output to:

```text
demo/IMSERV_app_demo_3min.webm
```

---

## Optional PostgreSQL Schema

For production persistence, the normalised schema is available in:

```text
deployment/schema.sql
```

Set the relevant environment variables before enabling database-backed behaviour:

```bash
ENABLE_DATABASE=true
DATABASE_URL=postgresql://user:password@host:5432/database
```
