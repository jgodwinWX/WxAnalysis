from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import math
import re
import threading
import xml.etree.ElementTree as ET

import requests

try:
    import numpy as np
    from PIL import Image
except Exception:  # pragma: no cover
    np = None  # type: ignore
    Image = None  # type: ignore

try:
    import netCDF4
except Exception:  # pragma: no cover
    netCDF4 = None  # type: ignore


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _bucket_match_tolerance_minutes(target: datetime, now: Optional[datetime] = None) -> int:
    ref = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age_minutes = max(0.0, (ref - target.astimezone(timezone.utc)).total_seconds() / 60.0)
    return 10 if age_minutes <= 60.0 else 15


def _match_status_from_delta_minutes(delta_minutes: float) -> str:
    delta = abs(delta_minutes)
    if delta <= 2.0:
        return "exact"
    if delta <= 5.0:
        return "near"
    return "approximate"


def _extract_glm_times(filename: str) -> Tuple[Optional[datetime], Optional[datetime]]:
    start_match = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})", filename)
    end_match = re.search(r"_e(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})", filename)
    if not start_match or not end_match:
        return None, None
    start = datetime(int(start_match.group(1)), 1, 1, tzinfo=timezone.utc) + timedelta(
        days=int(start_match.group(2)) - 1,
        hours=int(start_match.group(3)),
        minutes=int(start_match.group(4)),
        seconds=int(start_match.group(5)),
    )
    end = datetime(int(end_match.group(1)), 1, 1, tzinfo=timezone.utc) + timedelta(
        days=int(end_match.group(2)) - 1,
        hours=int(end_match.group(3)),
        minutes=int(end_match.group(4)),
        seconds=int(end_match.group(5)),
    )
    return start, end


@dataclass(frozen=True)
class GlmProductConfig:
    id: str
    satellite: str
    sector: str
    bucket: str
    prefix_root: str
    satellite_label: str
    sector_label: str
    unit: str


@dataclass(frozen=True)
class GlmFile:
    valid_time: datetime
    start_time: datetime
    end_time: datetime
    filename: str
    url: str
    source: str = "listing"


@dataclass(frozen=True)
class MatchSelection:
    matched: GlmFile
    latest: GlmFile
    requested_time: Optional[datetime]
    match_status: str
    match_delta_minutes: float
    match_tolerance_minutes: Optional[int]


@dataclass
class GlmFrameData:
    values: "np.ndarray"
    lat_axis: "np.ndarray"
    lon_axis: "np.ndarray"
    width: int
    height: int
    bounds: Tuple[float, float, float, float]
    corners: Tuple[Tuple[float, float], Tuple[float, float], Tuple[float, float], Tuple[float, float]]
    files_used: List[str]


GLM_TILE_SIZE = 256
GLM_TILE_MAX_ZOOM = 9
GLM_ACCUMULATION_MINUTES = 5
GLM_DEGREES_PER_CELL = 0.1
GLM_BOUNDS = (-130.0, 12.0, -55.0, 55.0)
GLM_MIN_DISPLAY_VALUE = 1.0

GLM_PRODUCTS: Dict[str, GlmProductConfig] = {
    "east-conus-fed": GlmProductConfig(
        id="east-conus-fed",
        satellite="east",
        sector="conus",
        bucket="noaa-goes19",
        prefix_root="GLM-L2-LCFA",
        satellite_label="GOES-E",
        sector_label="CONUS",
        unit="flashes/5 min",
    ),
    "west-conus-fed": GlmProductConfig(
        id="west-conus-fed",
        satellite="west",
        sector="conus",
        bucket="noaa-goes18",
        prefix_root="GLM-L2-LCFA",
        satellite_label="GOES-W",
        sector_label="CONUS",
        unit="flashes/5 min",
    ),
}

GLM_LEGEND_BINS: Tuple[Tuple[float, float, Tuple[int, int, int]], ...] = (
    (1.0, 2.0, (173, 216, 230)),
    (2.0, 5.0, (70, 130, 180)),
    (5.0, 10.0, (255, 215, 0)),
    (10.0, 20.0, (255, 140, 0)),
    (20.0, 999999.0, (220, 38, 38)),
)


class GlmService:
    def __init__(
        self,
        cache_root: Path,
        history_minutes: int = 360,
        stale_warn_minutes: int = 45,
        listing_ttl_seconds: int = 120,
        raw_retention_minutes: int = 12 * 60,
        max_cache_gb: float = 6.0,
        cleanup_interval_minutes: int = 10,
    ) -> None:
        self.cache_root = cache_root
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self.history_minutes = history_minutes
        self.stale_warn_minutes = stale_warn_minutes
        self.listing_ttl_seconds = listing_ttl_seconds
        self.raw_retention_minutes = raw_retention_minutes
        self.max_cache_bytes = int(max_cache_gb * 1024 * 1024 * 1024)
        self.cleanup_interval = timedelta(minutes=cleanup_interval_minutes)
        self._listing_cache: Dict[str, Tuple[datetime, List[GlmFile]]] = {}
        self._exact_file_cache: Dict[str, Tuple[datetime, GlmFile]] = {}
        self._frame_cache: "OrderedDict[str, GlmFrameData]" = OrderedDict()
        self._frame_locks: Dict[str, threading.Lock] = {}
        self._lock = threading.Lock()
        self._last_cleanup: Optional[datetime] = None

        min_lon, min_lat, max_lon, max_lat = GLM_BOUNDS
        self._lon_axis = np.arange(min_lon, max_lon + 1e-6, GLM_DEGREES_PER_CELL, dtype=np.float32) if np is not None else None
        self._lat_axis = np.arange(max_lat, min_lat - 1e-6, -GLM_DEGREES_PER_CELL, dtype=np.float32) if np is not None else None

    def get_meta(self, product: str, requested_time: Optional[datetime]) -> dict:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        selection = self._select_or_resolve(cfg, requested_time, now)
        matched = selection.matched
        latest = selection.latest
        self._remember_exact_file(cfg, matched)
        self._remember_exact_file(cfg, latest)
        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        min_lon, min_lat, max_lon, max_lat = GLM_BOUNDS
        corners = [
            [min_lon, max_lat],
            [max_lon, max_lat],
            [max_lon, min_lat],
            [min_lon, min_lat],
        ]
        self._cleanup_if_needed(now)
        return {
            "product": cfg.id,
            "satellite": cfg.satellite,
            "sector": cfg.sector,
            "label": self._label_for_product(cfg),
            "unit": cfg.unit,
            "accumulation_minutes": GLM_ACCUMULATION_MINUTES,
            "requested_time": _iso_z(requested_time) if requested_time else None,
            "matched_time": _iso_z(matched.valid_time),
            "latest_time": _iso_z(latest.valid_time),
            "matched_source": matched.source,
            "latest_source": latest.source,
            "match_status": selection.match_status,
            "match_delta_minutes": selection.match_delta_minutes,
            "match_tolerance_minutes": selection.match_tolerance_minutes,
            "age_minutes": round(age_min, 1),
            "stale_warning": stale,
            "available_times": [_iso_z(f.valid_time) for f in self._recent_files(cfg, now)],
            "image_url": f"/api/glm/image?product={cfg.id}&time={_iso_z(matched.valid_time)}",
            "tile_url_template": f"/api/glm/tile/{{z}}/{{x}}/{{y}}.png?product={cfg.id}&time={_iso_z(matched.valid_time)}",
            "bbox": {
                "min_lon": min_lon,
                "min_lat": min_lat,
                "max_lon": max_lon,
                "max_lat": max_lat,
            },
            "corners": corners,
        }

    def get_times(self, product: str) -> List[str]:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        return [_iso_z(f.valid_time) for f in files]

    def get_value(self, product: str, requested_time: Optional[datetime], lat: float, lon: float) -> dict:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        selection = self._select_or_resolve(cfg, requested_time, now)
        matched = selection.matched
        latest = selection.latest
        frame = self._get_frame_data(cfg, matched)
        raw_value = self._sample_frame_value(frame, lat, lon)
        value = round(raw_value, 1) if raw_value is not None else None
        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        self._cleanup_if_needed(now)
        return {
            "product": cfg.id,
            "satellite": cfg.satellite,
            "sector": cfg.sector,
            "label": self._label_for_product(cfg),
            "requested_time": _iso_z(requested_time) if requested_time else None,
            "matched_time": _iso_z(matched.valid_time),
            "latest_time": _iso_z(latest.valid_time),
            "matched_source": matched.source,
            "latest_source": latest.source,
            "match_status": selection.match_status,
            "match_delta_minutes": selection.match_delta_minutes,
            "match_tolerance_minutes": selection.match_tolerance_minutes,
            "age_minutes": round(age_min, 1),
            "stale_warning": stale,
            "lat": float(lat),
            "lon": float(lon),
            "unit": cfg.unit,
            "value": value,
            "raw_value": raw_value,
        }

    def get_tile_png(
        self,
        product: str,
        requested_time: Optional[datetime],
        z: int,
        x: int,
        y: int,
        tile_size: int = GLM_TILE_SIZE,
        max_zoom: int = GLM_TILE_MAX_ZOOM,
    ) -> Tuple[bytes, dict]:
        if z < 0 or x < 0 or y < 0:
            raise ValueError("Invalid tile coordinates")
        if z > max_zoom:
            scale = 1 << (z - max_zoom)
            z = max_zoom
            x = x // scale
            y = y // scale

        n = 1 << z
        if x >= n or y >= n:
            raise ValueError("Tile x/y out of range for zoom")

        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        selection = self._select_or_resolve(cfg, requested_time, now)
        matched = selection.matched
        latest = selection.latest
        tile_path = self._tile_cache_path(cfg, matched, z, x, y, tile_size, max_zoom)
        if tile_path.exists() and tile_path.stat().st_size > 0:
            png_bytes = tile_path.read_bytes()
        else:
            frame = self._get_frame_data(cfg, matched)
            png_bytes = self._render_tile_from_frame(frame, z, x, y, tile_size)
            tile_path.parent.mkdir(parents=True, exist_ok=True)
            tile_path.write_bytes(png_bytes)

        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        self._cleanup_if_needed(now)
        return png_bytes, {
            "matched_time": _iso_z(matched.valid_time),
            "latest_time": _iso_z(latest.valid_time),
            "matched_source": matched.source,
            "latest_source": latest.source,
            "match_status": selection.match_status,
            "match_delta_minutes": selection.match_delta_minutes,
            "match_tolerance_minutes": selection.match_tolerance_minutes,
            "age_minutes": round(age_min, 1),
            "stale_warning": stale,
        }

    def get_rendered_image(self, product: str, requested_time: Optional[datetime]) -> Tuple[Path, dict]:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        selection = self._select_or_resolve(cfg, requested_time, now)
        matched = selection.matched
        latest = selection.latest
        png_path = self._ensure_preview_png(cfg, matched)
        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        self._cleanup_if_needed(now)
        return png_path, {
            "matched_time": _iso_z(matched.valid_time),
            "latest_time": _iso_z(latest.valid_time),
            "matched_source": matched.source,
            "latest_source": latest.source,
            "match_status": selection.match_status,
            "match_delta_minutes": selection.match_delta_minutes,
            "match_tolerance_minutes": selection.match_tolerance_minutes,
            "age_minutes": round(age_min, 1),
            "stale_warning": stale,
        }

    def get_freshness(self, product: str) -> dict:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        latest = files[-1]
        return {
            "status": "ok",
            "latest_time": _iso_z(latest.valid_time),
            "latest_age_minutes": round((now - latest.valid_time).total_seconds() / 60.0, 1),
            "latest_source": latest.source,
            "available_count": len(files),
        }

    def cache_usage(self) -> dict:
        total = 0
        file_count = 0
        for p in self.cache_root.rglob("*"):
            if not p.is_file():
                continue
            total += p.stat().st_size
            file_count += 1
        return {"path": str(self.cache_root), "bytes": total, "files": file_count}

    def _product(self, product: str) -> GlmProductConfig:
        key = (product or "").strip().lower()
        cfg = GLM_PRODUCTS.get(key)
        if cfg is None:
            raise ValueError(f"Unsupported GLM product '{product}'")
        return cfg

    def _exact_cache_key(self, cfg: GlmProductConfig, valid_time: datetime) -> str:
        return f"{cfg.id}:{_iso_z(valid_time)}"

    def _remember_exact_file(self, cfg: GlmProductConfig, item: GlmFile) -> None:
        with self._lock:
            self._exact_file_cache[self._exact_cache_key(cfg, item.valid_time)] = (datetime.now(timezone.utc), item)
            if len(self._exact_file_cache) > 512:
                oldest_key = min(self._exact_file_cache.items(), key=lambda kv: kv[1][0])[0]
                self._exact_file_cache.pop(oldest_key, None)

    def _cached_exact_file(self, cfg: GlmProductConfig, requested_time: Optional[datetime]) -> Optional[GlmFile]:
        if requested_time is None:
            return None
        key = self._exact_cache_key(cfg, requested_time)
        with self._lock:
            entry = self._exact_file_cache.get(key)
        if entry is None:
            return None
        cached_at, item = entry
        if (datetime.now(timezone.utc) - cached_at).total_seconds() > self.listing_ttl_seconds * 5:
            with self._lock:
                self._exact_file_cache.pop(key, None)
            return None
        return item

    def _select_or_resolve(self, cfg: GlmProductConfig, requested_time: Optional[datetime], now: datetime) -> MatchSelection:
        cached = self._cached_exact_file(cfg, requested_time)
        if cached is not None:
            return MatchSelection(
                matched=cached,
                latest=cached,
                requested_time=requested_time,
                match_status="exact",
                match_delta_minutes=0.0,
                match_tolerance_minutes=_bucket_match_tolerance_minutes(requested_time, now=now) if requested_time else None,
            )
        files = self._recent_files(cfg, now)
        selection = self._select_match(files, requested_time, now=now)
        self._remember_exact_file(cfg, selection.matched)
        self._remember_exact_file(cfg, selection.latest)
        return selection

    def _recent_files(self, cfg: GlmProductConfig, now: datetime) -> List[GlmFile]:
        cutoff = now - timedelta(minutes=self.history_minutes)
        files: Dict[str, GlmFile] = {}
        hour_cursor = cutoff.replace(minute=0, second=0, microsecond=0)
        hour_end = now.replace(minute=0, second=0, microsecond=0)
        while hour_cursor <= hour_end:
            for item in self._list_hour(cfg, hour_cursor):
                if item.valid_time >= cutoff:
                    files[item.filename] = item
            hour_cursor += timedelta(hours=1)
        out = sorted(files.values(), key=lambda f: f.valid_time)
        if not out:
            raise RuntimeError("No GLM files available for selected product")
        return out

    def _list_hour(self, cfg: GlmProductConfig, hour: datetime) -> List[GlmFile]:
        cache_key = f"{cfg.id}:{hour.strftime('%Y%j%H')}"
        now = datetime.now(timezone.utc)
        with self._lock:
            cached = self._listing_cache.get(cache_key)
            if cached and (now - cached[0]).total_seconds() <= self.listing_ttl_seconds:
                return list(cached[1])

        prefix = f"{cfg.prefix_root}/{hour.strftime('%Y/%j/%H/')}"
        files = self._list_bucket_prefix(cfg, prefix)
        with self._lock:
            self._listing_cache[cache_key] = (now, list(files))
        return files

    def _list_bucket_prefix(self, cfg: GlmProductConfig, prefix: str) -> List[GlmFile]:
        base_url = f"https://{cfg.bucket}.s3.amazonaws.com"
        continuation_token: Optional[str] = None
        out: List[GlmFile] = []
        while True:
            params = {"list-type": "2", "prefix": prefix}
            if continuation_token:
                params["continuation-token"] = continuation_token
            resp = requests.get(base_url, params=params, timeout=30)
            resp.raise_for_status()
            root = ET.fromstring(resp.text)
            ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
            keys = [elem.text for elem in root.findall("s3:Contents/s3:Key", ns) if elem.text]
            for key in keys:
                filename = key.rsplit("/", 1)[-1]
                if f"_{'G19' if cfg.satellite == 'east' else 'G18'}_" not in filename:
                    continue
                start_time, end_time = _extract_glm_times(filename)
                if start_time is None or end_time is None:
                    continue
                out.append(
                    GlmFile(
                        valid_time=end_time,
                        start_time=start_time,
                        end_time=end_time,
                        filename=filename,
                        url=f"{base_url}/{key}",
                        source="listing",
                    )
                )
            token = root.findtext("s3:NextContinuationToken", default=None, namespaces=ns)
            if not token:
                break
            continuation_token = token
        out.sort(key=lambda f: f.valid_time)
        return out

    def _select_match(self, files: List[GlmFile], requested_time: Optional[datetime], now: Optional[datetime] = None) -> MatchSelection:
        latest = files[-1]
        if requested_time is None:
            return MatchSelection(
                matched=latest,
                latest=latest,
                requested_time=None,
                match_status="latest",
                match_delta_minutes=0.0,
                match_tolerance_minutes=None,
            )
        tolerance_minutes = _bucket_match_tolerance_minutes(requested_time, now=now)
        matched = min(files, key=lambda f: abs((f.valid_time - requested_time).total_seconds()))
        delta_minutes = round((matched.valid_time - requested_time).total_seconds() / 60.0, 1)
        if abs(delta_minutes) > tolerance_minutes:
            raise FileNotFoundError(f"No GLM data available within {tolerance_minutes} minutes of {_iso_z(requested_time)}")
        return MatchSelection(
            matched=matched,
            latest=latest,
            requested_time=requested_time,
            match_status=_match_status_from_delta_minutes(delta_minutes),
            match_delta_minutes=delta_minutes,
            match_tolerance_minutes=tolerance_minutes,
        )

    def _ensure_dependencies(self) -> None:
        missing = []
        if np is None or Image is None:
            missing.append("numpy/Pillow")
        if netCDF4 is None:
            missing.append("netCDF4")
        if missing:
            raise RuntimeError(f"GLM rendering requires: {', '.join(missing)}")

    def _local_nc_path(self, cfg: GlmProductConfig, item: GlmFile) -> Path:
        return self.cache_root / cfg.id / "raw" / item.valid_time.strftime("%Y%m%d") / item.filename

    def _tile_cache_path(self, cfg: GlmProductConfig, item: GlmFile, z: int, x: int, y: int, tile_size: int, max_zoom: int) -> Path:
        return self.cache_root / cfg.id / "tiles" / item.valid_time.strftime("%Y%m%d%H%M%S") / f"z{z}_x{x}_y{y}_s{tile_size}_mz{max_zoom}.png"

    def _preview_cache_path(self, cfg: GlmProductConfig, item: GlmFile) -> Path:
        return self.cache_root / cfg.id / "preview" / f"{item.valid_time.strftime('%Y%m%d%H%M%S')}.png"

    def _download_file(self, cfg: GlmProductConfig, item: GlmFile) -> Path:
        target = self._local_nc_path(cfg, item)
        if target.exists() and target.stat().st_size > 0:
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".tmp")
        resp = requests.get(item.url, timeout=90)
        resp.raise_for_status()
        tmp.write_bytes(resp.content)
        tmp.replace(target)
        return target

    def _frame_lock(self, key: str) -> threading.Lock:
        with self._lock:
            lock = self._frame_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._frame_locks[key] = lock
            return lock

    def _get_frame_data(self, cfg: GlmProductConfig, item: GlmFile) -> GlmFrameData:
        self._ensure_dependencies()
        cache_key = f"{cfg.id}:{item.valid_time.strftime('%Y%m%d%H%M%S')}"
        with self._lock:
            cached = self._frame_cache.get(cache_key)
            if cached is not None:
                self._frame_cache.move_to_end(cache_key)
                return cached
        lock = self._frame_lock(cache_key)
        with lock:
            with self._lock:
                cached = self._frame_cache.get(cache_key)
                if cached is not None:
                    self._frame_cache.move_to_end(cache_key)
                    return cached

            files = self._files_for_accumulation(cfg, item)
            frame = self._build_frame(cfg, item, files)
            with self._lock:
                self._frame_cache[cache_key] = frame
                while len(self._frame_cache) > 6:
                    self._frame_cache.popitem(last=False)
            return frame

    def _files_for_accumulation(self, cfg: GlmProductConfig, item: GlmFile) -> List[GlmFile]:
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        window_start = item.valid_time - timedelta(minutes=GLM_ACCUMULATION_MINUTES)
        selected = [f for f in files if f.valid_time > window_start and f.valid_time <= item.valid_time]
        if not selected:
            raise FileNotFoundError(f"No GLM files available for {_iso_z(item.valid_time)} accumulation window")
        return selected

    def _build_frame(self, cfg: GlmProductConfig, item: GlmFile, files: List[GlmFile]) -> GlmFrameData:
        assert np is not None
        lat_axis = np.asarray(self._lat_axis, dtype=np.float32)
        lon_axis = np.asarray(self._lon_axis, dtype=np.float32)
        values = np.zeros((lat_axis.shape[0], lon_axis.shape[0]), dtype=np.float32)
        lat2d = lat_axis[:, None]
        for glm_file in files:
            nc_path = self._download_file(cfg, glm_file)
            self._accumulate_file(values, lat_axis, lon_axis, lat2d, nc_path)
        min_lon, min_lat, max_lon, max_lat = GLM_BOUNDS
        return GlmFrameData(
            values=values,
            lat_axis=lat_axis,
            lon_axis=lon_axis,
            width=int(values.shape[1]),
            height=int(values.shape[0]),
            bounds=GLM_BOUNDS,
            corners=((min_lon, max_lat), (max_lon, max_lat), (max_lon, min_lat), (min_lon, min_lat)),
            files_used=[f.filename for f in files],
        )

    def _accumulate_file(
        self,
        values: "np.ndarray",
        lat_axis: "np.ndarray",
        lon_axis: "np.ndarray",
        lat2d: "np.ndarray",
        nc_path: Path,
    ) -> None:
        assert np is not None
        ds = netCDF4.Dataset(str(nc_path), mode="r")
        try:
            flash_lat = np.asarray(ds.variables["flash_lat"][:], dtype=np.float32)
            flash_lon = np.asarray(ds.variables["flash_lon"][:], dtype=np.float32)
            flash_area = np.asarray(ds.variables["flash_area"][:], dtype=np.float32)
            quality = np.asarray(ds.variables["flash_quality_flag"][:], dtype=np.int16)
        finally:
            ds.close()

        if flash_lat.size == 0:
            return

        for lat, lon, area_m2, qflag in zip(flash_lat, flash_lon, flash_area, quality):
            if not math.isfinite(float(lat)) or not math.isfinite(float(lon)) or not math.isfinite(float(area_m2)):
                continue
            if int(qflag) != 0:
                continue
            if lat < GLM_BOUNDS[1] or lat > GLM_BOUNDS[3] or lon < GLM_BOUNDS[0] or lon > GLM_BOUNDS[2]:
                continue

            radius_km = max(4.0, min(75.0, math.sqrt(max(float(area_m2), 1.0) / math.pi) / 1000.0))
            lat_radius_deg = radius_km / 111.32
            cos_lat = max(0.2, math.cos(math.radians(float(lat))))
            lon_radius_deg = radius_km / (111.32 * cos_lat)

            row_min = max(0, int(math.floor((GLM_BOUNDS[3] - (lat + lat_radius_deg)) / GLM_DEGREES_PER_CELL)))
            row_max = min(values.shape[0] - 1, int(math.ceil((GLM_BOUNDS[3] - (lat - lat_radius_deg)) / GLM_DEGREES_PER_CELL)))
            col_min = max(0, int(math.floor(((lon - lon_radius_deg) - GLM_BOUNDS[0]) / GLM_DEGREES_PER_CELL)))
            col_max = min(values.shape[1] - 1, int(math.ceil(((lon + lon_radius_deg) - GLM_BOUNDS[0]) / GLM_DEGREES_PER_CELL)))
            if row_min > row_max or col_min > col_max:
                continue

            sub_lats = lat2d[row_min : row_max + 1]
            sub_lons = lon_axis[col_min : col_max + 1][None, :]
            dy_km = (sub_lats - float(lat)) * 111.32
            dx_km = (sub_lons - float(lon)) * 111.32 * cos_lat
            mask = (dx_km * dx_km + dy_km * dy_km) <= radius_km * radius_km
            if np.any(mask):
                values[row_min : row_max + 1, col_min : col_max + 1][mask] += 1.0

    def _ensure_preview_png(self, cfg: GlmProductConfig, item: GlmFile) -> Path:
        png_path = self._preview_cache_path(cfg, item)
        if png_path.exists() and png_path.stat().st_size > 0:
            return png_path
        frame = self._get_frame_data(cfg, item)
        png_bytes = self._render_tile_from_frame(frame, 0, 0, 0, 1024)
        png_path.parent.mkdir(parents=True, exist_ok=True)
        png_path.write_bytes(png_bytes)
        return png_path

    @staticmethod
    def _tile_lon_lat(z: int, x: int, y: int, tile_size: int) -> Tuple["np.ndarray", "np.ndarray"]:
        assert np is not None
        n = 1 << z
        xs = (np.arange(tile_size, dtype=np.float64) + 0.5) / tile_size
        ys = (np.arange(tile_size, dtype=np.float64) + 0.5) / tile_size
        lon = ((x + xs) / n) * 360.0 - 180.0
        yy = (y + ys) / n
        lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * yy))))
        return np.meshgrid(lon, lat)

    @staticmethod
    def _sample_grid(values: "np.ndarray", lat_axis: "np.ndarray", lon_axis: "np.ndarray", lat: "np.ndarray", lon: "np.ndarray") -> "np.ndarray":
        assert np is not None
        row = np.rint((lat_axis[0] - lat) / GLM_DEGREES_PER_CELL).astype(np.int32)
        col = np.rint((lon - lon_axis[0]) / GLM_DEGREES_PER_CELL).astype(np.int32)
        valid = (
            np.isfinite(lat)
            & np.isfinite(lon)
            & (row >= 0)
            & (row < values.shape[0])
            & (col >= 0)
            & (col < values.shape[1])
        )
        out = np.full(lat.shape, np.nan, dtype=np.float32)
        if np.any(valid):
            out[valid] = values[row[valid], col[valid]]
        return out

    def _render_tile_from_frame(self, frame: GlmFrameData, z: int, x: int, y: int, tile_size: int) -> bytes:
        lon2d, lat2d = self._tile_lon_lat(z, x, y, tile_size)
        sample = self._sample_grid(frame.values, frame.lat_axis, frame.lon_axis, lat2d, lon2d)
        rgba = self._colorize(sample)
        img = Image.fromarray(rgba, mode="RGBA")
        buf = BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _sample_frame_value(self, frame: GlmFrameData, lat: float, lon: float) -> Optional[float]:
        assert np is not None
        sample = self._sample_grid(
            frame.values,
            frame.lat_axis,
            frame.lon_axis,
            np.asarray([[lat]], dtype=np.float64),
            np.asarray([[lon]], dtype=np.float64),
        )
        value = float(sample[0, 0])
        if not math.isfinite(value):
            return None
        return value

    def _colorize(self, values: "np.ndarray") -> "np.ndarray":
        assert np is not None
        rgba = np.zeros(values.shape + (4,), dtype=np.uint8)
        valid = np.isfinite(values) & (values >= GLM_MIN_DISPLAY_VALUE)
        if not np.any(valid):
            return rgba

        for low, high, color in GLM_LEGEND_BINS:
            mask = valid & (values >= low) & (values < high)
            if not np.any(mask):
                continue
            rgba[mask, 0] = color[0]
            rgba[mask, 1] = color[1]
            rgba[mask, 2] = color[2]
            rgba[mask, 3] = 210
        return rgba

    def _label_for_product(self, cfg: GlmProductConfig) -> str:
        return f"{cfg.satellite_label} {cfg.sector_label} GLM 5-min Flash Extent Density"

    def _cleanup_if_needed(self, now: datetime) -> None:
        with self._lock:
            if self._last_cleanup is not None and (now - self._last_cleanup) < self.cleanup_interval:
                return
            self._last_cleanup = now

        cutoff = now - timedelta(minutes=self.raw_retention_minutes)
        for p in self.cache_root.rglob("*"):
            if not p.is_file():
                continue
            try:
                if datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc) < cutoff:
                    p.unlink(missing_ok=True)
            except OSError:
                continue

        files: List[Tuple[Path, float, float]] = []
        total_bytes = 0
        for p in self.cache_root.rglob("*"):
            if not p.is_file():
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            total_bytes += st.st_size
            files.append((p, st.st_mtime, st.st_size))
        if total_bytes <= self.max_cache_bytes:
            return
        files.sort(key=lambda item: item[1])
        for p, _, size in files:
            try:
                p.unlink(missing_ok=True)
            except OSError:
                continue
            total_bytes -= size
            if total_bytes <= self.max_cache_bytes:
                break
