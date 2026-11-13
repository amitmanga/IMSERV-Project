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
- **Rebooking Agent (Agentic AI)**: end-to-end automated recovery of cancelled and aborted jobs with configurable DNO/D36/dependency rules (`config/rules.yaml`), Assisted vs Autonomous modes, live SSE reasoning timeline, planner escalation queue, simulated customer notifications, and CSV audit logging.

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
| Rebooking Agent | Agentic AI tool-calling workflow (`Detect -> Dependencies/D36 -> DNO -> Capacity -> Decide -> Rebook -> Message -> Log`) with live SSE streaming, 28-day regional utilisation view, Assisted human approval, escalations, and audit CSV export. |

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

### Rebooking Agent & AI Provider Environment Variables

```bash
# Preferred AI provider: openrouter (auto-selected when OPENROUTER_API_KEY or sk-or- OPENAI_API_KEY is set) or huggingface
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=nvidia/nemotron-3.5-lightning:free
REBOOKING_AGENT_MAX_TOKENS=512

# Run the deterministic scripted tool-calling brain (true) or live OpenRouter/HF AI loop (false)
MOCK_LLM=false

# Optional override for business rules YAML path (defaults to ./config/rules.yaml)
REBOOKING_RULES_PATH=./config/rules.yaml

# Optional SQLite state store override (defaults to ./data/rebooking_state.db)
# REBOOKING_DB_PATH=./data/rebooking_state.db
```

**Switching between Mock and Live LLM:**
- **Via `.env`:** Set `MOCK_LLM=false` (with `OPENROUTER_API_KEY` or `sk-or-` `OPENAI_API_KEY` and `OPENROUTER_MODEL`) then restart `app.py` to run the live OpenRouter tool-calling loop, or set `MOCK_LLM=true` for offline/deterministic runs.
- **Via UI:** Inside the **Rebooking Agent** tab toolbar, toggle **LLM Brain** between `Deterministic Mock` and `Live AI (OpenRouter)` on the fly. If the live provider times out or rejects a request, the UI displays a friendly banner with a one-click retry in Deterministic Mock mode.

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
|-- config/
|   |-- rules.yaml                 # Configurable DNO, D36, dependency, capacity & SLA rules
|-- requirements.txt               # Python runtime dependencies
|-- render.yaml                    # Render deployment configuration
|-- Dockerfile
|-- docker-compose.yml
|-- demo/
|   |-- IMSERV_app_demo_3min.webm
|   |-- IMSERV_app_demo_3min_preview.png
|-- scripts/
|   |-- augment_rebooking_data.py  # Deterministic synthetic queue & 28d capacity augmentation (seed=42)
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
|   |-- rules_loader.py            # YAML rules evaluator (DNO/D36/dependencies/SLA)
|   |-- rebooking_store.py         # SQLite persistence for rebooking queue, slots, escalations & audit
|   |-- rebooking_tools.py         # 10 JSON-schema tools + guardrails for Rebooking Agent
|   |-- rebooking_agent.py         # Tool-calling agent loop (Mock & Live HF LLM + SSE streaming)
|-- static/
|   |-- css/style.css
|   |-- img/exl_service_logo.svg
|   |-- js/                        # Frontend modules (including rebooking_agent.js)
|-- templates/
|   |-- index.html                 # Single-page application shell
|-- data/
|   |-- inputs/                    # CSV input datasets (including rebooking_jobs.csv & rebooking_slots_28d.csv)
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

### Rebooking Agent

| Endpoint | Method | Description |
|---|---|---|
| `/api/rebooking-agent/jobs` | GET | Cancelled/aborted job queue, filter options, KPI tiles, and config. |
| `/api/rebooking-agent/jobs/<job_ref>` | GET | Job detail, 28-day regional daily utilisation, and job audit entries. |
| `/api/rebooking-agent/stream/<job_ref>` | GET | Server-Sent Events (SSE) stream of the 8-step tool-calling agent run. |
| `/api/rebooking-agent/run/<job_ref>` | POST | Synchronous single-job agent run. |
| `/api/rebooking-agent/jobs/<job_ref>/approve` | POST | Approve & Execute a prepared booking in Assisted or Vulnerable mode. |
| `/api/rebooking-agent/jobs/<job_ref>/reject` | POST | Reject a proposed booking and escalate it to the planner queue. |
| `/api/rebooking-agent/jobs/<job_ref>/message` | POST | Save an edited simulated customer notification. |
| `/api/rebooking-agent/escalations` | GET | List planner escalations (`OPEN` / `RESOLVED`) with nearest slot options. |
| `/api/rebooking-agent/escalations/<escalation_id>/resolve` | POST | Resolve an escalation (optionally booking one of the nearest slot options). |
| `/api/rebooking-agent/audit` | GET | Filterable audit log JSON (`format=csv` downloads CSV). |
| `/api/rebooking-agent/reset` | POST | Reset the Rebooking Agent SQLite demo queue to fresh synthetic defaults. |

---

## Rebooking Agent Rules & Assumptions (`config/rules.yaml`)

All business rules are decoupled into [`config/rules.yaml`](config/rules.yaml) and loaded dynamically without code changes:

- **DNO Involvement & Lead Time**:
  - Job types requiring DNO: `NEW_INSTALL`, `REMOVAL`.
  - Specific cancellation/abort reasons requiring DNO even on exchanges/repairs: `Faulty meter location`, `Exposed wires`, `Service head fault`.
  - Default DNO turnaround lead time: **`7` calendar days** (`default_lead_time_days`). When DNO status is `PENDING`, `raise_dno_request` creates a simulated request (`DNO-SIM-*`) and constrains slot selection to `slot_date >= today + 7 days`.
  - `NOT_REQUIRED` and `COMPLETE` proceed immediately; `BLOCKED` stops and escalates to the planner queue.
- **D36 Industry Flow Statuses**:
  - Clear statuses: `CLEAR`, `COMPLETE`, `NOT_REQUIRED`.
  - Blocking statuses: `REJECTED`, `PENDING_SUPPLIER`, `DATA_MISMATCH`, `BLOCKED`, `EXCEPTION` (and any unrecognised non-clear status).
- **Third-Party Blocking Dependencies**:
  - Blocking flags: `ASBESTOS_CHECK`, `LANDLORD_CONSENT`, `SCAFFOLDING`, `REVENUE_PROTECTION_HOLD`, `COMMS_HUB_SHORTAGE`, `THIRD_PARTY_ACCESS_PERMIT`.
  - Non-blocking flags: `NONE`, `IHD_FOLLOWUP`.
- **Capacity, Slot Ranking & Guardrails**:
  - Forward horizon: `28` days; regional daily utilisation threshold: **`90.0%`** (days above 90% are skipped).
  - Ranking order: within SLA -> regional utilisation <= 90% -> matching engineer skill -> preferred time of day (`Morning` / `Afternoon` / `Evening`) -> avoids original engineer/supplier for no-access abort reasons where alternatives exist -> earliest compliant date & lowest utilisation.
  - Guardrails: every tool validates strict JSON schema inputs; `rebook_job` rejects any `slot_id` not returned by `get_capacity` and never executes in `Assisted` mode or for `Vulnerable / PSR` customers (`vulnerable_always_requires_approval: true`) until a human clicks **Approve & Execute**. Customer messages are always tagged **`Simulated send`**.
- **Synthetic Data Generation**: Run `python scripts/augment_rebooking_data.py` (`RANDOM_SEED=42`) to regenerate [`data/inputs/rebooking_jobs.csv`](data/inputs/rebooking_jobs.csv) (30 jobs including scenarios `a`–`f`) and [`data/inputs/rebooking_slots_28d.csv`](data/inputs/rebooking_slots_28d.csv) directly from existing regions, engineers, suppliers, and cancellation/abort reasons without mutating `master_operations.csv`.

---

## 5-Minute Rebooking Agent Demo Script (Scenarios a–f)

Start the server (`python app.py`), open `http://localhost:5000`, and click **Rebooking Agent** in the left navigation. Ensure **Execution Mode = Assisted (Human Approve)** and **LLM Brain = Deterministic Mock** (or `MOCK_LLM=false` for live HF tool calling), then click **Reset Demo** if needed:

1. **Scenario (a) Clean Rebook & Assisted Approval (`RBK-DEMO-A`) — ~60s**:
   - Select `RBK-DEMO-A` (`EXCHANGE`, `CLEAR` D36, `NOT_REQUIRED` DNO) and click **Run Agent**.
   - Watch steps 1–8 stream live via SSE. Notice `Rebook` pauses at `AWAITING_APPROVAL` because Assisted mode blocks auto-commit, while `Message` previews the polite SMS marked **`Simulated send`**.
   - Click **Edit Message** to tweak the text if desired, click **Save Message**, then click **Approve & Execute** to commit the booking (`rebook_flag = True`).
2. **Switch to Autonomous Mode & Scenario (b) High-Utilisation Avoidance (`RBK-DEMO-B`) — ~45s**:
   - Toggle top bar **Execution Mode** to **Autonomous**.
   - Click **Run Agent** on `RBK-DEMO-B` (`No Access` abort in `SE`).
   - Point out the right-hand **28-Day Regional Utilisation** chart: red bars (>90%) on days 1–4 are skipped, the original engineer is avoided, and the chosen green bar lands cleanly within SLA under 90%.
3. **Scenario (c) DNO Pending (`RBK-DEMO-C`) — ~45s**:
   - Run `RBK-DEMO-C` (`NEW_INSTALL`, DNO=`PENDING`).
   - Show step 3 (`raise_dno_request`) submitting a simulated DNO clearance with a 7-day lead time, constraining the chosen green slot to `today + 7 days` or later while still beating SLA.
4. **Scenario (d) Blocked by D36 / Dependency (`RBK-DEMO-D`) — ~45s**:
   - Run `RBK-DEMO-D`. Step 2 detects blocking D36 (`PENDING_SUPPLIER`) + `ASBESTOS_CHECK`, halts cleanly, skips downstream rebook/message steps, and adds the job to the **Planner Escalation Queue**.
5. **Scenario (e) No Slot Within SLA (`RBK-DEMO-E`) — ~45s**:
   - Run `RBK-DEMO-E` (tight SLA vs high near-term utilisation). Step 5 finds no compliant slot inside SLA, escalates (`SLA-Safe %` updates in KPIs), and surfaces the **3 nearest post-SLA options** in the **Planner Escalation Queue** with one-click **Book Option** buttons.
6. **Scenario (f) Vulnerable / PSR Customer Guardrail & Audit Export (`RBK-DEMO-F`) — ~60s**:
   - Even with **Execution Mode = Autonomous**, run `RBK-DEMO-F` (tagged `PSR / Vulnerable`).
   - Show the safety guardrail blocking `rebook_job` and enforcing mandatory human review (`AWAITING_APPROVAL`), then click **Approve & Execute** (or **Reject**).
   - Finish by filtering the **Agent Audit Log** at the bottom and clicking **Export CSV** to inspect the complete tool-call, input/output, and reasoning trail.

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
