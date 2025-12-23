from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
import asyncio
import logging
from contextlib import asynccontextmanager

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


# In-memory store for latest obs (will be replaced by DB later)
_latest_obs: List[SurfaceObs] = []
_last_update: Optional[datetime] = None
_update_lock = asyncio.Lock()


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
            _last_update = datetime.now(timezone.utc)
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


@app.post("/api/obs/refresh")
async def refresh_obs() -> dict:
    """Manually trigger an observation update."""
    await update_observations()
    return {
        "status": "updated",
        "station_count": len(_latest_obs),
        "last_update": _last_update.isoformat() if _last_update else None,
    }


