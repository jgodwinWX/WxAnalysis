# About this project
I will cut to the chase: most of this was written by Codex with review by me. My workflow is heavily focused on design and functionality in which I describe what I want in high detail to Codex then ask for recommendations, clarifications, and its plan for implementation before it edits a single line of code. I thoroughly review what it produces before putting anything into production. I am what one could consider an intermediate level coder, at least when it comes to backend design. For front-end coding, I would make a better quarterback for the Kansas City Chiefs than a front-end developer. AI coding has allowed me, a high-functioning amateur with a Louisiana public education to amass a great deal of knowledge that would have previously been impossible to obtain in today's busy work-life culture. This project is entirely a hobby of mine, and I can't totally say that I understand how every single piece works in great detail. Use at your own risk, but feel free to suggest changes and features.

# Wx Mesoanalysis Dashboard

Prototype web-based mesoanalysis dashboard for surface observations, objective analysis, derived fields, MRMS overlays, and selected NWS products.

The app has:
- `backend/` FastAPI service (data ingest, history/cache, MRMS/WPC services, diagnostics APIs)
- `frontend/` Vite + React + MapLibre client

## Current Feature Set

### Surface Observations
- Time slider/looper (history mode)
- Station display modes:
  - `Station Plots`
  - `Colored Flight Rule`
  - `Weather Symbols Only`
- Popup + sidebar observation details
- QC flagging support (flagged obs still shown in obs details)

### Objective Analysis
- Isotherms
- Isodrosotherms
- Isobars
- Objective wind
- Filled analyses:
  - Wind speed
  - Ceiling (`<=050`)
  - Visibility (`<=6SM`)
  - Relative humidity (critical ranges)

### Derived Fields
- Mixing ratio
- Moisture convergence
- Theta-e
- 24-hour change fields:
  - SLP change
  - Temperature change
  - Dewpoint change
  - Theta-e change

### MRMS (single-select within MRMS menu)
- RALA reflectivity
- Composite reflectivity
- 18 dBZ echo tops (kft)
- 4-hour rotation tracks
- MRMS cursor readout integration
- Live stale-frame warning (>30 min old)
- Tile-based rendering capped at zoom level 10

### NWS Products
- Latest WPC surface analysis
- Front render options:
  - Simple lines
  - Classic front symbols

### Geographies and Views
- Geographic overlays:
  - National boundaries (ADM0)
  - State/province boundaries (ADM1)
  - County/district boundaries (US counties)
  - US ARTCC boundaries
- Preset views:
  - US regions
  - US states/territories
  - US ARTCCs

### UI/Export/Diagnostics
- Collapsible legends and colorbars
- Optional legend inclusion in PNG export
- Valid-time overlay saved into PNG export
- API diagnostics dashboard (freshness, storage, errors, counters)
- Cursor diagnostics panel (analysis/derived + MRMS value)

## Project Structure

```text
WxAnalysis/
├── backend/
│   ├── main.py
│   ├── mrms_service.py
│   ├── wpc_service.py
│   └── requirements.txt
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
└── data/
    ├── mrms_cache/
    └── snapshots.db
```

## Prerequisites

- Python 3.9+
- Node.js 18+ (Node 20 recommended)
- npm
- Virtual environment tool (`venv` or conda)

## Backend Setup (FastAPI)

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Backend base URL:
- `http://localhost:8000`

### Backend Dependencies

From `backend/requirements.txt`:
- `fastapi`
- `uvicorn[standard]`
- `pydantic`
- `requests`
- `metar`
- `metpy`
- `pandas`
- `shapely`
- `numpy`
- `Pillow`
- `pygrib`

Notes:
- MRMS rendering requires `numpy`, `Pillow`, and `pygrib`.
- Weather symbol font/glyph APIs require `metpy`.

## Frontend Setup (Vite/React)

```bash
cd frontend
npm install
npm run dev
```

Frontend URL:
- Usually `http://localhost:5173`

Build frontend:

```bash
cd frontend
npm run build
```

## Run Workflow

1. Start backend on `:8000`
2. Start frontend on `:5173`
3. Open app in browser
4. If frontend appears stale after backend changes:
   - Restart backend
   - Hard refresh browser (`Cmd+Shift+R` on macOS)

## Data Retention and Storage Caps

### MRMS cache (`data/mrms_cache`)
- Hard size cap: **8 GB**
- Cleanup interval: every **10 minutes**
- Raw-file retention: **12 hours**
- Oldest-first deletion when over cap

### Snapshot history (`data/snapshots.db` and in-memory)
- In-memory snapshot retention: **30 hours**
- In-memory max snapshots: **2000**
- SQLite time retention: **7 days**
- SQLite hard cap: **2 GB**
- If DB exceeds cap, oldest rows are pruned until below threshold

## Key API Endpoints

### Health/Diagnostics
- `GET /api/health`
- `GET /api/ops/health`
- `GET /api/ops/freshness`
- `GET /api/ops/storage`
- `GET /api/ops/errors`
- `GET /api/ops/summary`

### Surface Observations
- `GET /api/obs/latest`
- `GET /api/obs/times?minutes=...`
- `GET /api/obs/at?time=...`
- `POST /api/obs/refresh`

### Geographies
- `GET /api/geography/artcc`

### MRMS
- `GET /api/mrms/times?product=...`
- `GET /api/mrms/meta?product=...&time=...`
- `GET /api/mrms/image?product=...&time=...`
- `GET /api/mrms/tile/{z}/{x}/{y}.png?product=...&time=...`
- `GET /api/mrms/value?product=...&time=...&lat=...&lon=...`

### NWS/MetPy support
- `GET /api/nws/wpc_surface/latest`
- `GET /api/metpy/wx_symbol_map`
- `GET /api/metpy/wx_font`

## Operational Notes

- This is a research/prototype tool, not an operational warning or aviation decision system.
- Live-data services are external dependencies (IEM, NOAA MRMS, WPC); outages or delays upstream can affect display.
- MRMS and objective analysis can be displayed together.

## License

MIT

## Disclaimer

Provided for educational and research purposes only. Not intended for operational, safety-critical, or decision-making use. No guarantees of accuracy, completeness, or availability.
