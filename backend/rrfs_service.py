from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from collections import OrderedDict
import json
import math
import os
import re
import threading

import requests

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None  # type: ignore

try:
    import pygrib
except Exception:  # pragma: no cover
    pygrib = None  # type: ignore

try:
    from pyproj import CRS, Transformer
except Exception:  # pragma: no cover
    CRS = None  # type: ignore
    Transformer = None  # type: ignore


AWS_BUCKET_URL = "https://noaa-rrfs-pds.s3.amazonaws.com"
AWS_BUCKET_PREFIX = "rrfs_public"
RRFS_CONUS_BOUNDS = (-126.0, 23.0, -65.0, 51.0)
RRFS_CONUS_PROJ4 = "+proj=lcc +lat_1=30 +lat_2=60 +lat_0=38.5 +lon_0=-97 +datum=WGS84 +units=m +no_defs"
RRFS_ANALYSIS_SPACING_M = 25_000.0
RRFS_CYCLE_INTERVAL_HOURS = 1
RRFS_LOOKBACK_HOURS = 36


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _round_to_hour_half_up(dt: datetime) -> datetime:
    dt_utc = dt.astimezone(timezone.utc).replace(second=0, microsecond=0)
    base = dt_utc.replace(minute=0)
    if dt_utc.minute >= 30:
        base += timedelta(hours=1)
    return base


def _bucket_match_tolerance_minutes(target: datetime, now: Optional[datetime] = None) -> int:
    ref = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age_minutes = max(0.0, (ref - target.astimezone(timezone.utc)).total_seconds() / 60.0)
    return 30 if age_minutes <= 180.0 else 60


def _match_status_from_delta_minutes(delta_minutes: float) -> str:
    delta = abs(delta_minutes)
    if delta <= 1.0:
        return "exact"
    if delta <= 15.0:
        return "near"
    return "approximate"


def _normalize_lon(lon: "np.ndarray") -> "np.ndarray":
    assert np is not None
    return ((lon + 180.0) % 360.0) - 180.0


@dataclass(frozen=True)
class RrfsFieldConfig:
    id: str
    label: str
    variable_names: Tuple[str, ...]
    short_names: Tuple[str, ...]
    level_text: str
    unit_native: str
    candidate_products: Tuple[Tuple[str, str, int], ...]


@dataclass(frozen=True)
class RrfsChartConfig:
    id: str
    label: str
    level_hpa: int
    height_base_m: int
    candidate_products: Tuple[Tuple[str, str, int], ...]
    height_interval_m: int = 30


@dataclass(frozen=True)
class RrfsObject:
    key: str
    url: str
    cycle_time: datetime
    forecast_hour: int
    valid_time: datetime
    family_rank: int
    source: str = "listing"


@dataclass(frozen=True)
class MatchSelection:
    matched: RrfsObject
    requested_time: datetime
    rounded_valid_time: datetime
    match_status: str
    match_delta_minutes: float
    match_tolerance_minutes: int


@dataclass
class ProcessedGrid:
    values_k: "np.ndarray"
    nx: int
    ny: int
    x0_m: float
    y0_m: float
    dx_m: float
    dy_m: float
    init_time: datetime
    valid_time: datetime
    forecast_hour: int
    source_key: str


@dataclass
class ProcessedChart:
    nx: int
    ny: int
    x0_m: float
    y0_m: float
    dx_m: float
    dy_m: float
    init_time: datetime
    valid_time: datetime
    forecast_hour: int
    source_key: str
    height_m: "np.ndarray"
    temperature_c: "np.ndarray"
    dewpoint_c: "np.ndarray"
    relative_humidity_pct: "np.ndarray"
    absolute_vorticity_s1: "np.ndarray"
    divergence_s1: "np.ndarray"
    u_wind_kt: "np.ndarray"
    v_wind_kt: "np.ndarray"


RRFS_FIELDS: Dict[str, RrfsFieldConfig] = {
    "t2m": RrfsFieldConfig(
        id="t2m",
        label="2 m Temperature",
        variable_names=("2 metre temperature", "2 meter temperature", "temperature"),
        short_names=("2t", "tmp"),
        level_text="2 m above ground",
        unit_native="K",
        candidate_products=(
            ("2dfld.3km", "conus", 0),
            ("2dfld.2p5km", "conus", 1),
        ),
    ),
}

RRFS_CHARTS: Dict[str, RrfsChartConfig] = {
    "925mb": RrfsChartConfig(
        id="925mb",
        label="925 MB Analysis",
        level_hpa=925,
        height_base_m=600,
        height_interval_m=30,
        candidate_products=(
            ("prslev.3km", "conus", 0),
            ("prslev.2p5km", "conus", 1),
        ),
    ),
    "850mb": RrfsChartConfig(
        id="850mb",
        label="850 MB Analysis",
        level_hpa=850,
        height_base_m=1500,
        height_interval_m=30,
        candidate_products=(
            ("prslev.3km", "conus", 0),
            ("prslev.2p5km", "conus", 1),
        ),
    ),
    "700mb": RrfsChartConfig(
        id="700mb",
        label="700 MB Analysis",
        level_hpa=700,
        height_base_m=3000,
        height_interval_m=30,
        candidate_products=(
            ("prslev.3km", "conus", 0),
            ("prslev.2p5km", "conus", 1),
        ),
    ),
    "500mb": RrfsChartConfig(
        id="500mb",
        label="500 MB Analysis",
        level_hpa=500,
        height_base_m=5700,
        height_interval_m=60,
        candidate_products=(
            ("prslev.3km", "conus", 0),
            ("prslev.2p5km", "conus", 1),
        ),
    ),
    "300mb": RrfsChartConfig(
        id="300mb",
        label="300 MB Analysis",
        level_hpa=300,
        height_base_m=9000,
        height_interval_m=120,
        candidate_products=(
            ("prslev.3km", "conus", 0),
            ("prslev.2p5km", "conus", 1),
        ),
    ),
}


class RrfsService:
    def __init__(
        self,
        cache_root: Path,
        listing_ttl_seconds: int = 300,
        stale_warn_minutes: int = 240,
        raw_retention_hours: int = 48,
        max_cache_gb: float = 10.0,
    ) -> None:
        self.cache_root = cache_root
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self.listing_ttl_seconds = listing_ttl_seconds
        self.stale_warn_minutes = stale_warn_minutes
        self.raw_retention_hours = raw_retention_hours
        self.max_cache_bytes = int(max_cache_gb * 1024 * 1024 * 1024)
        self._lock = threading.Lock()
        self._listing_cache: Dict[str, Tuple[datetime, List[RrfsObject]]] = {}
        self._processed_cache: "OrderedDict[str, ProcessedGrid]" = OrderedDict()
        self._chart_cache: "OrderedDict[str, ProcessedChart]" = OrderedDict()
        self._path_locks: Dict[str, threading.Lock] = {}
        self._crs_to_analysis = None
        self._crs_to_ll = None
        self._grid_bounds_m = None

    def get_meta(self, field: str, requested_time: datetime) -> dict:
        cfg = self._field(field)
        now = datetime.now(timezone.utc)
        selection = self._select_match(cfg, requested_time, now=now)
        age_minutes = round((now - selection.matched.valid_time).total_seconds() / 60.0, 1)
        stale = age_minutes > self.stale_warn_minutes
        return {
            "field": cfg.id,
            "label": cfg.label,
            "requested_time": _iso_z(requested_time),
            "matched_time": _iso_z(selection.matched.valid_time),
            "latest_time": _iso_z(selection.matched.valid_time),
            "valid_time": _iso_z(selection.matched.valid_time),
            "init_time": _iso_z(selection.matched.cycle_time),
            "forecast_hour": selection.matched.forecast_hour,
            "match_status": selection.match_status,
            "match_delta_minutes": selection.match_delta_minutes,
            "match_tolerance_minutes": selection.match_tolerance_minutes,
            "rounded_valid_time": _iso_z(selection.rounded_valid_time),
            "age_minutes": age_minutes,
            "stale_warning": stale,
            "grid_spacing_km": 25,
            "source_key": selection.matched.key,
        }

    def get_contours(self, field: str, requested_time: datetime, unit: str = "F") -> dict:
        cfg = self._field(field)
        unit_norm = self._unit(unit)
        now = datetime.now(timezone.utc)
        selection = self._select_match(cfg, requested_time, now=now)
        processed = self._get_processed_grid(cfg, selection.matched)
        geojson = self._ensure_contour_geojson(processed, unit_norm)
        meta = self.get_meta(field, requested_time)
        meta["unit"] = unit_norm
        return {
            **meta,
            "contours": geojson,
        }

    def get_value(self, field: str, requested_time: datetime, lat: float, lon: float, unit: str = "F") -> dict:
        cfg = self._field(field)
        unit_norm = self._unit(unit)
        now = datetime.now(timezone.utc)
        selection = self._select_match(cfg, requested_time, now=now)
        processed = self._get_processed_grid(cfg, selection.matched)
        sampled_k = self._sample_processed_grid(processed, lat=lat, lon=lon)
        value = self._convert_temperature(sampled_k, unit_norm) if sampled_k is not None else None
        meta = self.get_meta(field, requested_time)
        meta["unit"] = f"°{unit_norm}"
        meta["lat"] = float(lat)
        meta["lon"] = float(lon)
        meta["value"] = value
        return meta

    def get_freshness(self, field: str) -> dict:
        cfg = self._field(field)
        now = datetime.now(timezone.utc)
        latest = self._latest_available_object(cfg, now)
        return {
            "status": "ok",
            "latest_time": _iso_z(latest.valid_time),
            "latest_age_minutes": round((now - latest.valid_time).total_seconds() / 60.0, 1),
            "latest_init_time": _iso_z(latest.cycle_time),
            "latest_forecast_hour": latest.forecast_hour,
            "latest_source": latest.source,
        }

    def get_chart_meta(self, chart: str, requested_time: datetime) -> dict:
        cfg = self._chart(chart)
        now = datetime.now(timezone.utc)
        selection = self._select_match_for_config(cfg, requested_time, now=now)
        age_minutes = round((now - selection.matched.valid_time).total_seconds() / 60.0, 1)
        stale = age_minutes > self.stale_warn_minutes
        return {
            "chart": cfg.id,
            "label": cfg.label,
            "requested_time": _iso_z(requested_time),
            "matched_time": _iso_z(selection.matched.valid_time),
            "latest_time": _iso_z(selection.matched.valid_time),
            "valid_time": _iso_z(selection.matched.valid_time),
            "init_time": _iso_z(selection.matched.cycle_time),
            "forecast_hour": selection.matched.forecast_hour,
            "match_status": selection.match_status,
            "match_delta_minutes": selection.match_delta_minutes,
            "match_tolerance_minutes": selection.match_tolerance_minutes,
            "rounded_valid_time": _iso_z(selection.rounded_valid_time),
            "age_minutes": age_minutes,
            "stale_warning": stale,
            "grid_spacing_km": 25,
            "source_key": selection.matched.key,
        }

    def get_chart_bundle(self, chart: str, requested_time: datetime) -> dict:
        cfg = self._chart(chart)
        now = datetime.now(timezone.utc)
        selection = self._select_match_for_config(cfg, requested_time, now=now)
        processed = self._get_processed_chart(cfg, selection.matched)
        contours = self._build_upper_air_contours_geojson(cfg, processed)
        winds = self._build_upper_air_wind_geojson(cfg, processed)
        out = self.get_chart_meta(chart, requested_time)
        out["contours"] = contours
        out["winds"] = winds
        if cfg.id == "850mb":
            out["wind_fill"] = self._build_upper_air_wind_fill_geojson(cfg, processed)
        elif cfg.id == "300mb":
            out["wind_fill"] = self._build_upper_air_wind_fill_geojson(cfg, processed)
        elif cfg.id == "700mb":
            out["rh_fill"] = self._build_upper_air_rh_fill_geojson(cfg, processed)
        elif cfg.id == "500mb":
            out["vort_fill"] = self._build_upper_air_vort_fill_geojson(cfg, processed)
        return out

    def get_chart_value(self, chart: str, requested_time: datetime, lat: float, lon: float) -> dict:
        cfg = self._chart(chart)
        now = datetime.now(timezone.utc)
        selection = self._select_match_for_config(cfg, requested_time, now=now)
        processed = self._get_processed_chart(cfg, selection.matched)
        hgt_m = self._sample_chart_grid(processed.height_m, processed, lat=lat, lon=lon)
        tmp_c = self._sample_chart_grid(processed.temperature_c, processed, lat=lat, lon=lon)
        dpt_c = self._sample_chart_grid(processed.dewpoint_c, processed, lat=lat, lon=lon)
        rh_pct = self._sample_chart_grid(processed.relative_humidity_pct, processed, lat=lat, lon=lon)
        absv_s1 = self._sample_chart_grid(processed.absolute_vorticity_s1, processed, lat=lat, lon=lon)
        divg_s1 = self._sample_chart_grid(processed.divergence_s1, processed, lat=lat, lon=lon)
        u_kt = self._sample_chart_grid(processed.u_wind_kt, processed, lat=lat, lon=lon)
        v_kt = self._sample_chart_grid(processed.v_wind_kt, processed, lat=lat, lon=lon)
        wind_dir = None
        wind_speed = None
        if u_kt is not None and v_kt is not None and math.isfinite(u_kt) and math.isfinite(v_kt):
            wind_speed = math.hypot(u_kt, v_kt)
            if wind_speed >= 0.1:
                wind_dir = (math.degrees(math.atan2(-u_kt, -v_kt)) + 360.0) % 360.0
        out = self.get_chart_meta(chart, requested_time)
        out.update(
            {
                "lat": float(lat),
                "lon": float(lon),
                "height_m": hgt_m,
                "temperature_c": tmp_c,
                "dewpoint_c": dpt_c,
                "relative_humidity_pct": rh_pct,
                "absolute_vorticity_s1": absv_s1,
                "divergence_s1": divg_s1,
                "wind_dir_deg": wind_dir,
                "wind_speed_kt": wind_speed,
            }
        )
        return out

    def cache_usage(self) -> dict:
        total = 0
        files = 0
        for p in self.cache_root.rglob("*"):
            if not p.is_file():
                continue
            files += 1
            try:
                total += p.stat().st_size
            except OSError:
                continue
        return {"path": str(self.cache_root), "bytes": total, "files": files}

    def _field(self, field: str) -> RrfsFieldConfig:
        cfg = RRFS_FIELDS.get((field or "").strip().lower())
        if cfg is None:
            raise ValueError(f"Unsupported RRFS field '{field}'")
        return cfg

    def _chart(self, chart: str) -> RrfsChartConfig:
        cfg = RRFS_CHARTS.get((chart or "").strip().lower())
        if cfg is None:
            raise ValueError(f"Unsupported RRFS chart '{chart}'")
        return cfg

    @staticmethod
    def _unit(unit: str) -> str:
        value = (unit or "F").strip().upper()
        if value not in {"F", "C"}:
            raise ValueError("unit must be F or C")
        return value

    def _analysis_transformers(self) -> Tuple["Transformer", "Transformer"]:
        if Transformer is None or CRS is None:
            raise RuntimeError("RRFS processing requires pyproj")
        if self._crs_to_analysis is not None and self._crs_to_ll is not None:
            return self._crs_to_analysis, self._crs_to_ll
        ll = CRS.from_epsg(4326)
        lcc = CRS.from_proj4(RRFS_CONUS_PROJ4)
        self._crs_to_analysis = Transformer.from_crs(ll, lcc, always_xy=True)
        self._crs_to_ll = Transformer.from_crs(lcc, ll, always_xy=True)
        return self._crs_to_analysis, self._crs_to_ll

    def _analysis_grid_spec(self) -> Tuple[float, float, float, float, int, int]:
        if self._grid_bounds_m is not None:
            return self._grid_bounds_m
        to_analysis, _ = self._analysis_transformers()
        min_lon, min_lat, max_lon, max_lat = RRFS_CONUS_BOUNDS
        sample_lons = np.array([min_lon, max_lon, max_lon, min_lon], dtype=np.float64)
        sample_lats = np.array([min_lat, min_lat, max_lat, max_lat], dtype=np.float64)
        xs, ys = to_analysis.transform(sample_lons, sample_lats)
        x0 = math.floor(float(np.nanmin(xs)) / RRFS_ANALYSIS_SPACING_M) * RRFS_ANALYSIS_SPACING_M
        y0 = math.floor(float(np.nanmin(ys)) / RRFS_ANALYSIS_SPACING_M) * RRFS_ANALYSIS_SPACING_M
        x1 = math.ceil(float(np.nanmax(xs)) / RRFS_ANALYSIS_SPACING_M) * RRFS_ANALYSIS_SPACING_M
        y1 = math.ceil(float(np.nanmax(ys)) / RRFS_ANALYSIS_SPACING_M) * RRFS_ANALYSIS_SPACING_M
        nx = int(round((x1 - x0) / RRFS_ANALYSIS_SPACING_M)) + 1
        ny = int(round((y1 - y0) / RRFS_ANALYSIS_SPACING_M)) + 1
        self._grid_bounds_m = (x0, y0, x1, y1, nx, ny)
        return self._grid_bounds_m

    def _cycle_times(self, now: datetime) -> List[datetime]:
        now_utc = now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
        cursor = now_utc
        cycles: List[datetime] = []
        lookback = RRFS_LOOKBACK_HOURS + 2
        for _ in range(lookback):
            cycles.append(cursor)
            cursor -= timedelta(hours=1)
        return cycles

    def _select_match(self, cfg: RrfsFieldConfig, requested_time: datetime, now: Optional[datetime] = None) -> MatchSelection:
        return self._select_match_for_config(cfg, requested_time, now=now)

    def _select_match_for_config(self, cfg: Any, requested_time: datetime, now: Optional[datetime] = None) -> MatchSelection:
        ref = now or datetime.now(timezone.utc)
        target_valid = _round_to_hour_half_up(requested_time)
        tolerance_minutes = _bucket_match_tolerance_minutes(target_valid, now=ref)
        for cycle_time in self._cycle_times(ref):
            forecast_hour = int(round((target_valid - cycle_time).total_seconds() / 3600.0))
            if forecast_hour < 0:
                continue
            matched = self._resolve_object_for_forecast(cfg, cycle_time, forecast_hour)
            if matched is not None:
                delta_minutes = round((matched.valid_time - requested_time).total_seconds() / 60.0, 1)
                return MatchSelection(
                    matched=matched,
                    requested_time=requested_time,
                    rounded_valid_time=target_valid,
                    match_status=_match_status_from_delta_minutes(delta_minutes),
                    match_delta_minutes=delta_minutes,
                    match_tolerance_minutes=tolerance_minutes,
                )
        raise FileNotFoundError(
            f"No RRFS {cfg.id} field available for valid time {_iso_z(target_valid)} "
            f"within recent {RRFS_LOOKBACK_HOURS}h cycle window"
        )

    def _latest_available_object(self, cfg: RrfsFieldConfig, now: datetime) -> RrfsObject:
        return self._latest_available_object_for_config(cfg, now)

    def _latest_available_object_for_config(self, cfg: Any, now: datetime) -> RrfsObject:
        # Fast-path freshness probe: prefer the most recent cycle's analysis hour,
        # then fall back through recent cycles with forecast hours 0..6 only.
        for cycle_time in self._cycle_times(now):
            for forecast_hour in range(0, 7):
                obj = self._resolve_object_for_forecast(cfg, cycle_time, forecast_hour)
                if obj is not None:
                    return obj
        raise FileNotFoundError("No RRFS files available from public source")

    def _objects_for_cycle(self, cfg: RrfsFieldConfig, cycle_time: datetime) -> List[RrfsObject]:
        return self._objects_for_cycle_config(cfg, cycle_time)

    def _objects_for_cycle_config(self, cfg: Any, cycle_time: datetime) -> List[RrfsObject]:
        cache_key = f"{cfg.id}:{cycle_time:%Y%m%d%H}"
        now = datetime.now(timezone.utc)
        with self._lock:
            cached = self._listing_cache.get(cache_key)
            if cached is not None and (now - cached[0]).total_seconds() <= self.listing_ttl_seconds:
                return cached[1]

        candidates: List[RrfsObject] = []
        max_fhr = 60 if cycle_time.hour in {0, 6, 12, 18} else 18
        for forecast_hour in range(0, max_fhr + 1):
            obj = self._resolve_object_for_forecast(cfg, cycle_time, forecast_hour)
            if obj is not None:
                candidates.append(obj)

        with self._lock:
            self._listing_cache[cache_key] = (now, candidates)
        return candidates

    def _resolve_object_for_forecast(self, cfg: RrfsFieldConfig, cycle_time: datetime, forecast_hour: int) -> Optional[RrfsObject]:
        for family, domain, family_rank in cfg.candidate_products:
            key = (
                f"{AWS_BUCKET_PREFIX}/rrfs.{cycle_time:%Y%m%d}/{cycle_time:%H}/"
                f"rrfs.t{cycle_time:%H}z.{family}.f{forecast_hour:03d}.{domain}.grib2"
            )
            url = f"{AWS_BUCKET_URL}/{key}"
            if self._remote_exists(url):
                return RrfsObject(
                    key=key,
                    url=url,
                    cycle_time=cycle_time,
                    forecast_hour=forecast_hour,
                    valid_time=cycle_time + timedelta(hours=forecast_hour),
                    family_rank=family_rank,
                    source="head",
                )
        return None

    def _parse_key_to_object(self, key: str, cycle_time: datetime) -> Optional[RrfsObject]:
        name = os.path.basename(key)
        if not name.endswith(".grib2"):
            return None
        if ".conus.grib2" not in name:
            return None
        match = re.match(r"rrfs\.t\d{2}z\.(?P<family>.+)\.f(?P<fhr>\d{3})\.conus\.grib2$", name)
        if not match:
            return None
        family = match.group("family").lower()
        forecast_hour = int(match.group("fhr"))
        family_rank = self._family_rank(family)
        valid_time = cycle_time + timedelta(hours=forecast_hour)
        return RrfsObject(
            key=key,
            url=f"{AWS_BUCKET_URL}/{key}",
            cycle_time=cycle_time,
            forecast_hour=forecast_hour,
            valid_time=valid_time,
            family_rank=family_rank,
        )

    @staticmethod
    def _family_rank(family: str) -> int:
        ordered = [
            "natlev.3km",
            "sfcf.3km",
            "phys.3km",
            "prslev.3km",
        ]
        for idx, token in enumerate(ordered):
            if token in family:
                return idx
        if "prslev" in family:
            return len(ordered) + 2
        return len(ordered) + 1

    def _remote_exists(self, url: str) -> bool:
        try:
            resp = requests.head(url, timeout=2.5, allow_redirects=True)
            if resp.status_code == 200:
                return True
            if resp.status_code in {301, 302, 303, 307, 308}:
                return False
            if resp.status_code == 403:
                # Some public S3 objects can reject HEAD while allowing GET range.
                range_resp = requests.get(url, headers={"Range": "bytes=0-0"}, timeout=2.5)
                return range_resp.status_code in {200, 206}
            return False
        except Exception:
            return False

    def _processed_cache_key(self, cfg: RrfsFieldConfig, obj: RrfsObject) -> str:
        return f"{cfg.id}:{obj.cycle_time:%Y%m%d%H}:f{obj.forecast_hour:03d}"

    def _processed_cache_path(self, cfg: RrfsFieldConfig, obj: RrfsObject) -> Path:
        return self.cache_root / cfg.id / "grids" / obj.cycle_time.strftime("%Y%m%d%H") / f"f{obj.forecast_hour:03d}.npz"

    def _contour_cache_path(self, cfg: RrfsFieldConfig, obj: RrfsObject, unit: str) -> Path:
        return self.cache_root / cfg.id / "contours" / unit / obj.cycle_time.strftime("%Y%m%d%H") / f"f{obj.forecast_hour:03d}.geojson"

    def _raw_path(self, cfg: RrfsFieldConfig, obj: RrfsObject) -> Path:
        return self.cache_root / cfg.id / "raw" / obj.cycle_time.strftime("%Y%m%d") / obj.cycle_time.strftime("%H") / os.path.basename(obj.key)

    def _path_lock(self, path: Path) -> threading.Lock:
        key = str(path)
        with self._lock:
            lock = self._path_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._path_locks[key] = lock
            return lock

    def _get_processed_grid(self, cfg: RrfsFieldConfig, obj: RrfsObject) -> ProcessedGrid:
        cache_key = self._processed_cache_key(cfg, obj)
        with self._lock:
            cached = self._processed_cache.get(cache_key)
            if cached is not None:
                self._processed_cache.move_to_end(cache_key)
                return cached

        path = self._processed_cache_path(cfg, obj)
        if path.exists() and path.stat().st_size > 0:
            processed = self._load_processed_grid(path)
        else:
            lock = self._path_lock(path)
            with lock:
                if path.exists() and path.stat().st_size > 0:
                    processed = self._load_processed_grid(path)
                else:
                    processed = self._build_processed_grid(cfg, obj)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    np.savez_compressed(
                        path,
                        values_k=processed.values_k.astype(np.float32),
                        nx=np.int32(processed.nx),
                        ny=np.int32(processed.ny),
                        x0_m=np.float64(processed.x0_m),
                        y0_m=np.float64(processed.y0_m),
                        dx_m=np.float64(processed.dx_m),
                        dy_m=np.float64(processed.dy_m),
                        init_time=np.array(_iso_z(processed.init_time)),
                        valid_time=np.array(_iso_z(processed.valid_time)),
                        forecast_hour=np.int32(processed.forecast_hour),
                        source_key=np.array(processed.source_key),
                    )
        with self._lock:
            self._processed_cache[cache_key] = processed
            while len(self._processed_cache) > 8:
                self._processed_cache.popitem(last=False)
        return processed

    def _load_processed_grid(self, path: Path) -> ProcessedGrid:
        if np is None:
            raise RuntimeError("RRFS processing requires numpy")
        data = np.load(path, allow_pickle=False)
        return ProcessedGrid(
            values_k=data["values_k"].astype(np.float64),
            nx=int(data["nx"]),
            ny=int(data["ny"]),
            x0_m=float(data["x0_m"]),
            y0_m=float(data["y0_m"]),
            dx_m=float(data["dx_m"]),
            dy_m=float(data["dy_m"]),
            init_time=datetime.fromisoformat(str(data["init_time"]).replace("Z", "+00:00")),
            valid_time=datetime.fromisoformat(str(data["valid_time"]).replace("Z", "+00:00")),
            forecast_hour=int(data["forecast_hour"]),
            source_key=str(data["source_key"]),
        )

    def _build_processed_grid(self, cfg: RrfsFieldConfig, obj: RrfsObject) -> ProcessedGrid:
        if np is None or pygrib is None:
            raise RuntimeError("RRFS processing requires numpy and pygrib")
        raw_path = self._ensure_raw_download(cfg, obj)
        values_k, lats, lons = self._extract_field(raw_path, cfg)
        coarse = self._regrid_mean_to_analysis(values_k, lats, lons)
        smoothed = self._two_pass_barnes(coarse, spacing_m=RRFS_ANALYSIS_SPACING_M)
        x0, y0, _, _, nx, ny = self._analysis_grid_spec()
        return ProcessedGrid(
            values_k=smoothed,
            nx=nx,
            ny=ny,
            x0_m=x0,
            y0_m=y0,
            dx_m=RRFS_ANALYSIS_SPACING_M,
            dy_m=RRFS_ANALYSIS_SPACING_M,
            init_time=obj.cycle_time,
            valid_time=obj.valid_time,
            forecast_hour=obj.forecast_hour,
            source_key=obj.key,
        )

    def _chart_cache_key(self, cfg: RrfsChartConfig, obj: RrfsObject) -> str:
        return f"{cfg.id}:{obj.cycle_time:%Y%m%d%H}:f{obj.forecast_hour:03d}"

    def _chart_cache_path(self, cfg: RrfsChartConfig, obj: RrfsObject) -> Path:
        return self.cache_root / cfg.id / "charts" / obj.cycle_time.strftime("%Y%m%d%H") / f"f{obj.forecast_hour:03d}.npz"

    def _chart_raw_path(self, cfg: RrfsChartConfig, obj: RrfsObject) -> Path:
        return self.cache_root / cfg.id / "raw" / obj.cycle_time.strftime("%Y%m%d") / obj.cycle_time.strftime("%H") / os.path.basename(obj.key)

    def _get_processed_chart(self, cfg: RrfsChartConfig, obj: RrfsObject) -> ProcessedChart:
        cache_key = self._chart_cache_key(cfg, obj)
        with self._lock:
            cached = self._chart_cache.get(cache_key)
            if cached is not None:
                self._chart_cache.move_to_end(cache_key)
                return cached

        path = self._chart_cache_path(cfg, obj)
        if path.exists() and path.stat().st_size > 0:
            processed = self._load_processed_chart(path)
        else:
            lock = self._path_lock(path)
            with lock:
                if path.exists() and path.stat().st_size > 0:
                    processed = self._load_processed_chart(path)
                else:
                    processed = self._build_processed_chart(cfg, obj)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    np.savez_compressed(
                        path,
                        nx=np.int32(processed.nx),
                        ny=np.int32(processed.ny),
                        x0_m=np.float64(processed.x0_m),
                        y0_m=np.float64(processed.y0_m),
                        dx_m=np.float64(processed.dx_m),
                        dy_m=np.float64(processed.dy_m),
                        init_time=np.array(_iso_z(processed.init_time)),
                        valid_time=np.array(_iso_z(processed.valid_time)),
                        forecast_hour=np.int32(processed.forecast_hour),
                        source_key=np.array(processed.source_key),
                        height_m=processed.height_m.astype(np.float32),
                        temperature_c=processed.temperature_c.astype(np.float32),
                        dewpoint_c=processed.dewpoint_c.astype(np.float32),
                        relative_humidity_pct=processed.relative_humidity_pct.astype(np.float32),
                        absolute_vorticity_s1=processed.absolute_vorticity_s1.astype(np.float32),
                        divergence_s1=processed.divergence_s1.astype(np.float32),
                        u_wind_kt=processed.u_wind_kt.astype(np.float32),
                        v_wind_kt=processed.v_wind_kt.astype(np.float32),
                    )
        with self._lock:
            self._chart_cache[cache_key] = processed
            while len(self._chart_cache) > 6:
                self._chart_cache.popitem(last=False)
        return processed

    def _load_processed_chart(self, path: Path) -> ProcessedChart:
        if np is None:
            raise RuntimeError("RRFS processing requires numpy")
        data = np.load(path, allow_pickle=False)
        return ProcessedChart(
            nx=int(data["nx"]),
            ny=int(data["ny"]),
            x0_m=float(data["x0_m"]),
            y0_m=float(data["y0_m"]),
            dx_m=float(data["dx_m"]),
            dy_m=float(data["dy_m"]),
            init_time=datetime.fromisoformat(str(data["init_time"]).replace("Z", "+00:00")),
            valid_time=datetime.fromisoformat(str(data["valid_time"]).replace("Z", "+00:00")),
            forecast_hour=int(data["forecast_hour"]),
            source_key=str(data["source_key"]),
            height_m=data["height_m"].astype(np.float64),
            temperature_c=data["temperature_c"].astype(np.float64),
            dewpoint_c=data["dewpoint_c"].astype(np.float64),
            relative_humidity_pct=data["relative_humidity_pct"].astype(np.float64),
            absolute_vorticity_s1=data["absolute_vorticity_s1"].astype(np.float64) if "absolute_vorticity_s1" in data.files else np.full_like(data["height_m"], np.nan, dtype=np.float64),
            divergence_s1=data["divergence_s1"].astype(np.float64) if "divergence_s1" in data.files else np.full_like(data["height_m"], np.nan, dtype=np.float64),
            u_wind_kt=data["u_wind_kt"].astype(np.float64),
            v_wind_kt=data["v_wind_kt"].astype(np.float64),
        )

    def _build_processed_chart(self, cfg: RrfsChartConfig, obj: RrfsObject) -> ProcessedChart:
        if np is None or pygrib is None:
            raise RuntimeError("RRFS processing requires numpy and pygrib")
        raw_path = self._ensure_chart_raw_download(cfg, obj)
        extracted = self._extract_pressure_level_fields(raw_path, cfg.level_hpa)
        x0, y0, _, _, nx, ny = self._analysis_grid_spec()

        height_m = self._two_pass_barnes(
            self._regrid_mean_to_analysis(extracted["height_m"], extracted["lats"], extracted["lons"]),
            spacing_m=RRFS_ANALYSIS_SPACING_M,
        )
        temperature_c = self._two_pass_barnes(
            self._regrid_mean_to_analysis(extracted["temperature_c"], extracted["lats"], extracted["lons"]),
            spacing_m=RRFS_ANALYSIS_SPACING_M,
        )
        dewpoint_c = self._two_pass_barnes(
            self._regrid_mean_to_analysis(extracted["dewpoint_c"], extracted["lats"], extracted["lons"]),
            spacing_m=RRFS_ANALYSIS_SPACING_M,
        )
        relative_humidity_pct = self._two_pass_barnes(
            self._regrid_mean_to_analysis(extracted["relative_humidity_pct"], extracted["lats"], extracted["lons"]),
            spacing_m=RRFS_ANALYSIS_SPACING_M,
        )
        absolute_vorticity_s1 = self._two_pass_barnes(
            self._regrid_mean_to_analysis(extracted["absolute_vorticity_s1"], extracted["lats"], extracted["lons"]),
            spacing_m=RRFS_ANALYSIS_SPACING_M,
        ) if "absolute_vorticity_s1" in extracted else np.full((ny, nx), np.nan, dtype=np.float64)
        u_wind_kt = self._two_pass_barnes(
            self._regrid_mean_to_analysis(extracted["u_wind_kt"], extracted["lats"], extracted["lons"]),
            spacing_m=RRFS_ANALYSIS_SPACING_M,
        )
        v_wind_kt = self._two_pass_barnes(
            self._regrid_mean_to_analysis(extracted["v_wind_kt"], extracted["lats"], extracted["lons"]),
            spacing_m=RRFS_ANALYSIS_SPACING_M,
        )
        divergence_s1 = self._compute_divergence_from_uv(u_wind_kt, v_wind_kt, dx_m=RRFS_ANALYSIS_SPACING_M, dy_m=RRFS_ANALYSIS_SPACING_M)

        return ProcessedChart(
            nx=nx,
            ny=ny,
            x0_m=x0,
            y0_m=y0,
            dx_m=RRFS_ANALYSIS_SPACING_M,
            dy_m=RRFS_ANALYSIS_SPACING_M,
            init_time=obj.cycle_time,
            valid_time=obj.valid_time,
            forecast_hour=obj.forecast_hour,
            source_key=obj.key,
            height_m=height_m,
            temperature_c=temperature_c,
            dewpoint_c=dewpoint_c,
            relative_humidity_pct=relative_humidity_pct,
            absolute_vorticity_s1=absolute_vorticity_s1,
            divergence_s1=divergence_s1,
            u_wind_kt=u_wind_kt,
            v_wind_kt=v_wind_kt,
        )

    def _ensure_chart_raw_download(self, cfg: RrfsChartConfig, obj: RrfsObject) -> Path:
        target = self._chart_raw_path(cfg, obj)
        if target.exists() and target.stat().st_size > 0:
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        lock = self._path_lock(target)
        with lock:
            if target.exists() and target.stat().st_size > 0:
                return target
            tmp = target.with_suffix(target.suffix + ".tmp")
            resp = requests.get(obj.url, timeout=180)
            resp.raise_for_status()
            tmp.write_bytes(resp.content)
            tmp.replace(target)
        return target

    def _ensure_raw_download(self, cfg: RrfsFieldConfig, obj: RrfsObject) -> Path:
        target = self._raw_path(cfg, obj)
        if target.exists() and target.stat().st_size > 0:
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        lock = self._path_lock(target)
        with lock:
            if target.exists() and target.stat().st_size > 0:
                return target
            tmp = target.with_suffix(target.suffix + ".tmp")
            resp = requests.get(obj.url, timeout=180)
            resp.raise_for_status()
            tmp.write_bytes(resp.content)
            tmp.replace(target)
        return target

    def _extract_field(self, path: Path, cfg: RrfsFieldConfig) -> Tuple["np.ndarray", "np.ndarray", "np.ndarray"]:
        assert pygrib is not None
        with pygrib.open(str(path)) as grbs:
            candidates = []
            for grb in grbs:
                name = str(getattr(grb, "name", "") or "").lower()
                short_name = str(getattr(grb, "shortName", "") or "").lower()
                type_of_level = str(getattr(grb, "typeOfLevel", "") or "").lower()
                level = getattr(grb, "level", None)
                level_text = f"{level} m above ground" if type_of_level == "heightaboveground" and level is not None else ""
                if short_name not in cfg.short_names and not any(token in name for token in cfg.variable_names):
                    continue
                if type_of_level == "heightaboveground" and int(level or -999) == 2:
                    candidates.append(grb)
                    continue
                descriptor = f"{name} {type_of_level} {level_text}".lower()
                if cfg.level_text.lower() in descriptor:
                    candidates.append(grb)
            if not candidates:
                raise RuntimeError(f"RRFS field {cfg.id} not found in {path.name}")
            grb = candidates[0]
            values = np.asarray(grb.values, dtype=np.float64)
            lats, lons = grb.latlons()
            return values, np.asarray(lats, dtype=np.float64), np.asarray(lons, dtype=np.float64)

    def _extract_pressure_level_fields(self, path: Path, level_hpa: int) -> Dict[str, "np.ndarray"]:
        assert pygrib is not None
        found: Dict[str, "np.ndarray"] = {}
        lats = None
        lons = None

        def is_target_level(level_value: object) -> bool:
            try:
                level_float = float(level_value)
            except Exception:
                return False
            return abs(level_float - float(level_hpa)) <= 0.5 or abs(level_float - float(level_hpa * 100)) <= 1.0

        def classify_field(short_name: str, name: str) -> Optional[str]:
            sn = short_name.lower()
            nm = name.lower()
            if sn in {"hgt", "gh"} or "geopotential height" in nm:
                return "height_m"
            if sn in {"tmp", "t"} or ("temperature" in nm and "dew point" not in nm and "virtual" not in nm):
                return "temperature_k"
            if sn == "dpt" or "dew point" in nm:
                return "dewpoint_k"
            if sn in {"r", "rh"} or "relative humidity" in nm:
                return "relative_humidity_pct"
            if sn in {"absv", "avo"} or "absolute vorticity" in nm:
                return "absolute_vorticity_s1"
            if sn in {"ugrd", "u"} or "u component of wind" in nm:
                return "u_wind_ms"
            if sn in {"vgrd", "v"} or "v component of wind" in nm:
                return "v_wind_ms"
            return None

        with pygrib.open(str(path)) as grbs:
            for grb in grbs:
                short_name = str(getattr(grb, "shortName", "") or "").lower()
                name = str(getattr(grb, "name", "") or "")
                level = getattr(grb, "level", None)
                if not is_target_level(level):
                    continue
                mapped = classify_field(short_name, name)
                if mapped is None or mapped in found:
                    continue
                found[mapped] = np.asarray(grb.values, dtype=np.float64)
                if lats is None or lons is None:
                    ll = grb.latlons()
                    lats = np.asarray(ll[0], dtype=np.float64)
                    lons = np.asarray(ll[1], dtype=np.float64)
                if len(found) >= 7:
                    break
        required = {"height_m", "temperature_k", "dewpoint_k", "relative_humidity_pct", "u_wind_ms", "v_wind_ms"}
        if len(required - set(found)) > 0 or lats is None or lons is None:
            missing = sorted(required - set(found))
            raise RuntimeError(f"RRFS {level_hpa} mb chart is missing fields in {path.name}: {', '.join(missing)}")
        out = {
            "lats": lats,
            "lons": lons,
            "height_m": found["height_m"],
            "temperature_c": found["temperature_k"] - 273.15,
            "dewpoint_c": found["dewpoint_k"] - 273.15,
            "relative_humidity_pct": found["relative_humidity_pct"],
            "u_wind_kt": found["u_wind_ms"] * 1.9438444924406,
            "v_wind_kt": found["v_wind_ms"] * 1.9438444924406,
        }
        if "absolute_vorticity_s1" in found:
            out["absolute_vorticity_s1"] = found["absolute_vorticity_s1"]
        return out

    def _regrid_mean_to_analysis(self, values, lats, lons) -> "np.ndarray":
        if np is None:
            raise RuntimeError("RRFS processing requires numpy")
        to_analysis, _ = self._analysis_transformers()
        x0, y0, x1, y1, nx, ny = self._analysis_grid_spec()
        vals = np.asarray(values, dtype=np.float64)
        lats2 = np.asarray(lats, dtype=np.float64)
        lons2 = _normalize_lon(np.asarray(lons, dtype=np.float64))
        xs, ys = to_analysis.transform(lons2, lats2)

        flat_vals = vals.ravel()
        flat_x = np.asarray(xs, dtype=np.float64).ravel()
        flat_y = np.asarray(ys, dtype=np.float64).ravel()
        mask = (
            np.isfinite(flat_vals)
            & np.isfinite(flat_x)
            & np.isfinite(flat_y)
            & (flat_x >= x0)
            & (flat_x <= x1)
            & (flat_y >= y0)
            & (flat_y <= y1)
        )
        if not np.any(mask):
            raise RuntimeError("RRFS field extraction produced no valid CONUS points")
        flat_vals = flat_vals[mask]
        flat_x = flat_x[mask]
        flat_y = flat_y[mask]
        ii = np.rint((flat_x - x0) / RRFS_ANALYSIS_SPACING_M).astype(np.int32)
        jj = np.rint((flat_y - y0) / RRFS_ANALYSIS_SPACING_M).astype(np.int32)
        inside = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < ny)
        ii = ii[inside]
        jj = jj[inside]
        flat_vals = flat_vals[inside]
        flat_idx = jj * nx + ii
        sums = np.bincount(flat_idx, weights=flat_vals, minlength=nx * ny).astype(np.float64)
        counts = np.bincount(flat_idx, minlength=nx * ny).astype(np.float64)
        coarse = np.full(nx * ny, np.nan, dtype=np.float64)
        valid = counts > 0
        coarse[valid] = sums[valid] / counts[valid]
        return coarse.reshape((ny, nx))

    def _compute_divergence_from_uv(self, u_wind_kt: "np.ndarray", v_wind_kt: "np.ndarray", dx_m: float, dy_m: float) -> "np.ndarray":
        assert np is not None
        u_ms = np.asarray(u_wind_kt, dtype=np.float64) * 0.5144444444444445
        v_ms = np.asarray(v_wind_kt, dtype=np.float64) * 0.5144444444444445
        ny, nx = u_ms.shape
        out = np.full((ny, nx), np.nan, dtype=np.float64)
        for j in range(ny):
            for i in range(nx):
                u_c = float(u_ms[j, i])
                v_c = float(v_ms[j, i])
                if not math.isfinite(u_c) or not math.isfinite(v_c):
                    continue

                if 0 < i < nx - 1 and math.isfinite(float(u_ms[j, i - 1])) and math.isfinite(float(u_ms[j, i + 1])):
                    du_dx = (float(u_ms[j, i + 1]) - float(u_ms[j, i - 1])) / (2.0 * dx_m)
                elif i < nx - 1 and math.isfinite(float(u_ms[j, i + 1])):
                    du_dx = (float(u_ms[j, i + 1]) - u_c) / dx_m
                elif i > 0 and math.isfinite(float(u_ms[j, i - 1])):
                    du_dx = (u_c - float(u_ms[j, i - 1])) / dx_m
                else:
                    continue

                if 0 < j < ny - 1 and math.isfinite(float(v_ms[j - 1, i])) and math.isfinite(float(v_ms[j + 1, i])):
                    dv_dy = (float(v_ms[j + 1, i]) - float(v_ms[j - 1, i])) / (2.0 * dy_m)
                elif j < ny - 1 and math.isfinite(float(v_ms[j + 1, i])):
                    dv_dy = (float(v_ms[j + 1, i]) - v_c) / dy_m
                elif j > 0 and math.isfinite(float(v_ms[j - 1, i])):
                    dv_dy = (v_c - float(v_ms[j - 1, i])) / dy_m
                else:
                    continue

                out[j, i] = du_dx + dv_dy
        return out

    def _barnes_kernel(self, spacing_m: float, radius_cells: int, kappa_m2: float) -> List[Tuple[int, int, float]]:
        kernel: List[Tuple[int, int, float]] = []
        for dj in range(-radius_cells, radius_cells + 1):
            for di in range(-radius_cells, radius_cells + 1):
                dist2 = (di * spacing_m) ** 2 + (dj * spacing_m) ** 2
                weight = math.exp(-dist2 / max(kappa_m2, 1.0))
                kernel.append((dj, di, weight))
        return kernel

    def _barnes_pass(self, grid: "np.ndarray", spacing_m: float, radius_cells: int, kappa_m2: float) -> "np.ndarray":
        assert np is not None
        ny, nx = grid.shape
        out = np.full((ny, nx), np.nan, dtype=np.float64)
        kernel = self._barnes_kernel(spacing_m, radius_cells, kappa_m2)
        for j in range(ny):
            j0 = max(0, j - radius_cells)
            j1 = min(ny - 1, j + radius_cells)
            for i in range(nx):
                i0 = max(0, i - radius_cells)
                i1 = min(nx - 1, i + radius_cells)
                wsum = 0.0
                vsum = 0.0
                for dj, di, weight in kernel:
                    jj = j + dj
                    ii = i + di
                    if jj < j0 or jj > j1 or ii < i0 or ii > i1:
                        continue
                    value = grid[jj, ii]
                    if not math.isfinite(float(value)):
                        continue
                    wsum += weight
                    vsum += weight * float(value)
                if wsum > 0:
                    out[j, i] = vsum / wsum
        return out

    def _two_pass_barnes(self, coarse_grid: "np.ndarray", spacing_m: float) -> "np.ndarray":
        assert np is not None
        first = self._barnes_pass(coarse_grid, spacing_m, radius_cells=5, kappa_m2=(90_000.0 ** 2))
        residual = np.full_like(coarse_grid, np.nan, dtype=np.float64)
        valid = np.isfinite(coarse_grid) & np.isfinite(first)
        residual[valid] = coarse_grid[valid] - first[valid]
        second = self._barnes_pass(residual, spacing_m, radius_cells=3, kappa_m2=(45_000.0 ** 2))
        out = np.array(first, copy=True)
        correction_mask = np.isfinite(second)
        out[correction_mask] = out[correction_mask] + second[correction_mask]
        # Preserve any original values if isolated cells remain missing after smoothing.
        original_only = np.isfinite(coarse_grid) & ~np.isfinite(out)
        out[original_only] = coarse_grid[original_only]
        return out

    def _ensure_contour_geojson(self, processed: ProcessedGrid, unit: str) -> dict:
        cfg = RRFS_FIELDS["t2m"]
        dummy_obj = RrfsObject(
            key=processed.source_key,
            url="",
            cycle_time=processed.init_time,
            forecast_hour=processed.forecast_hour,
            valid_time=processed.valid_time,
            family_rank=0,
        )
        path = self._contour_cache_path(cfg, dummy_obj, unit)
        if path.exists() and path.stat().st_size > 0:
            return json.loads(path.read_text())
        lock = self._path_lock(path)
        with lock:
            if path.exists() and path.stat().st_size > 0:
                return json.loads(path.read_text())
            out = self._build_temperature_contours_geojson(processed, unit)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(out, separators=(",", ":")))
            return out

    def _build_temperature_contours_geojson(self, processed: ProcessedGrid, unit: str) -> dict:
        assert np is not None
        values = self._convert_temperature(processed.values_k, unit)
        interval = 5 if unit == "F" else 2
        freezing = 32 if unit == "F" else 0
        finite = values[np.isfinite(values)]
        if finite.size == 0:
            return {"type": "FeatureCollection", "features": []}
        start = int(math.floor(float(np.nanmin(finite)) / interval) * interval)
        end = int(math.ceil(float(np.nanmax(finite)) / interval) * interval)
        levels = list(range(start, end + interval, interval))
        _, to_ll = self._analysis_transformers()
        features: List[dict] = []
        for level in levels:
            segments = self._contours_for_level(values, processed, float(level))
            contour_kind = "freezing" if level == freezing else ("cold" if level < freezing else "warm")
            for seg in segments:
                if len(seg) < 2:
                    continue
                xs = np.array([pt[0] for pt in seg], dtype=np.float64)
                ys = np.array([pt[1] for pt in seg], dtype=np.float64)
                lons, lats = to_ll.transform(xs, ys)
                coords = []
                for lon, lat in zip(lons, lats):
                    lonf = float(lon)
                    latf = float(lat)
                    if not math.isfinite(lonf) or not math.isfinite(latf):
                        continue
                    coords.append([lonf, latf])
                if len(coords) < 2:
                    continue
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {"type": "LineString", "coordinates": coords},
                        "properties": {
                            "field": "t2m",
                            "level": float(level),
                            "unit": unit,
                            "contour_kind": contour_kind,
                            "is_freezing": contour_kind == "freezing",
                        },
                    }
                )
        return {"type": "FeatureCollection", "features": features}

    def _contours_for_level(self, values: "np.ndarray", processed: ProcessedGrid, level: float) -> List[List[Tuple[float, float]]]:
        ny, nx = values.shape
        raw_segments: List[List[Tuple[float, float]]] = []

        def interp(a: float, b: float, t: float) -> float:
            return a + (b - a) * t

        for j in range(ny - 1):
            for i in range(nx - 1):
                v00 = values[j, i]
                v10 = values[j, i + 1]
                v11 = values[j + 1, i + 1]
                v01 = values[j + 1, i]
                if not (
                    math.isfinite(float(v00))
                    and math.isfinite(float(v10))
                    and math.isfinite(float(v11))
                    and math.isfinite(float(v01))
                ):
                    continue
                case_idx = 0
                if v00 >= level:
                    case_idx |= 1
                if v10 >= level:
                    case_idx |= 2
                if v11 >= level:
                    case_idx |= 4
                if v01 >= level:
                    case_idx |= 8
                if case_idx in (0, 15):
                    continue

                x0 = processed.x0_m + i * processed.dx_m
                x1 = x0 + processed.dx_m
                y0 = processed.y0_m + j * processed.dy_m
                y1 = y0 + processed.dy_m

                points: Dict[int, Tuple[float, float]] = {}

                def edge_point(edge: int) -> Tuple[float, float]:
                    if edge in points:
                        return points[edge]
                    if edge == 0:
                        t = 0.5 if abs(v10 - v00) < 1e-6 else (level - v00) / (v10 - v00)
                        pt = (interp(x0, x1, t), y0)
                    elif edge == 1:
                        t = 0.5 if abs(v11 - v10) < 1e-6 else (level - v10) / (v11 - v10)
                        pt = (x1, interp(y0, y1, t))
                    elif edge == 2:
                        t = 0.5 if abs(v11 - v01) < 1e-6 else (level - v01) / (v11 - v01)
                        pt = (interp(x0, x1, t), y1)
                    else:
                        t = 0.5 if abs(v01 - v00) < 1e-6 else (level - v00) / (v01 - v00)
                        pt = (x0, interp(y0, y1, t))
                    points[edge] = pt
                    return pt

                # Standard marching-squares edge pairs.
                edge_pairs = {
                    1: [(3, 0)],
                    2: [(0, 1)],
                    3: [(3, 1)],
                    4: [(1, 2)],
                    5: [(3, 2), (0, 1)],
                    6: [(0, 2)],
                    7: [(3, 2)],
                    8: [(2, 3)],
                    9: [(0, 2)],
                    10: [(0, 3), (1, 2)],
                    11: [(1, 2)],
                    12: [(1, 3)],
                    13: [(0, 1)],
                    14: [(3, 0)],
                }
                for edge_a, edge_b in edge_pairs.get(case_idx, []):
                    raw_segments.append([edge_point(edge_a), edge_point(edge_b)])
        return self._stitch_contour_segments(raw_segments)

    def _stitch_contour_segments(self, segments: List[List[Tuple[float, float]]]) -> List[List[Tuple[float, float]]]:
        if not segments:
            return []

        def key_for_point(pt: Tuple[float, float]) -> Tuple[int, int]:
            # Bucket endpoints to 1 m cells. This is loose enough to absorb
            # floating-point interpolation noise without accidentally joining
            # nearby but distinct contours on the 25 km analysis grid.
            return (int(round(pt[0])), int(round(pt[1])))

        node_points: Dict[Tuple[int, int], Tuple[float, float]] = {}
        edges: List[Tuple[Tuple[int, int], Tuple[int, int]]] = []
        adjacency: Dict[Tuple[int, int], List[int]] = {}
        for seg in segments:
            if len(seg) < 2:
                continue
            a = key_for_point(seg[0])
            b = key_for_point(seg[-1])
            node_points.setdefault(a, seg[0])
            node_points.setdefault(b, seg[-1])
            edge_id = len(edges)
            edges.append((a, b))
            adjacency.setdefault(a, []).append(edge_id)
            adjacency.setdefault(b, []).append(edge_id)

        used_edges = [False] * len(edges)
        stitched: List[List[Tuple[float, float]]] = []

        def walk_path(start_node: Tuple[int, int], initial_edge: int) -> List[Tuple[float, float]]:
            line: List[Tuple[float, float]] = [node_points[start_node]]
            current = start_node
            edge_id = initial_edge
            while True:
                used_edges[edge_id] = True
                a, b = edges[edge_id]
                nxt = b if a == current else a
                line.append(node_points[nxt])
                next_edge: Optional[int] = None
                for cand in adjacency.get(nxt, []):
                    if used_edges[cand]:
                        continue
                    next_edge = cand
                    break
                if next_edge is None:
                    break
                current = nxt
                edge_id = next_edge
            return line

        for edge_id, (a, b) in enumerate(edges):
            if used_edges[edge_id]:
                continue
            deg_a = len(adjacency.get(a, []))
            deg_b = len(adjacency.get(b, []))
            start = a if deg_a == 1 or deg_a < deg_b else b
            stitched.append(walk_path(start, edge_id))

        # Drop degenerate fragments that are still only two identical points.
        out: List[List[Tuple[float, float]]] = []
        for line in stitched:
            if len(line) < 2:
                continue
            deduped = [line[0]]
            for pt in line[1:]:
                if not self._points_close(pt, deduped[-1], tol=0.1):
                    deduped.append(pt)
            if len(deduped) >= 2:
                out.append(deduped)
        return out

    @staticmethod
    def _points_close(a: Tuple[float, float], b: Tuple[float, float], tol: float = 10.0) -> bool:
        return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol

    def _build_upper_air_contours_geojson(self, cfg: RrfsChartConfig, processed: ProcessedChart) -> dict:
        assert np is not None
        _, to_ll = self._analysis_transformers()
        features: List[dict] = []

        def add_member(
            values: "np.ndarray",
            member: str,
            levels: List[float],
            contour_kind_fn,
        ) -> None:
            for level in levels:
                segments = self._contours_for_level(values, processed, float(level))
                contour_kind = contour_kind_fn(float(level))
                for seg in segments:
                    if len(seg) < 2:
                        continue
                    xs = np.array([pt[0] for pt in seg], dtype=np.float64)
                    ys = np.array([pt[1] for pt in seg], dtype=np.float64)
                    lons, lats = to_ll.transform(xs, ys)
                    coords: List[List[float]] = []
                    for lon, lat in zip(lons, lats):
                        lonf = float(lon)
                        latf = float(lat)
                        if not math.isfinite(lonf) or not math.isfinite(latf):
                            continue
                        coords.append([lonf, latf])
                    if len(coords) < 2:
                        continue
                    length_km = self._polyline_length_km(seg)
                    features.append(
                        {
                            "type": "Feature",
                            "geometry": {"type": "LineString", "coordinates": coords},
                            "properties": {
                                "chart": cfg.id,
                                "member": member,
                                "role": "line",
                                "level": float(level),
                                "contour_kind": contour_kind,
                                "label_text": f"{int(round(level))}",
                                "length_km": length_km,
                            },
                        }
                    )
                    label_feature = self._build_contour_label_feature(cfg.id, coords, member, float(level), contour_kind)
                    if label_feature is not None:
                        features.append(label_feature)

        hgt_vals = processed.height_m
        hgt_finite = hgt_vals[np.isfinite(hgt_vals)]
        if hgt_finite.size > 0:
            base = cfg.height_base_m
            interval = cfg.height_interval_m
            k0 = int(math.floor((float(np.nanmin(hgt_finite)) - base) / interval))
            k1 = int(math.ceil((float(np.nanmax(hgt_finite)) - base) / interval))
            levels = [float(base + k * interval) for k in range(k0, k1 + 1)]
            add_member(hgt_vals, "height", levels, lambda _level: "height")

        tmp_vals = processed.temperature_c
        tmp_finite = tmp_vals[np.isfinite(tmp_vals)]
        if cfg.id != "300mb" and tmp_finite.size > 0:
            interval = 2
            start = int(math.floor(float(np.nanmin(tmp_finite)) / interval) * interval)
            end = int(math.ceil(float(np.nanmax(tmp_finite)) / interval) * interval)
            levels = [float(v) for v in range(start, end + interval, interval)]
            add_member(
                tmp_vals,
                "temperature",
                levels,
                lambda level: "freezing" if abs(level) < 1e-6 else ("cold" if level < 0 else "warm"),
            )

        if cfg.id in {"925mb", "850mb"}:
            dpt_masked = np.array(processed.dewpoint_c, copy=True)
            dpt_masked[dpt_masked < 10.0] = np.nan
            dpt_finite = dpt_masked[np.isfinite(dpt_masked)]
            if dpt_finite.size > 0:
                interval = 2
                start = max(10, int(math.floor(float(np.nanmin(dpt_finite)) / interval) * interval))
                end = int(math.ceil(float(np.nanmax(dpt_finite)) / interval) * interval)
                levels = [float(v) for v in range(start, end + interval, interval)]
                add_member(dpt_masked, "dewpoint", levels, lambda _level: "dewpoint")

        if cfg.id == "300mb":
            div_masked = np.array(processed.divergence_s1, copy=True)
            div_masked[div_masked < 2.0e-5] = np.nan
            div_finite = div_masked[np.isfinite(div_masked)]
            if div_finite.size > 0:
                interval = 2.0e-5
                start = max(interval, math.floor(float(np.nanmin(div_finite)) / interval) * interval)
                end = math.ceil(float(np.nanmax(div_finite)) / interval) * interval
                levels = []
                value = start
                while value <= end + 1.0e-12:
                    levels.append(float(value))
                    value += interval
                add_member(div_masked, "divergence", levels, lambda _level: "divergence")

        return {"type": "FeatureCollection", "features": features}

    def _build_contour_label_feature(
        self,
        chart_id: str,
        coords: List[List[float]],
        member: str,
        level: float,
        contour_kind: str,
    ) -> Optional[dict]:
        if len(coords) < 2:
            return None
        total = 0.0
        for idx in range(1, len(coords)):
            dx = coords[idx][0] - coords[idx - 1][0]
            dy = coords[idx][1] - coords[idx - 1][1]
            total += math.hypot(dx, dy)
        # Coordinates are in lon/lat degrees here. Keep only medium-to-long
        # contour segments so labels remain available without flooding the map.
        if total < 0.22:
            return None
        target = total / 2.0
        walked = 0.0
        for idx in range(1, len(coords)):
            x0, y0 = coords[idx - 1]
            x1, y1 = coords[idx]
            seg_len = math.hypot(x1 - x0, y1 - y0)
            if seg_len <= 0:
                continue
            if walked + seg_len >= target:
                frac = (target - walked) / seg_len
                lon = x0 + (x1 - x0) * frac
                lat = y0 + (y1 - y0) * frac
                return {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        "chart": chart_id,
                        "member": member,
                        "role": "label",
                        "level": float(level),
                        "contour_kind": contour_kind,
                        "label_text": f"{int(round(level))}",
                    },
                }
            walked += seg_len
        return None

    def _polyline_length_km(self, seg: List[Tuple[float, float]]) -> float:
        total_m = 0.0
        for idx in range(1, len(seg)):
            total_m += math.hypot(seg[idx][0] - seg[idx - 1][0], seg[idx][1] - seg[idx - 1][1])
        return total_m / 1000.0

    def _build_upper_air_wind_geojson(self, cfg: RrfsChartConfig, processed: ProcessedChart) -> dict:
        assert np is not None
        _, to_ll = self._analysis_transformers()
        features: List[dict] = []
        for j in range(processed.ny):
            ys = processed.y0_m + j * processed.dy_m
            for i in range(processed.nx):
                u = float(processed.u_wind_kt[j, i])
                v = float(processed.v_wind_kt[j, i])
                if not math.isfinite(u) or not math.isfinite(v):
                    continue
                speed = math.hypot(u, v)
                if speed < 2.0:
                    continue
                xs = processed.x0_m + i * processed.dx_m
                lon, lat = to_ll.transform(xs, ys)
                if not math.isfinite(float(lon)) or not math.isfinite(float(lat)):
                    continue
                direction = (math.degrees(math.atan2(-u, -v)) + 360.0) % 360.0
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                        "properties": {
                            "chart": cfg.id,
                            "grid_i": i,
                            "grid_j": j,
                            "wind_dir_deg": direction,
                            "wind_speed_kt": speed,
                        },
                    }
                )
        return {"type": "FeatureCollection", "features": features}

    def _build_upper_air_wind_fill_geojson(self, cfg: RrfsChartConfig, processed: ProcessedChart) -> dict:
        assert np is not None
        _, to_ll = self._analysis_transformers()
        features: List[dict] = []
        speed_kt = np.hypot(processed.u_wind_kt, processed.v_wind_kt)
        for j in range(processed.ny):
            ys = processed.y0_m + j * processed.dy_m
            for i in range(processed.nx):
                speed = float(speed_kt[j, i])
                if not math.isfinite(speed):
                    continue
                xs = processed.x0_m + i * processed.dx_m
                lon, lat = to_ll.transform(xs, ys)
                if not math.isfinite(float(lon)) or not math.isfinite(float(lat)):
                    continue
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                        "properties": {
                            "chart": cfg.id,
                            "grid_i": i,
                            "grid_j": j,
                            "wind_speed_kt": speed,
                        },
                    }
                )
        return {"type": "FeatureCollection", "features": features}

    def _build_upper_air_rh_fill_geojson(self, cfg: RrfsChartConfig, processed: ProcessedChart) -> dict:
        assert np is not None
        _, to_ll = self._analysis_transformers()
        features: List[dict] = []
        for j in range(processed.ny):
            ys = processed.y0_m + j * processed.dy_m
            for i in range(processed.nx):
                rh = float(processed.relative_humidity_pct[j, i])
                if not math.isfinite(rh):
                    continue
                xs = processed.x0_m + i * processed.dx_m
                lon, lat = to_ll.transform(xs, ys)
                if not math.isfinite(float(lon)) or not math.isfinite(float(lat)):
                    continue
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                        "properties": {
                            "chart": cfg.id,
                            "grid_i": i,
                            "grid_j": j,
                            "relative_humidity_pct": rh,
                        },
                    }
                )
        return {"type": "FeatureCollection", "features": features}

    def _build_upper_air_vort_fill_geojson(self, cfg: RrfsChartConfig, processed: ProcessedChart) -> dict:
        assert np is not None
        _, to_ll = self._analysis_transformers()
        features: List[dict] = []
        for j in range(processed.ny):
            ys = processed.y0_m + j * processed.dy_m
            for i in range(processed.nx):
                vort = float(processed.absolute_vorticity_s1[j, i])
                if not math.isfinite(vort):
                    continue
                xs = processed.x0_m + i * processed.dx_m
                lon, lat = to_ll.transform(xs, ys)
                if not math.isfinite(float(lon)) or not math.isfinite(float(lat)):
                    continue
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                        "properties": {
                            "chart": cfg.id,
                            "grid_i": i,
                            "grid_j": j,
                            "absolute_vorticity_s1": vort,
                        },
                    }
                )
        return {"type": "FeatureCollection", "features": features}

    def _sample_chart_grid(self, values: "np.ndarray", processed: ProcessedChart, lat: float, lon: float) -> Optional[float]:
        dummy = ProcessedGrid(
            values_k=values,
            nx=processed.nx,
            ny=processed.ny,
            x0_m=processed.x0_m,
            y0_m=processed.y0_m,
            dx_m=processed.dx_m,
            dy_m=processed.dy_m,
            init_time=processed.init_time,
            valid_time=processed.valid_time,
            forecast_hour=processed.forecast_hour,
            source_key=processed.source_key,
        )
        return self._sample_processed_grid(dummy, lat=lat, lon=lon)

    def _sample_processed_grid(self, processed: ProcessedGrid, lat: float, lon: float) -> Optional[float]:
        to_analysis, _ = self._analysis_transformers()
        x, y = to_analysis.transform(lon, lat)
        gx = (x - processed.x0_m) / processed.dx_m
        gy = (y - processed.y0_m) / processed.dy_m
        i0 = int(math.floor(gx))
        j0 = int(math.floor(gy))
        i1 = i0 + 1
        j1 = j0 + 1
        if i0 < 0 or j0 < 0 or i1 >= processed.nx or j1 >= processed.ny:
            return None
        v00 = processed.values_k[j0, i0]
        v10 = processed.values_k[j0, i1]
        v01 = processed.values_k[j1, i0]
        v11 = processed.values_k[j1, i1]
        if not (
            math.isfinite(float(v00))
            and math.isfinite(float(v10))
            and math.isfinite(float(v01))
            and math.isfinite(float(v11))
        ):
            return None
        tx = gx - i0
        ty = gy - j0
        a = v00 * (1 - tx) + v10 * tx
        b = v01 * (1 - tx) + v11 * tx
        return float(a * (1 - ty) + b * ty)

    def _convert_temperature(self, values_k, unit: str):
        if np is None:
            raise RuntimeError("RRFS processing requires numpy")
        arr = np.asarray(values_k, dtype=np.float64)
        if unit == "C":
            return arr - 273.15
        return (arr - 273.15) * 9.0 / 5.0 + 32.0
