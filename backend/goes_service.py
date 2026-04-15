from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import math
import os
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

try:
    from pyproj import CRS, Transformer
except Exception:  # pragma: no cover
    CRS = None  # type: ignore
    Transformer = None  # type: ignore


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


def _extract_scan_start(filename: str) -> Optional[datetime]:
    match = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})", filename)
    if not match:
        return None
    year, doy, hour, minute, second = map(int, match.groups())
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1, hours=hour, minutes=minute, seconds=second)


@dataclass(frozen=True)
class GoesProductConfig:
    id: str
    satellite: str
    sector: str
    band: str
    bucket: str
    prefix_root: str
    satellite_label: str
    sector_label: str
    band_label: str
    unit: str
    sector_code: str


@dataclass(frozen=True)
class GoesFile:
    valid_time: datetime
    filename: str
    url: str
    source: str = "listing"


@dataclass(frozen=True)
class MatchSelection:
    matched: GoesFile
    latest: GoesFile
    requested_time: Optional[datetime]
    match_status: str
    match_delta_minutes: float
    match_tolerance_minutes: Optional[int]


@dataclass
class GoesFrameData:
    values: "np.ndarray"
    x_rad: "np.ndarray"
    y_rad: "np.ndarray"
    width: int
    height: int
    proj_h: float
    to_geos: "Transformer"
    to_ll: "Transformer"
    bounds: Tuple[float, float, float, float]
    corners: Tuple[Tuple[float, float], Tuple[float, float], Tuple[float, float], Tuple[float, float]]


GOES_RENDER_STYLES = {"grayscale", "enhanced"}


GOES_TILE_SIZE = 256
GOES_TILE_MAX_ZOOM = 9

GOES_SECTOR_DEFS = [
    ("east-conus", "east", "conus", "ABI-L2-CMIPC", "GOES-E", "CONUS", "C"),
    ("west-conus", "west", "conus", "ABI-L2-CMIPC", "GOES-W", "CONUS", "C"),
]

GOES_BANDS = {
    "02": {"label": "Band 2 (Red Visible)", "unit": "%"},
    "09": {"label": "Band 9 (Mid-Level Water Vapor)", "unit": "°C"},
    "13": {"label": "Band 13 (Clean IR Longwave)", "unit": "°C"},
}

GOES_PRODUCTS: Dict[str, GoesProductConfig] = {}
for sector_id, satellite, sector, prefix_root, satellite_label, sector_label, sector_code in GOES_SECTOR_DEFS:
    bucket = "noaa-goes19" if satellite == "east" else "noaa-goes18"
    sat_code = "G19" if satellite == "east" else "G18"
    for band, band_info in GOES_BANDS.items():
        product_id = f"{sector_id}-{band}"
        GOES_PRODUCTS[product_id] = GoesProductConfig(
            id=product_id,
            satellite=satellite,
            sector=sector,
            band=band,
            bucket=bucket,
            prefix_root=prefix_root,
            satellite_label=satellite_label,
            sector_label=sector_label,
            band_label=band_info["label"],
            unit=band_info["unit"],
            sector_code=sector_code,
        )

GOES_FALLBACK_BOUNDS: Dict[str, Tuple[float, float, float, float]] = {
    "conus": (-130.0, 12.0, -55.0, 55.0),
}

GOES_IR_ENHANCEMENT_POINTS_C: Tuple[Tuple[float, Tuple[int, int, int]], ...] = (
    (-90.0, (18, 18, 18)),
    (-80.0, (64, 0, 96)),
    (-70.0, (220, 0, 0)),
    (-60.0, (255, 245, 0)),
    (-50.0, (90, 230, 0)),
    (-40.0, (0, 70, 255)),
    (-30.0, (0, 230, 255)),
    (-20.0, (185, 185, 185)),
    (-10.0, (140, 140, 140)),
    (0.0, (100, 100, 100)),
    (10.0, (150, 150, 150)),
    (20.0, (200, 200, 200)),
    (35.0, (245, 245, 245)),
)


class GoesService:
    def __init__(
        self,
        cache_root: Path,
        history_minutes: int = 360,
        stale_warn_minutes: int = 45,
        listing_ttl_seconds: int = 120,
        raw_retention_minutes: int = 12 * 60,
        max_cache_gb: float = 12.0,
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
        self._listing_cache: Dict[str, Tuple[datetime, List[GoesFile]]] = {}
        self._exact_file_cache: Dict[str, Tuple[datetime, GoesFile]] = {}
        self._frame_cache: "OrderedDict[str, GoesFrameData]" = OrderedDict()
        self._frame_locks: Dict[str, threading.Lock] = {}
        self._lock = threading.Lock()
        self._last_cleanup: Optional[datetime] = None

    def get_meta(self, product: str, requested_time: Optional[datetime], render_style: str = "enhanced") -> dict:
        cfg = self._product(product)
        render_style = self._render_style(cfg, render_style)
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        selection = self._select_match(files, requested_time, now=now)
        matched = selection.matched
        latest = selection.latest
        self._remember_exact_file(cfg, matched)
        self._remember_exact_file(cfg, latest)
        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        min_lon, min_lat, max_lon, max_lat = GOES_FALLBACK_BOUNDS.get(cfg.sector, (-180.0, -80.0, 180.0, 80.0))
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
            "band": cfg.band,
            "label": self._label_for_product(cfg),
            "unit": cfg.unit,
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
            "available_times": [_iso_z(f.valid_time) for f in files],
            "render_style": render_style,
            "image_url": f"/api/goes/image?product={cfg.id}&time={_iso_z(matched.valid_time)}&style={render_style}",
            "tile_url_template": f"/api/goes/tile/{{z}}/{{x}}/{{y}}.png?product={cfg.id}&time={_iso_z(matched.valid_time)}&style={render_style}",
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
        value = self._convert_value(cfg, raw_value)
        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        self._cleanup_if_needed(now)
        return {
            "product": cfg.id,
            "satellite": cfg.satellite,
            "sector": cfg.sector,
            "band": cfg.band,
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
        render_style: str = "enhanced",
        tile_size: int = GOES_TILE_SIZE,
        max_zoom: int = GOES_TILE_MAX_ZOOM,
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
        render_style = self._render_style(cfg, render_style)
        now = datetime.now(timezone.utc)
        selection = self._select_or_resolve(cfg, requested_time, now)
        matched = selection.matched
        latest = selection.latest
        tile_path = self._tile_cache_path(cfg, matched, render_style, z, x, y, tile_size, max_zoom)
        if tile_path.exists() and tile_path.stat().st_size > 0:
            png_bytes = tile_path.read_bytes()
        else:
            frame = self._get_frame_data(cfg, matched)
            png_bytes = self._render_tile_from_frame(cfg, frame, render_style, z, x, y, tile_size)
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

    def get_rendered_image(self, product: str, requested_time: Optional[datetime], render_style: str = "enhanced") -> Tuple[Path, dict]:
        cfg = self._product(product)
        render_style = self._render_style(cfg, render_style)
        now = datetime.now(timezone.utc)
        selection = self._select_or_resolve(cfg, requested_time, now)
        matched = selection.matched
        latest = selection.latest
        png_path = self._ensure_preview_png(cfg, matched, render_style)
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

    def _product(self, product: str) -> GoesProductConfig:
        key = (product or "").strip().lower()
        cfg = GOES_PRODUCTS.get(key)
        if cfg is None:
            raise ValueError(f"Unsupported GOES product '{product}'")
        return cfg

    def _render_style(self, cfg: GoesProductConfig, render_style: str) -> str:
        style = (render_style or "enhanced").strip().lower()
        if cfg.band == "02":
            return "grayscale"
        if style not in GOES_RENDER_STYLES:
            raise ValueError(f"Unsupported GOES render style '{render_style}'")
        return style

    def _exact_cache_key(self, cfg: GoesProductConfig, valid_time: datetime) -> str:
        return f"{cfg.id}:{_iso_z(valid_time)}"

    def _remember_exact_file(self, cfg: GoesProductConfig, item: GoesFile) -> None:
        with self._lock:
            self._exact_file_cache[self._exact_cache_key(cfg, item.valid_time)] = (datetime.now(timezone.utc), item)
            if len(self._exact_file_cache) > 256:
                oldest_key = min(self._exact_file_cache.items(), key=lambda kv: kv[1][0])[0]
                self._exact_file_cache.pop(oldest_key, None)

    def _cached_exact_file(self, cfg: GoesProductConfig, requested_time: Optional[datetime]) -> Optional[GoesFile]:
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

    def _select_or_resolve(self, cfg: GoesProductConfig, requested_time: Optional[datetime], now: datetime) -> MatchSelection:
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

    def _recent_files(self, cfg: GoesProductConfig, now: datetime) -> List[GoesFile]:
        cutoff = now - timedelta(minutes=self.history_minutes)
        files: Dict[str, GoesFile] = {}
        hour_cursor = cutoff.replace(minute=0, second=0, microsecond=0)
        hour_end = now.replace(minute=0, second=0, microsecond=0)
        while hour_cursor <= hour_end:
            for item in self._list_hour(cfg, hour_cursor):
                if item.valid_time >= cutoff:
                    files[item.filename] = item
            hour_cursor += timedelta(hours=1)
        out = sorted(files.values(), key=lambda f: f.valid_time)
        if not out:
            raise RuntimeError("No GOES files available for selected product")
        return out

    def _list_hour(self, cfg: GoesProductConfig, hour: datetime) -> List[GoesFile]:
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

    def _list_bucket_prefix(self, cfg: GoesProductConfig, prefix: str) -> List[GoesFile]:
        base_url = f"https://{cfg.bucket}.s3.amazonaws.com"
        continuation_token: Optional[str] = None
        out: List[GoesFile] = []
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
                if not re.search(rf"-M\dC{cfg.band}_", filename):
                    continue
                if cfg.sector_code == "M1" and "CMIPM1-" not in filename:
                    continue
                if cfg.sector_code == "M2" and "CMIPM2-" not in filename:
                    continue
                valid_time = _extract_scan_start(filename)
                if valid_time is None:
                    continue
                out.append(GoesFile(valid_time=valid_time, filename=filename, url=f"{base_url}/{key}", source="listing"))
            token = root.findtext("s3:NextContinuationToken", default=None, namespaces=ns)
            if not token:
                break
            continuation_token = token
        out.sort(key=lambda f: f.valid_time)
        return out

    def _select_match(self, files: List[GoesFile], requested_time: Optional[datetime], now: Optional[datetime] = None) -> MatchSelection:
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
            raise FileNotFoundError(f"No GOES imagery available within {tolerance_minutes} minutes of {_iso_z(requested_time)}")
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
        if CRS is None or Transformer is None:
            missing.append("pyproj")
        if missing:
            raise RuntimeError(f"GOES rendering requires: {', '.join(missing)}")

    def _local_nc_path(self, cfg: GoesProductConfig, item: GoesFile) -> Path:
        return self.cache_root / cfg.id / "raw" / item.valid_time.strftime("%Y%m%d") / item.filename

    def _tile_cache_path(self, cfg: GoesProductConfig, item: GoesFile, render_style: str, z: int, x: int, y: int, tile_size: int, max_zoom: int) -> Path:
        return self.cache_root / cfg.id / "tiles" / render_style / item.valid_time.strftime("%Y%m%d%H%M%S") / f"z{z}_x{x}_y{y}_s{tile_size}_mz{max_zoom}.png"

    def _preview_cache_path(self, cfg: GoesProductConfig, item: GoesFile, render_style: str) -> Path:
        return self.cache_root / cfg.id / "preview" / render_style / f"{item.valid_time.strftime('%Y%m%d%H%M%S')}.png"

    def _download_file(self, cfg: GoesProductConfig, item: GoesFile) -> Path:
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

    @staticmethod
    def _read_stride(cfg: GoesProductConfig) -> int:
        if cfg.sector == "full":
            return 8 if cfg.band == "02" else 4
        if cfg.sector == "conus":
            return 4 if cfg.band == "02" else 2
        return 2 if cfg.band == "02" else 1

    def _get_frame_data(self, cfg: GoesProductConfig, item: GoesFile) -> GoesFrameData:
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

            nc_path = self._download_file(cfg, item)
            frame = self._load_frame_from_nc(cfg, nc_path)
            with self._lock:
                self._frame_cache[cache_key] = frame
                while len(self._frame_cache) > 3:
                    self._frame_cache.popitem(last=False)
            return frame

    def _load_frame_from_nc(self, cfg: GoesProductConfig, nc_path: Path) -> GoesFrameData:
        self._ensure_dependencies()
        ds = netCDF4.Dataset(str(nc_path), mode="r")
        try:
            stride = self._read_stride(cfg)
            cmi = ds.variables["CMI"][::stride, ::stride]
            values = np.ma.filled(cmi, np.nan).astype(np.float16)
            x_rad = np.asarray(ds.variables["x"][::stride], dtype=np.float32)
            y_rad = np.asarray(ds.variables["y"][::stride], dtype=np.float32)
            proj = ds.variables["goes_imager_projection"]
            semi_major = float(getattr(proj, "semi_major_axis"))
            semi_minor = float(getattr(proj, "semi_minor_axis"))
            lon0 = float(getattr(proj, "longitude_of_projection_origin"))
            sweep = str(getattr(proj, "sweep_angle_axis"))
            h = float(getattr(proj, "perspective_point_height"))
        finally:
            ds.close()

        crs = CRS.from_proj4(
            f"+proj=geos +h={h} +lon_0={lon0} +sweep={sweep} +a={semi_major} +b={semi_minor} +no_defs"
        )
        to_geos = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        to_ll = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

        corners_xy = [
            (float(x_rad[0] * h), float(y_rad[0] * h)),
            (float(x_rad[-1] * h), float(y_rad[0] * h)),
            (float(x_rad[-1] * h), float(y_rad[-1] * h)),
            (float(x_rad[0] * h), float(y_rad[-1] * h)),
        ]
        corners_ll: List[Tuple[float, float]] = []
        for xx, yy in corners_xy:
            lon, lat = to_ll.transform(xx, yy)
            corners_ll.append((float(lon), float(lat)))
        min_lon = min(pt[0] for pt in corners_ll)
        min_lat = min(pt[1] for pt in corners_ll)
        max_lon = max(pt[0] for pt in corners_ll)
        max_lat = max(pt[1] for pt in corners_ll)

        return GoesFrameData(
            values=values,
            x_rad=x_rad,
            y_rad=y_rad,
            width=int(values.shape[1]),
            height=int(values.shape[0]),
            proj_h=h,
            to_geos=to_geos,
            to_ll=to_ll,
            bounds=(min_lon, min_lat, max_lon, max_lat),
            corners=(corners_ll[0], corners_ll[1], corners_ll[2], corners_ll[3]),
        )

    def _render_tile_from_frame(self, cfg: GoesProductConfig, frame: GoesFrameData, render_style: str, z: int, x: int, y: int, tile_size: int) -> bytes:
        lon2d, lat2d = self._tile_lon_lat(z, x, y, tile_size)
        gx_m, gy_m = frame.to_geos.transform(lon2d, lat2d)
        gx = np.asarray(gx_m, dtype=np.float64) / frame.proj_h
        gy = np.asarray(gy_m, dtype=np.float64) / frame.proj_h
        sample = self._sample_grid(frame.values, frame.x_rad, frame.y_rad, gx, gy)
        rgba = self._colorize(cfg, sample, render_style)
        img = Image.fromarray(rgba, mode="RGBA")
        buf = BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _ensure_preview_png(self, cfg: GoesProductConfig, item: GoesFile, render_style: str) -> Path:
        png_path = self._preview_cache_path(cfg, item, render_style)
        if png_path.exists() and png_path.stat().st_size > 0:
            return png_path
        frame = self._get_frame_data(cfg, item)
        x = 0
        y = 0
        z = 0
        png_bytes = self._render_tile_from_frame(cfg, frame, render_style, z, x, y, 1024)
        png_path.parent.mkdir(parents=True, exist_ok=True)
        png_path.write_bytes(png_bytes)
        return png_path

    @staticmethod
    def _tile_lon_lat(z: int, x: int, y: int, tile_size: int) -> Tuple["np.ndarray", "np.ndarray"]:
        n = 1 << z
        xs = (np.arange(tile_size, dtype=np.float64) + 0.5) / tile_size
        ys = (np.arange(tile_size, dtype=np.float64) + 0.5) / tile_size
        lon = ((x + xs) / n) * 360.0 - 180.0
        yy = (y + ys) / n
        lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * yy))))
        return np.meshgrid(lon, lat)

    @staticmethod
    def _sample_grid(values: "np.ndarray", x_axis: "np.ndarray", y_axis: "np.ndarray", gx: "np.ndarray", gy: "np.ndarray") -> "np.ndarray":
        x0 = float(x_axis[0])
        x1 = float(x_axis[-1])
        y0 = float(y_axis[0])
        y1 = float(y_axis[-1])
        dx = (x1 - x0) / max(1, len(x_axis) - 1)
        dy = (y1 - y0) / max(1, len(y_axis) - 1)
        ix = np.rint((gx - x0) / dx).astype(np.int32)
        iy = np.rint((gy - y0) / dy).astype(np.int32)
        valid = np.isfinite(gx) & np.isfinite(gy) & (ix >= 0) & (ix < values.shape[1]) & (iy >= 0) & (iy < values.shape[0])
        out = np.full(gx.shape, np.nan, dtype=np.float32)
        if np.any(valid):
            out[valid] = values[iy[valid], ix[valid]]
        return out

    def _sample_frame_value(self, frame: GoesFrameData, lat: float, lon: float) -> Optional[float]:
        gx_m, gy_m = frame.to_geos.transform(lon, lat)
        if not math.isfinite(gx_m) or not math.isfinite(gy_m):
            return None
        gx = gx_m / frame.proj_h
        gy = gy_m / frame.proj_h
        sample = self._sample_grid(
            frame.values,
            frame.x_rad,
            frame.y_rad,
            np.asarray([[gx]], dtype=np.float64),
            np.asarray([[gy]], dtype=np.float64),
        )
        value = float(sample[0, 0])
        if not math.isfinite(value):
            return None
        return value

    def _convert_value(self, cfg: GoesProductConfig, raw_value: Optional[float]) -> Optional[float]:
        if raw_value is None or not math.isfinite(raw_value):
            return None
        if cfg.band == "02":
            return round(raw_value * 100.0, 1)
        return round(raw_value - 273.15, 1)

    def _colorize(self, cfg: GoesProductConfig, values: "np.ndarray", render_style: str) -> "np.ndarray":
        rgba = np.zeros(values.shape + (4,), dtype=np.uint8)
        valid = np.isfinite(values)
        if not np.any(valid):
            return rgba

        if cfg.band == "02":
            scaled = np.clip(values, 0.0, 1.1) / 1.1
            brightness = np.clip(np.round(scaled * 255.0), 0, 255).astype(np.uint8)
            rgba[..., 0] = brightness
            rgba[..., 1] = brightness
            rgba[..., 2] = brightness
            rgba[..., 3] = np.where(valid & (values >= 0.01), 232, 0).astype(np.uint8)
            return rgba

        celsius = values - 273.15
        if render_style == "grayscale":
            rgba[..., :3] = self._colorize_ir_grayscale(cfg, celsius)
        elif cfg.band == "09":
            rgba[..., :3] = self._colorize_wv_enhancement(celsius)
        else:
            rgba[..., :3] = self._colorize_ir_enhancement(celsius)
        rgba[..., 3] = np.where(valid, 224, 0).astype(np.uint8)
        return rgba

    def _colorize_ir_grayscale(self, cfg: GoesProductConfig, celsius: "np.ndarray") -> "np.ndarray":
        vmax = 15.0 if cfg.band == "13" else -5.0
        scaled = 1.0 - np.clip((celsius - (-90.0)) / (vmax - (-90.0)), 0.0, 1.0)
        brightness = np.clip(np.round(scaled * 255.0), 0, 255).astype(np.uint8)
        return np.stack((brightness, brightness, brightness), axis=-1)

    def _colorize_ir_enhancement(self, celsius: "np.ndarray") -> "np.ndarray":
        points = GOES_IR_ENHANCEMENT_POINTS_C
        temps = np.asarray([pt[0] for pt in points], dtype=np.float32)
        colors = np.asarray([pt[1] for pt in points], dtype=np.float32)
        clipped = np.clip(celsius.astype(np.float32), temps[0], temps[-1])
        red = np.interp(clipped, temps, colors[:, 0])
        green = np.interp(clipped, temps, colors[:, 1])
        blue = np.interp(clipped, temps, colors[:, 2])
        rgb = np.stack((red, green, blue), axis=-1)
        return np.clip(np.round(rgb), 0, 255).astype(np.uint8)

    def _colorize_wv_enhancement(self, celsius: "np.ndarray") -> "np.ndarray":
        points = (
            (-90.0, (255, 245, 170)),
            (-80.0, (245, 235, 0)),
            (-70.0, (220, 45, 0)),
            (-65.0, (255, 185, 0)),
            (-60.0, (0, 220, 0)),
            (-55.0, (40, 40, 220)),
            (-50.0, (250, 250, 250)),
            (-45.0, (205, 205, 205)),
            (-40.0, (150, 150, 150)),
            (-35.0, (110, 110, 110)),
            (-30.0, (80, 80, 80)),
            (-25.0, (120, 55, 20)),
            (-20.0, (255, 145, 0)),
            (-15.0, (90, 0, 0)),
            (-10.0, (220, 0, 0)),
            (-5.0, (255, 120, 120)),
            (0.0, (240, 220, 0)),
        )
        temps = np.asarray([pt[0] for pt in points], dtype=np.float32)
        colors = np.asarray([pt[1] for pt in points], dtype=np.float32)
        clipped = np.clip(celsius.astype(np.float32), temps[0], temps[-1])
        red = np.interp(clipped, temps, colors[:, 0])
        green = np.interp(clipped, temps, colors[:, 1])
        blue = np.interp(clipped, temps, colors[:, 2])
        rgb = np.stack((red, green, blue), axis=-1)
        return np.clip(np.round(rgb), 0, 255).astype(np.uint8)

    def _label_for_product(self, cfg: GoesProductConfig) -> str:
        return f"{cfg.satellite_label} {cfg.sector_label} {cfg.band_label}"

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
