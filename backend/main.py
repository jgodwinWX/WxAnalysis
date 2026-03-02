from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
import os

from dataclasses import dataclass
from datetime import timedelta
import threading
from fastapi import Query, HTTPException
import requests
import sqlite3
import json
import csv
from io import StringIO
import time as pytime

from metar_fetcher import (
    fetch_current_metars,
    fetch_station_metadata,
    IEM_CSV_URL,
    REQUEST_HEADERS,
    parse_station_id,
    fahrenheit_to_celsius,
    calculate_flight_rule,
)
from mrms_service import MrmsService
from wpc_service import WpcSurfaceService

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class SkyCondition(BaseModel):
    cover: str  # CLR, FEW, SCT, BKN, OVC
    level_ft: Optional[float] = None


class SurfaceObs(BaseModel):
    id: str
    obsTimeUtc: Optional[str] = None
    name: str
    lat: float
    lon: float
    tempC: float
    dewpointC: Optional[float] = None
    windDirDeg: Optional[float] = None
    windSpeedKt: Optional[float] = None
    windGustKt: Optional[float] = None
    visibilityMi: Optional[float] = None
    ceilingFt: Optional[float] = None
    skyConditions: List[SkyCondition] = []
    altimeterInhg: Optional[float] = None
    pressureMb: Optional[float] = None
    pressureIsEstimated: bool = False
    relativeHumidity: Optional[float] = None
    weatherCodes: Optional[str] = None
    flightRule: str = "UNKNOWN"
    rawMetar: Optional[str] = None
    qcFlags: List[str] = Field(default_factory=list)
    analysisExcludeFields: List[str] = Field(default_factory=list)


class ObsResponse(BaseModel):
    generated_at: datetime
    stations: List[SurfaceObs]

class ObsAtResponse(ObsResponse):
    requested_time: str
    snapshot_time: str

# In-memory store for latest obs (will be replaced by DB later)
_latest_obs: List[SurfaceObs] = []
_last_update: Optional[datetime] = None
_update_lock = asyncio.Lock()

@dataclass
class Snapshot:
    t: datetime                 # UTC timestamp
    stations: List[SurfaceObs]  # stored obs at that time

# Rolling history
_snapshot_history: List[Snapshot] = []
_snapshot_lock = threading.Lock()
_snapshot_db_lock = threading.Lock()
_artcc_geojson_cache: Optional[dict] = None
_artcc_cache_time: Optional[datetime] = None
_metpy_wx_font_path_cache: Optional[Path] = None
_metpy_wx_symbol_map_cache: Optional[Dict[str, str]] = None
_data_root = Path(__file__).resolve().parent.parent / "data"
_mrms_service = MrmsService(cache_root=_data_root / "mrms_cache")
_wpc_service = WpcSurfaceService()
_snapshot_db_path = _data_root / "snapshots.db"
_app_started_at = datetime.now(timezone.utc)

_diag_lock = threading.Lock()
_diag_sources: Dict[str, Dict[str, Any]] = {
    "metar": {"success": 0, "failure": 0, "last_success": None, "last_failure": None, "last_error": None, "last_duration_ms": None},
    "wpc": {"success": 0, "failure": 0, "last_success": None, "last_failure": None, "last_error": None, "last_duration_ms": None},
    "mrms:rala": {"success": 0, "failure": 0, "last_success": None, "last_failure": None, "last_error": None, "last_duration_ms": None},
    "mrms:composite": {"success": 0, "failure": 0, "last_success": None, "last_failure": None, "last_error": None, "last_duration_ms": None},
    "mrms:etop18": {"success": 0, "failure": 0, "last_success": None, "last_failure": None, "last_error": None, "last_duration_ms": None},
    "mrms:rotation240": {"success": 0, "failure": 0, "last_success": None, "last_failure": None, "last_error": None, "last_duration_ms": None},
}

# Tune these:
SNAPSHOT_MAX_ITEMS = 2000       # max snapshots to keep
# Keep enough in memory for 24h-change fields plus some cushion.
SNAPSHOT_RETENTION_MIN = 30 * 60  # 30 hours (minutes)
SNAPSHOT_DB_RETENTION_HOURS = 7 * 24
SNAPSHOT_DB_MAX_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB hard cap
SNAPSHOT_NEAR_MATCH_MIN = 90
ARTCC_CACHE_MINUTES = 12 * 60
ARTCC_SOURCE_URLS = [
    "https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Airspace_Boundaries/FeatureServer/0/query?where=CLASS%20%3D%20%27ARTCC%27&outFields=IDENT,NAME,CLASS,LOCAL_TYPE&returnGeometry=true&f=geojson",
    "https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Airspace_Boundaries/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
]


def _feature_looks_like_artcc(feature: dict) -> bool:
    props = feature.get("properties") or {}
    text = " ".join(str(v).upper() for v in props.values() if v is not None)
    return (
        "ARTCC" in text
        or "AIR ROUTE TRAFFIC CONTROL CENTER" in text
        or "ANCHORAGE" in text
        or "ZAN" in text
    )


def _normalize_artcc_geojson(data: dict) -> dict:
    features = data.get("features")
    if not isinstance(features, list):
        return {"type": "FeatureCollection", "features": []}

    filtered = [f for f in features if isinstance(f, dict) and _feature_looks_like_artcc(f)]
    out_features = filtered if filtered else [f for f in features if isinstance(f, dict)]
    return {"type": "FeatureCollection", "features": out_features}


def _fetch_artcc_geojson() -> dict:
    headers = {"User-Agent": "WxAnalysis/1.0"}
    errors: List[str] = []

    for url in ARTCC_SOURCE_URLS:
        try:
            resp = requests.get(url, timeout=25, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            geojson = _normalize_artcc_geojson(data)
            if geojson.get("features"):
                return geojson
            errors.append(f"no features from {url}")
        except Exception as e:
            errors.append(f"{url}: {e}")

    raise HTTPException(status_code=503, detail=f"Could not fetch ARTCC boundaries ({'; '.join(errors)})")


def _find_metpy_wx_font_path() -> Path:
    global _metpy_wx_font_path_cache
    if _metpy_wx_font_path_cache is not None and _metpy_wx_font_path_cache.exists():
        return _metpy_wx_font_path_cache

    try:
        import metpy.plots as metpy_plots
    except Exception as e:
        raise RuntimeError(f"MetPy not available: {e}")

    plots_dir = Path(metpy_plots.__file__).resolve().parent
    candidates: List[Path] = []
    for root, _, files in os.walk(plots_dir):
        root_path = Path(root)
        for name in files:
            lname = name.lower()
            if not lname.endswith(".ttf"):
                continue
            p = root_path / name
            score = 0
            if "wx" in lname:
                score += 3
            if "weather" in lname:
                score += 2
            if "symbol" in lname:
                score += 1
            candidates.append((score, p))

    if not candidates:
        raise RuntimeError("No TTF weather symbol font found in MetPy package")

    candidates.sort(key=lambda item: (item[0], len(item[1].name)), reverse=True)
    _metpy_wx_font_path_cache = candidates[0][1]
    return _metpy_wx_font_path_cache


def _build_metpy_wx_symbol_map() -> Dict[str, str]:
    global _metpy_wx_symbol_map_cache
    if _metpy_wx_symbol_map_cache is not None:
        return _metpy_wx_symbol_map_cache

    try:
        from metpy.plots import wx_symbols
    except Exception as e:
        raise RuntimeError(f"MetPy wx_symbols not available: {e}")

    out: Dict[str, str] = {}
    for code in range(0, 200):
        try:
            glyph = wx_symbols.current_weather(code)
        except Exception:
            continue
        if glyph is None:
            continue
        glyph_text = str(glyph)
        if not glyph_text:
            continue
        out[str(code)] = glyph_text

    _metpy_wx_symbol_map_cache = out
    return out

def _parse_iso_z(s: str) -> datetime:
    # expects ISO with Z; accepts offsets too
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt.astimezone(timezone.utc).replace(microsecond=0)

def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso_z_optional(s: Optional[str]) -> Optional[datetime]:
    if s is None:
        return None
    return _parse_iso_z(s)


def _diag_mark_success(source: str, duration_ms: Optional[float] = None) -> None:
    now = datetime.now(timezone.utc)
    with _diag_lock:
        entry = _diag_sources.setdefault(
            source,
            {"success": 0, "failure": 0, "last_success": None, "last_failure": None, "last_error": None, "last_duration_ms": None},
        )
        entry["success"] = int(entry.get("success", 0)) + 1
        entry["last_success"] = _iso_z(now)
        entry["last_error"] = None
        if duration_ms is not None:
            entry["last_duration_ms"] = round(float(duration_ms), 1)


def _diag_mark_failure(source: str, err: Exception, duration_ms: Optional[float] = None) -> None:
    now = datetime.now(timezone.utc)
    with _diag_lock:
        entry = _diag_sources.setdefault(
            source,
            {"success": 0, "failure": 0, "last_success": None, "last_failure": None, "last_error": None, "last_duration_ms": None},
        )
        entry["failure"] = int(entry.get("failure", 0)) + 1
        entry["last_failure"] = _iso_z(now)
        entry["last_error"] = str(err)
        if duration_ms is not None:
            entry["last_duration_ms"] = round(float(duration_ms), 1)


def _age_minutes_from_iso(iso_str: Optional[str]) -> Optional[float]:
    if not iso_str:
        return None
    try:
        dt = _parse_iso_z(iso_str)
    except Exception:
        return None
    return round((datetime.now(timezone.utc) - dt).total_seconds() / 60.0, 1)


def _scan_path_stats(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"exists": False, "bytes": 0, "files": 0, "oldest_mtime": None, "newest_mtime": None}
    if path.is_file():
        st = path.stat()
        m = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
        return {
            "exists": True,
            "bytes": int(st.st_size),
            "files": 1,
            "oldest_mtime": _iso_z(m),
            "newest_mtime": _iso_z(m),
        }
    total = 0
    files = 0
    oldest: Optional[datetime] = None
    newest: Optional[datetime] = None
    for p in path.rglob("*"):
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        files += 1
        total += int(st.st_size)
        m = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
        if oldest is None or m < oldest:
            oldest = m
        if newest is None or m > newest:
            newest = m
    return {
        "exists": True,
        "bytes": total,
        "files": files,
        "oldest_mtime": _iso_z(oldest) if oldest else None,
        "newest_mtime": _iso_z(newest) if newest else None,
    }


def _obs_to_dict(obs: SurfaceObs) -> dict:
    if hasattr(obs, "model_dump"):
        return obs.model_dump()
    return obs.dict()


def _init_snapshot_db() -> None:
    _snapshot_db_path.parent.mkdir(parents=True, exist_ok=True)
    with _snapshot_db_lock:
        with sqlite3.connect(_snapshot_db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS snapshots (
                    t TEXT PRIMARY KEY,
                    stations_json TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_t ON snapshots(t)")
            conn.commit()


def _persist_snapshot_db(t: datetime, stations: List[SurfaceObs]) -> None:
    payload = json.dumps([_obs_to_dict(s) for s in stations], separators=(",", ":"))
    t_iso = _iso_z(t)
    with _snapshot_db_lock:
        with sqlite3.connect(_snapshot_db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO snapshots (t, stations_json) VALUES (?, ?)",
                (t_iso, payload),
            )
            cutoff = _iso_z(datetime.now(timezone.utc) - timedelta(hours=SNAPSHOT_DB_RETENTION_HOURS))
            conn.execute("DELETE FROM snapshots WHERE t < ?", (cutoff,))

            # Hard-size guardrail for local disk safety:
            # if DB file exceeds cap, prune oldest snapshots until under cap.
            db_size = 0
            try:
                db_size = _snapshot_db_path.stat().st_size
            except OSError:
                db_size = 0
            if db_size > SNAPSHOT_DB_MAX_BYTES:
                target = int(SNAPSHOT_DB_MAX_BYTES * 0.95)
                while db_size > target:
                    row = conn.execute("SELECT t FROM snapshots ORDER BY t ASC LIMIT 1").fetchone()
                    if not row:
                        break
                    conn.execute("DELETE FROM snapshots WHERE t = ?", (row[0],))
                    try:
                        db_size = _snapshot_db_path.stat().st_size
                    except OSError:
                        db_size = 0
            conn.commit()


def _load_recent_snapshots_db(hours: int = SNAPSHOT_DB_RETENTION_HOURS) -> List[Snapshot]:
    if not _snapshot_db_path.exists():
        return []
    cutoff = _iso_z(datetime.now(timezone.utc) - timedelta(hours=hours))
    out: List[Snapshot] = []
    with _snapshot_db_lock:
        with sqlite3.connect(_snapshot_db_path) as conn:
            rows = conn.execute(
                "SELECT t, stations_json FROM snapshots WHERE t >= ? ORDER BY t ASC",
                (cutoff,),
            ).fetchall()

    for t_iso, stations_json in rows:
        try:
            t = _parse_iso_z(t_iso)
            raw = json.loads(stations_json)
            if not isinstance(raw, list):
                continue
            stations = []
            for item in raw:
                try:
                    stations.append(SurfaceObs(**item))
                except Exception:
                    continue
            out.append(Snapshot(t=t, stations=stations))
        except Exception:
            continue
    return out


def _fetch_archive_snapshot_near(target: datetime, window_minutes: int = 90) -> List[SurfaceObs]:
    """Fetch a historical METAR snapshot near target UTC from IEM ASOS service."""
    target = target.astimezone(timezone.utc).replace(microsecond=0)
    start = target - timedelta(minutes=window_minutes)
    end = target + timedelta(minutes=window_minutes)

    params = {
        "network": "ASOS",
        "data": "all",
        "format": "onlycomma",
        "latlon": "yes",
        "elev": "yes",
        "year1": start.year,
        "month1": start.month,
        "day1": start.day,
        "hour1": start.hour,
        "minute1": start.minute,
        "year2": end.year,
        "month2": end.month,
        "day2": end.day,
        "hour2": end.hour,
        "minute2": end.minute,
        "tz": "Etc/UTC",
    }

    resp = requests.get(IEM_CSV_URL, params=params, headers=REQUEST_HEADERS, timeout=45)
    resp.raise_for_status()

    station_metadata = fetch_station_metadata()
    rows = list(csv.DictReader(StringIO(resp.text)))
    best_rows: dict[str, tuple[float, dict]] = {}

    for row in rows:
        station_code = (row.get("station") or "").strip()
        valid_str = (row.get("valid") or "").strip()
        if not station_code or not valid_str:
            continue
        try:
            dt = datetime.fromisoformat(valid_str.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            valid_dt = dt.astimezone(timezone.utc).replace(microsecond=0)
        except Exception:
            continue

        station_id = parse_station_id(station_code)
        if not station_id:
            continue
        diff_s = abs((valid_dt - target).total_seconds())
        current = best_rows.get(station_id)
        if current is None or diff_s < current[0]:
            best_rows[station_id] = (diff_s, row)

    out: List[SurfaceObs] = []
    for station_id, (_, row) in best_rows.items():
        try:
            lat = float((row.get("lat") or "nan").strip())
            lon = float((row.get("lon") or "nan").strip())
            if lat != lat or lon != lon:
                continue
        except Exception:
            continue

        try:
            temp_f_str = (row.get("tmpf") or "").strip()
            temp_f = float(temp_f_str) if temp_f_str and temp_f_str.lower() not in ("m", "null") else None
        except Exception:
            temp_f = None
        temp_c = fahrenheit_to_celsius(temp_f)
        if temp_c is None:
            continue

        try:
            dwpf_str = (row.get("dwpf") or "").strip()
            dewpoint_f = float(dwpf_str) if dwpf_str and dwpf_str.lower() not in ("m", "null") else None
        except Exception:
            dewpoint_f = None
        dewpoint_c = fahrenheit_to_celsius(dewpoint_f)

        def _maybe_float(key: str) -> Optional[float]:
            try:
                raw = (row.get(key) or "").strip()
                if not raw or raw.lower() in ("m", "null"):
                    return None
                return float(raw)
            except Exception:
                return None

        wind_dir_deg = _maybe_float("drct")
        wind_speed_kt = _maybe_float("sknt")
        wind_gust_kt = _maybe_float("gust")
        visibility_mi = _maybe_float("vsby")
        altimeter_inhg = _maybe_float("alti")
        pressure_mb = _maybe_float("mslp")
        relative_humidity = _maybe_float("relh")

        ceiling_ft = None
        sky_conditions: List[SkyCondition] = []
        for i in range(1, 5):
            skyc = (row.get(f"skyc{i}") or "").strip().upper()
            skyl_raw = (row.get(f"skyl{i}") or "").strip()
            level_ft = None
            if skyl_raw and skyl_raw.lower() not in ("m", "null"):
                try:
                    level_ft = float(skyl_raw)
                except Exception:
                    level_ft = None
            if skyc and skyc not in ("M", "NULL"):
                sky_conditions.append(SkyCondition(cover=skyc, level_ft=round(level_ft) if level_ft is not None else None))
                if ceiling_ft is None and skyc in ("BKN", "OVC") and level_ft is not None:
                    ceiling_ft = level_ft

        flight_rule = calculate_flight_rule(visibility_mi, ceiling_ft)
        weather_codes = (row.get("wxcodes") or "").strip() or None
        raw_metar = (row.get("metar") or "").strip() or None
        obs_time = None
        valid_str = (row.get("valid") or "").strip()
        if valid_str:
            try:
                dt = datetime.fromisoformat(valid_str.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                obs_time = dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            except Exception:
                obs_time = None

        out.append(
            SurfaceObs(
                id=station_id,
                name=station_metadata.get(station_id, station_id),
                lat=round(lat, 4),
                lon=round(lon, 4),
                obsTimeUtc=obs_time,
                tempC=round(temp_c, 1),
                dewpointC=round(dewpoint_c, 1) if dewpoint_c is not None else None,
                windDirDeg=round(wind_dir_deg, 0) if wind_dir_deg is not None else None,
                windSpeedKt=round(wind_speed_kt, 1) if wind_speed_kt is not None else None,
                windGustKt=round(wind_gust_kt, 1) if wind_gust_kt is not None else None,
                visibilityMi=round(visibility_mi, 2) if visibility_mi is not None else None,
                ceilingFt=round(ceiling_ft) if ceiling_ft is not None else None,
                skyConditions=sky_conditions,
                altimeterInhg=round(altimeter_inhg, 2) if altimeter_inhg is not None else None,
                pressureMb=round(pressure_mb, 1) if pressure_mb is not None else None,
                pressureIsEstimated=False,
                relativeHumidity=round(relative_humidity, 1) if relative_humidity is not None else None,
                weatherCodes=weather_codes,
                flightRule=flight_rule,
                rawMetar=raw_metar,
                qcFlags=[],
                analysisExcludeFields=[],
            )
        )

    return out

def _add_snapshot(t: datetime, stations: List[SurfaceObs]) -> None:
    """Append a snapshot and prune."""
    t = t.astimezone(timezone.utc).replace(microsecond=0)

    with _snapshot_lock:
        _snapshot_history.append(Snapshot(t=t, stations=stations))

        # prune by age
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=SNAPSHOT_RETENTION_MIN)
        _snapshot_history[:] = [s for s in _snapshot_history if s.t >= cutoff]

        # prune by size
        if len(_snapshot_history) > SNAPSHOT_MAX_ITEMS:
            _snapshot_history[:] = _snapshot_history[-SNAPSHOT_MAX_ITEMS:]

    try:
        _persist_snapshot_db(t, stations)
    except Exception as e:
        logger.warning(f"Failed to persist snapshot to DB: {e}")

async def update_observations():
    """Fetch and update observations from METAR source."""
    global _latest_obs, _last_update
    t0 = pytime.perf_counter()
    async with _update_lock:
        try:
            logger.info("Fetching METAR observations...")
            # Run synchronous fetch in thread pool to avoid blocking
            raw_obs = await asyncio.to_thread(fetch_current_metars)
            
            # Convert to SurfaceObs models
            new_obs = []
            for obs_dict in raw_obs:
                try:
                    # Skip if missing required fields
                    if obs_dict.get("tempC") is None or obs_dict.get("lat") is None:
                        continue
                    
                    # Convert sky conditions
                    sky_conditions = []
                    for sc in obs_dict.get("skyConditions", []):
                        sky_conditions.append(SkyCondition(
                            cover=sc.get("cover", ""),
                            level_ft=sc.get("level_ft")
                        ))
                    
                    obs = SurfaceObs(
                        id=obs_dict["id"],
                        name=obs_dict["name"],
                        lat=obs_dict["lat"],
                        lon=obs_dict["lon"],
                        obsTimeUtc=obs_dict.get("obsTimeUtc"),
                        tempC=obs_dict["tempC"],
                        dewpointC=obs_dict.get("dewpointC"),
                        windDirDeg=obs_dict.get("windDirDeg"),
                        windSpeedKt=obs_dict.get("windSpeedKt"),
                        windGustKt=obs_dict.get("windGustKt"),
                        visibilityMi=obs_dict.get("visibilityMi"),
                        ceilingFt=obs_dict.get("ceilingFt"),
                        skyConditions=sky_conditions,
                        altimeterInhg=obs_dict.get("altimeterInhg"),
                        pressureMb=obs_dict.get("pressureMb"),
                        pressureIsEstimated=obs_dict.get("pressureIsEstimated", False),
                        relativeHumidity=obs_dict.get("relativeHumidity"),
                        weatherCodes=obs_dict.get("weatherCodes"),
                        flightRule=obs_dict.get("flightRule", "UNKNOWN"),
                        rawMetar=obs_dict.get("rawMetar"),
                        qcFlags=obs_dict.get("qcFlags", []),
                        analysisExcludeFields=obs_dict.get("analysisExcludeFields", []),
                    )
                    new_obs.append(obs)
                except Exception as e:
                    logger.debug(f"Error creating SurfaceObs: {e}")
                    continue
            
            _latest_obs = new_obs
            _last_update = datetime.now(timezone.utc).replace(microsecond=0)

            # Store a snapshot for time slider / animation
            _add_snapshot(_last_update, _latest_obs)

            logger.info(f"Updated observations: {len(_latest_obs)} stations")
            _diag_mark_success("metar", (pytime.perf_counter() - t0) * 1000.0)
        except Exception as e:
            logger.error(f"Error updating observations: {e}")
            _diag_mark_failure("metar", e, (pytime.perf_counter() - t0) * 1000.0)


async def periodic_update_task():
    """Background task that periodically fetches new observations."""
    # Initial fetch on startup
    await update_observations()
    
    # Then update every 5 minutes
    while True:
        await asyncio.sleep(300)  # 5 minutes
        await update_observations()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown tasks."""
    _init_snapshot_db()
    try:
        history = _load_recent_snapshots_db()
        if history:
            with _snapshot_lock:
                _snapshot_history[:] = history
            latest = history[-1]
            global _latest_obs, _last_update
            _latest_obs = latest.stations
            _last_update = latest.t
            logger.info(f"Loaded {len(history)} snapshots from disk")
    except Exception as e:
        logger.warning(f"Failed loading snapshot history from disk: {e}")

    # Startup: start background task
    task = asyncio.create_task(periodic_update_task())
    logger.info("Started METAR update background task")
    
    yield
    
    # Shutdown: cancel task
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    logger.info("Stopped METAR update background task")


app = FastAPI(title="Wx Mesoanalysis API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "last_update": _last_update.isoformat() if _last_update else None,
        "station_count": len(_latest_obs),
        "mrms_cache": _mrms_service.cache_usage(),
    }


def _ops_collect_storage() -> dict:
    components = {
        "data_root": _scan_path_stats(_data_root),
        "snapshots_db": _scan_path_stats(_snapshot_db_path),
        "mrms_cache_total": _scan_path_stats(_data_root / "mrms_cache"),
        "mrms_cache_rala": _scan_path_stats(_data_root / "mrms_cache" / "rala"),
        "mrms_cache_composite": _scan_path_stats(_data_root / "mrms_cache" / "composite"),
        "mrms_cache_etop18": _scan_path_stats(_data_root / "mrms_cache" / "etop18"),
        "mrms_cache_rotation240": _scan_path_stats(_data_root / "mrms_cache" / "rotation240"),
    }
    return {"generated_at": _iso_z(datetime.now(timezone.utc)), "components": components}


def _ops_collect_errors() -> dict:
    with _diag_lock:
        sources = json.loads(json.dumps(_diag_sources))
    return {"generated_at": _iso_z(datetime.now(timezone.utc)), "sources": sources}


def _ops_collect_freshness() -> dict:
    now = datetime.now(timezone.utc)
    metar_latest = _iso_z(_last_update) if _last_update else None

    with _snapshot_lock:
        snapshot_count = len(_snapshot_history)
        latest_snapshot_time = _iso_z(_snapshot_history[-1].t) if _snapshot_history else None
        latest_snapshot_station_count = len(_snapshot_history[-1].stations) if _snapshot_history else 0

    def mrms_product_freshness(product: str) -> dict:
        source = f"mrms:{product}"
        try:
            times = _mrms_service.get_times(product)
            latest = times[-1] if times else None
            age = _age_minutes_from_iso(latest)
            with _diag_lock:
                diag = dict(_diag_sources.get(source, {}))
            return {
                "status": "ok",
                "latest_time": latest,
                "latest_age_minutes": age,
                "available_count": len(times),
                "last_success": diag.get("last_success"),
                "last_failure": diag.get("last_failure"),
                "last_error": diag.get("last_error"),
                "success": int(diag.get("success", 0)),
                "failure": int(diag.get("failure", 0)),
            }
        except Exception as e:
            with _diag_lock:
                diag = dict(_diag_sources.get(source, {}))
            return {
                "status": "error",
                "latest_time": None,
                "latest_age_minutes": None,
                "available_count": 0,
                "error": str(e),
                "last_success": diag.get("last_success"),
                "last_failure": diag.get("last_failure"),
                "last_error": diag.get("last_error"),
                "success": int(diag.get("success", 0)),
                "failure": int(diag.get("failure", 0)),
            }

    wpc_latest: Dict[str, Any]
    try:
        wpc = _wpc_service.get_latest()
        wpc_latest = {
            "status": "ok",
            "valid_time": wpc.get("valid_time"),
            "valid_age_minutes": _age_minutes_from_iso(wpc.get("valid_time")),
            "stale_warning": bool(wpc.get("stale_warning")),
            "expected_cycle_valid_time": wpc.get("expected_cycle_valid_time"),
            "expected_issue_time": wpc.get("expected_issue_time"),
            "overdue_threshold_time": wpc.get("overdue_threshold_time"),
            "overdue_by_minutes": wpc.get("overdue_by_minutes"),
            "front_count": int((wpc.get("counts") or {}).get("fronts", 0)),
            "center_count": int((wpc.get("counts") or {}).get("centers", 0)),
        }
    except Exception as e:
        wpc_latest = {"status": "error", "error": str(e)}

    with _diag_lock:
        metar_diag = dict(_diag_sources.get("metar", {}))

    return {
        "generated_at": _iso_z(now),
        "metar": {
            "latest_update": metar_latest,
            "latest_age_minutes": _age_minutes_from_iso(metar_latest),
            "latest_station_count": len(_latest_obs),
            "latest_snapshot_time": latest_snapshot_time,
            "latest_snapshot_station_count": latest_snapshot_station_count,
            "snapshot_count": snapshot_count,
            "last_success": metar_diag.get("last_success"),
            "last_failure": metar_diag.get("last_failure"),
            "last_error": metar_diag.get("last_error"),
            "success": int(metar_diag.get("success", 0)),
            "failure": int(metar_diag.get("failure", 0)),
        },
        "mrms": {
            "rala": mrms_product_freshness("rala"),
            "composite": mrms_product_freshness("composite"),
            "etop18": mrms_product_freshness("etop18"),
            "rotation240": mrms_product_freshness("rotation240"),
        },
        "wpc": wpc_latest,
    }


def _ops_collect_health() -> dict:
    now = datetime.now(timezone.utc)
    storage = _ops_collect_storage()
    with _diag_lock:
        sources = dict(_diag_sources)

    has_errors = any(int(v.get("failure", 0)) > 0 and not v.get("last_success") for v in sources.values())
    status = "degraded" if has_errors else "ok"

    return {
        "status": status,
        "generated_at": _iso_z(now),
        "uptime_seconds": int((now - _app_started_at).total_seconds()),
        "started_at": _iso_z(_app_started_at),
        "last_update": _iso_z(_last_update) if _last_update else None,
        "station_count": len(_latest_obs),
        "mrms_cache": _mrms_service.cache_usage(),
        "storage_total_bytes": int(((storage.get("components") or {}).get("data_root") or {}).get("bytes", 0)),
        "metar_latest_age_minutes": _age_minutes_from_iso(_iso_z(_last_update) if _last_update else None),
    }


@app.get("/api/ops/health")
def ops_health() -> dict:
    return _ops_collect_health()


@app.get("/api/ops/freshness")
def ops_freshness() -> dict:
    return _ops_collect_freshness()


@app.get("/api/ops/storage")
def ops_storage() -> dict:
    return _ops_collect_storage()


@app.get("/api/ops/errors")
def ops_errors() -> dict:
    return _ops_collect_errors()


@app.get("/api/ops/summary")
def ops_summary() -> dict:
    return {
        "generated_at": _iso_z(datetime.now(timezone.utc)),
        "health": _ops_collect_health(),
        "freshness": _ops_collect_freshness(),
        "storage": _ops_collect_storage(),
        "errors": _ops_collect_errors(),
        "config": {
            "history_window_minutes": 360,
            "snapshot_retention_minutes": SNAPSHOT_RETENTION_MIN,
            "snapshot_db_retention_hours": SNAPSHOT_DB_RETENTION_HOURS,
            "snapshot_near_match_minutes": SNAPSHOT_NEAR_MATCH_MIN,
            "mrms_stale_warn_minutes": 30,
            "mrms_tile_max_zoom": 10,
            "wpc_cycle_hours": 3,
            "wpc_issue_delay_minutes": 75,
            "wpc_overdue_grace_minutes": 30,
        },
    }


@app.get("/api/nws/wpc_surface/latest")
def wpc_surface_latest() -> dict:
    t0 = pytime.perf_counter()
    try:
        out = _wpc_service.get_latest()
        _diag_mark_success("wpc", (pytime.perf_counter() - t0) * 1000.0)
        return out
    except ValueError as e:
        _diag_mark_failure("wpc", e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _diag_mark_failure("wpc", e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=503, detail=f"Failed to fetch WPC surface analysis: {e}")


@app.get("/api/metpy/wx_symbol_map")
def metpy_wx_symbol_map() -> dict:
    try:
        glyphs = _build_metpy_wx_symbol_map()
        return {"glyphs": glyphs, "count": len(glyphs)}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Failed to build MetPy weather symbol map: {e}")


@app.get("/api/metpy/wx_font")
def metpy_wx_font() -> Response:
    try:
        font_path = _find_metpy_wx_font_path()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Failed to locate MetPy weather font: {e}")

    if not font_path.exists():
        raise HTTPException(status_code=404, detail="MetPy weather font not found")

    return Response(
        content=font_path.read_bytes(),
        media_type="font/ttf",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/obs/latest", response_model=ObsResponse)
def latest_obs() -> ObsResponse:
    """Return the latest surface observations from in-memory storage."""
    return ObsResponse(
        generated_at=_last_update or datetime.now(timezone.utc),
        stations=_latest_obs
    )

@app.get("/api/obs/times")
def obs_times(minutes: int = Query(default=360, ge=5, le=24 * 60)) -> dict:
    """Return available snapshot times (UTC ISO strings) within the last N minutes."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)

    with _snapshot_lock:
        times = [_iso_z(s.t) for s in _snapshot_history if s.t >= cutoff]

    return {"times": times}


@app.get("/api/obs/at", response_model=ObsAtResponse)
def obs_at(time: str = Query(..., description="UTC ISO time, e.g. 2025-12-24T18:05:00Z")) -> ObsAtResponse:
    """Return observations for the snapshot nearest to the requested time."""
    try:
        target = _parse_iso_z(time)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid time format; expected ISO like 2025-12-24T18:05:00Z")

    with _snapshot_lock:
        if not _snapshot_history:
            snap = None
            best_diff_min = None
        else:
            snap = min(_snapshot_history, key=lambda s: abs((s.t - target).total_seconds()))
            best_diff_min = abs((snap.t - target).total_seconds()) / 60.0

    if snap is None or (best_diff_min is not None and best_diff_min > SNAPSHOT_NEAR_MATCH_MIN):
        try:
            archive_stations = _fetch_archive_snapshot_near(target)
            if archive_stations:
                _add_snapshot(target, archive_stations)
                snap = Snapshot(t=target, stations=archive_stations)
                logger.info(
                    "Archive backfill snapshot created at %s with %d stations",
                    _iso_z(target),
                    len(archive_stations),
                )
            elif snap is None:
                raise HTTPException(status_code=404, detail="No snapshots available yet")
        except HTTPException:
            raise
        except Exception as e:
            if snap is None:
                raise HTTPException(status_code=503, detail=f"Historical backfill failed: {e}")
            logger.warning("Historical backfill failed for %s: %s", _iso_z(target), e)

    return ObsAtResponse(
        requested_time=_iso_z(target),
        snapshot_time=_iso_z(snap.t),
        generated_at=snap.t,
        stations=snap.stations,
    )


@app.post("/api/obs/refresh")
async def refresh_obs() -> dict:
    """Manually trigger an observation update."""
    await update_observations()
    return {
        "status": "updated",
        "station_count": len(_latest_obs),
        "last_update": _last_update.isoformat() if _last_update else None,
    }


@app.get("/api/geography/artcc")
def artcc_boundaries() -> dict:
    global _artcc_geojson_cache, _artcc_cache_time

    now = datetime.now(timezone.utc)
    if _artcc_geojson_cache is not None and _artcc_cache_time is not None:
        age_min = (now - _artcc_cache_time).total_seconds() / 60.0
        if age_min < ARTCC_CACHE_MINUTES:
            return _artcc_geojson_cache

    geojson = _fetch_artcc_geojson()
    _artcc_geojson_cache = geojson
    _artcc_cache_time = now
    return geojson


@app.get("/api/mrms/times")
def mrms_times(
    product: str = Query(default="rala", description="MRMS product id"),
) -> dict:
    source = f"mrms:{(product or '').strip().lower()}"
    t0 = pytime.perf_counter()
    try:
        out = {"product": product, "times": _mrms_service.get_times(product)}
        _diag_mark_success(source, (pytime.perf_counter() - t0) * 1000.0)
        return out
    except ValueError as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=503, detail=f"Failed to fetch MRMS times: {e}")


@app.get("/api/mrms/meta")
def mrms_meta(
    product: str = Query(default="rala", description="MRMS product id"),
    time: Optional[str] = Query(default=None, description="Requested UTC ISO time"),
) -> dict:
    source = f"mrms:{(product or '').strip().lower()}"
    t0 = pytime.perf_counter()
    try:
        target = _parse_iso_z_optional(time)
    except Exception:
        _diag_mark_failure(source, ValueError("invalid time format"), (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail="Invalid time format; expected ISO like 2025-12-24T18:05:00Z")

    try:
        out = _mrms_service.get_meta(product, target)
        _diag_mark_success(source, (pytime.perf_counter() - t0) * 1000.0)
        return out
    except ValueError as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=503, detail=f"Failed to fetch MRMS metadata: {e}")


@app.get("/api/mrms/image")
def mrms_image(
    product: str = Query(default="rala", description="MRMS product id"),
    time: Optional[str] = Query(default=None, description="Requested UTC ISO time"),
) -> Response:
    source = f"mrms:{(product or '').strip().lower()}"
    t0 = pytime.perf_counter()
    try:
        target = _parse_iso_z_optional(time)
    except Exception:
        _diag_mark_failure(source, ValueError("invalid time format"), (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail="Invalid time format; expected ISO like 2025-12-24T18:05:00Z")

    try:
        png_path, meta = _mrms_service.get_rendered_image(product, target)
    except ValueError as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=503, detail=f"Failed to render MRMS image: {e}")

    if not png_path.exists():
        _diag_mark_failure(source, FileNotFoundError("MRMS image not found"), (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=404, detail="MRMS image not found")

    _diag_mark_success(source, (pytime.perf_counter() - t0) * 1000.0)

    return Response(
        content=png_path.read_bytes(),
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=60",
            "X-MRMS-Matched-Time": meta["matched_time"],
            "X-MRMS-Latest-Time": meta["latest_time"],
            "X-MRMS-Age-Minutes": str(meta["age_minutes"]),
            "X-MRMS-Stale-Warning": "1" if meta["stale_warning"] else "0",
        },
    )


@app.get("/api/mrms/tile/{z}/{x}/{y}.png")
def mrms_tile(
    z: int,
    x: int,
    y: int,
    product: str = Query(default="rala", description="MRMS product id"),
    time: Optional[str] = Query(default=None, description="Requested UTC ISO time"),
) -> Response:
    source = f"mrms:{(product or '').strip().lower()}"
    t0 = pytime.perf_counter()
    try:
        target = _parse_iso_z_optional(time)
    except Exception:
        _diag_mark_failure(source, ValueError("invalid time format"), (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail="Invalid time format; expected ISO like 2025-12-24T18:05:00Z")

    try:
        png_bytes, meta = _mrms_service.get_tile_png(product, target, z, x, y)
    except ValueError as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=503, detail=f"Failed to render MRMS tile: {e}")

    _diag_mark_success(source, (pytime.perf_counter() - t0) * 1000.0)

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=60",
            "X-MRMS-Matched-Time": meta["matched_time"],
            "X-MRMS-Latest-Time": meta["latest_time"],
            "X-MRMS-Age-Minutes": str(meta["age_minutes"]),
            "X-MRMS-Stale-Warning": "1" if meta["stale_warning"] else "0",
        },
    )


@app.get("/api/mrms/value")
def mrms_value(
    product: str = Query(default="rala", description="MRMS product id"),
    time: Optional[str] = Query(default=None, description="Requested UTC ISO time"),
    lat: float = Query(..., description="Latitude"),
    lon: float = Query(..., description="Longitude"),
) -> dict:
    source = f"mrms:{(product or '').strip().lower()}"
    t0 = pytime.perf_counter()
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        _diag_mark_failure(source, ValueError("lat/lon out of range"), (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail="lat/lon out of range")
    try:
        target = _parse_iso_z_optional(time)
    except Exception:
        _diag_mark_failure(source, ValueError("invalid time format"), (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail="Invalid time format; expected ISO like 2025-12-24T18:05:00Z")

    try:
        out = _mrms_service.get_value(product, target, lat=lat, lon=lon)
        _diag_mark_success(source, (pytime.perf_counter() - t0) * 1000.0)
        return out
    except ValueError as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _diag_mark_failure(source, e, (pytime.perf_counter() - t0) * 1000.0)
        raise HTTPException(status_code=503, detail=f"Failed to sample MRMS value: {e}")
