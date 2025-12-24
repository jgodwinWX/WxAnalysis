from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
import asyncio
import logging
from contextlib import asynccontextmanager

from dataclasses import dataclass
from datetime import timedelta
import threading
from fastapi import Query, HTTPException

from metar_fetcher import fetch_current_metars

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

# Tune these:
SNAPSHOT_MAX_ITEMS = 2000       # max snapshots to keep
SNAPSHOT_RETENTION_MIN = 6 * 60 # 6 hours (minutes) for pruning; can be larger than API default

def _parse_iso_z(s: str) -> datetime:
    # expects ISO with Z; accepts offsets too
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt.astimezone(timezone.utc).replace(microsecond=0)

def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

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

async def update_observations():
    """Fetch and update observations from METAR source."""
    global _latest_obs, _last_update
    
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
            
        except Exception as e:
            logger.error(f"Error updating observations: {e}")


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
    }


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
            raise HTTPException(status_code=404, detail="No snapshots available yet")

        snap = min(_snapshot_history, key=lambda s: abs((s.t - target).total_seconds()))

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


