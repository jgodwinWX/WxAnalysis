from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from collections import OrderedDict
from io import BytesIO
import gzip
import re
import threading
from urllib.parse import urljoin

import requests

try:
    import numpy as np
    from PIL import Image
except Exception:  # pragma: no cover - import failure handled at runtime
    np = None  # type: ignore
    Image = None  # type: ignore

try:
    import pygrib
except Exception:  # pragma: no cover - import failure handled at runtime
    pygrib = None  # type: ignore


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class MrmsFile:
    valid_time: datetime
    filename: str
    url: str


@dataclass(frozen=True)
class MrmsProductConfig:
    id: str
    base_url: str
    bbox_conus: Tuple[float, float, float, float]  # min_lon, min_lat, max_lon, max_lat
    latest_filename: str


@dataclass(frozen=True)
class MrmsGridMeta:
    bounds: Tuple[float, float, float, float]  # min_lon, min_lat, max_lon, max_lat
    corners: Tuple[Tuple[float, float], Tuple[float, float], Tuple[float, float], Tuple[float, float]]  # nw, ne, se, sw
    row0_is_north: bool
    col0_is_west: bool


@dataclass
class MrmsFrameData:
    values: "np.ndarray"
    bounds: Tuple[float, float, float, float]
    nrows: int
    ncols: int


MRMS_PRODUCTS: Dict[str, MrmsProductConfig] = {
    "rala": MrmsProductConfig(
        id="rala",
        base_url="https://mrms.ncep.noaa.gov/2D/MergedReflectivityAtLowestAltitude/",
        bbox_conus=(-130.0, 20.0, -60.0, 55.0),
        latest_filename="MRMS_MergedReflectivityAtLowestAltitude.latest.grib2.gz",
    ),
    "composite": MrmsProductConfig(
        id="composite",
        base_url="https://mrms.ncep.noaa.gov/2D/MergedReflectivityComposite/",
        bbox_conus=(-130.0, 20.0, -60.0, 55.0),
        latest_filename="MRMS_MergedReflectivityComposite.latest.grib2.gz",
    ),
    "etop18": MrmsProductConfig(
        id="etop18",
        base_url="https://mrms.ncep.noaa.gov/2D/EchoTop_18/",
        bbox_conus=(-130.0, 20.0, -60.0, 55.0),
        latest_filename="MRMS_EchoTop_18.latest.grib2.gz",
    ),
    "rotation240": MrmsProductConfig(
        id="rotation240",
        base_url="https://mrms.ncep.noaa.gov/2D/RotationTrack240min/",
        bbox_conus=(-130.0, 20.0, -60.0, 55.0),
        latest_filename="MRMS_RotationTrack240min.latest.grib2.gz",
    )
}

# Reflectivity (RALA/Composite) GR2Analyst-style piecewise gradients with hard breaks.
# Each tuple: (low_dBZ, high_dBZ, color_at_low, color_at_high)
REFL_SEGMENTS = [
    (-35.0, 0.0, (255, 255, 255), (30, 30, 30)),
    (0.0, 20.0, (0, 75, 130), (130, 130, 250)),
    (20.0, 40.0, (110, 255, 110), (0, 60, 0)),
    (40.0, 50.0, (255, 255, 110), (255, 110, 0)),
    (50.0, 65.0, (255, 0, 0), (90, 0, 0)),
    (65.0, 75.0, (255, 200, 255), (90, 0, 90)),
    (75.0, 85.0, (255, 255, 255), (25, 25, 25)),
]
REFL_MIN_VALID = -35.0
REFL_MAX_VALID = 85.0
ETOP_KM_TO_KFT = 3.28084
ROT240_RAW_TO_SI = 1.0 / 1000.0
# EchoTop_18 color bins in kft (thousands of feet)
ETOP18_BIN_EDGES_KFT = [0, 2, 4, 6, 8, 10, 15, 20, 30, 40, 50, 60, 65, 70]
ETOP18_COLORS_RGB = [
    (190, 190, 190),  # 0..2
    (140, 180, 180),  # 2..4
    (130, 200, 200),  # 4..6
    (120, 220, 220),  # 6..8
    (90, 210, 210),   # 8..10
    (70, 190, 210),   # 10..15
    (70, 120, 230),   # 15..20
    (70, 20, 200),    # 20..30
    (30, 220, 30),    # 30..40
    (180, 180, 0),    # 40..50
    (220, 0, 0),      # 50..60
    (210, 180, 200),  # 60..65
    (255, 0, 255),    # 65..70
    (255, 255, 255),  # >=70
]
# RotationTrack240min color bins (1/s)
ROT240_BIN_EDGES = [0.000, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.010, 0.011, 0.012, 0.013, 0.014, 0.015, 0.020]
ROT240_COLORS_RGB = [
    (210, 220, 220),  # 0.000-0.003
    (180, 190, 190),  # 0.003-0.004
    (150, 150, 150),  # 0.004-0.005
    (100, 100, 95),   # 0.005-0.006
    (130, 130, 0),    # 0.006-0.007
    (170, 170, 0),    # 0.007-0.008
    (210, 210, 0),    # 0.008-0.009
    (255, 255, 0),    # 0.009-0.010
    (130, 0, 0),      # 0.010-0.011
    (150, 0, 0),      # 0.011-0.012
    (170, 0, 0),      # 0.012-0.013
    (190, 0, 0),      # 0.013-0.014
    (255, 0, 0),      # 0.014-0.015
    (255, 255, 255),  # 0.015-0.020
    (90, 230, 230),   # >=0.020
]
MRMS_RENDER_VERSION_BY_PRODUCT = {
    "rala": 7,
    "composite": 7,
    "etop18": 7,
    "rotation240": 2,
}
MRMS_TILE_MAX_ZOOM = 10
MRMS_TILE_SIZE = 256


class MrmsService:
    def __init__(
        self,
        cache_root: Path,
        history_minutes: int = 360,
        stale_warn_minutes: int = 30,
        listing_ttl_seconds: int = 120,
        raw_retention_minutes: int = 12 * 60,
        max_cache_gb: float = 8.0,
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
        self._listing_cache: Dict[str, Tuple[datetime, List[MrmsFile]]] = {}
        self._grid_meta_cache: Dict[str, MrmsGridMeta] = {}
        self._latest_file_cache: Dict[str, Tuple[datetime, MrmsFile]] = {}
        self._frame_cache: "OrderedDict[str, MrmsFrameData]" = OrderedDict()
        self._lock = threading.Lock()
        self._last_cleanup: Optional[datetime] = None

    def get_meta(self, product: str, requested_time: Optional[datetime]) -> dict:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        matched, latest = self._select_match(cfg, files, requested_time)
        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes

        try:
            meta = self._get_grid_meta(cfg, matched)
            min_lon, min_lat, max_lon, max_lat = meta.bounds
            corners = [
                [meta.corners[0][0], meta.corners[0][1]],
                [meta.corners[1][0], meta.corners[1][1]],
                [meta.corners[2][0], meta.corners[2][1]],
                [meta.corners[3][0], meta.corners[3][1]],
            ]
        except Exception:
            min_lon, min_lat, max_lon, max_lat = cfg.bbox_conus
            corners = [
                [min_lon, max_lat],
                [max_lon, max_lat],
                [max_lon, min_lat],
                [min_lon, min_lat],
            ]
        image_url = f"/api/mrms/image?product={cfg.id}&time={_iso_z(matched.valid_time)}"
        self._cleanup_if_needed(now)

        return {
            "product": cfg.id,
            "requested_time": _iso_z(requested_time) if requested_time else None,
            "matched_time": _iso_z(matched.valid_time),
            "latest_time": _iso_z(latest.valid_time),
            "age_minutes": round(age_min, 1),
            "stale_warning": stale,
            "available_times": [_iso_z(f.valid_time) for f in files],
            "image_url": image_url,
            "tile_url_template": f"/api/mrms/tile/{{z}}/{{x}}/{{y}}.png?product={cfg.id}&time={_iso_z(matched.valid_time)}",
            "bbox": {
                "min_lon": min_lon,
                "min_lat": min_lat,
                "max_lon": max_lon,
                "max_lat": max_lat,
            },
            "corners": corners,
        }

    @staticmethod
    def _style_for_product(product_id: str) -> Tuple[str, float]:
        if product_id == "etop18":
            return "discrete", 0.0
        if product_id == "rotation240":
            return "rotation240", 0.0
        return "reflectivity_piecewise", REFL_MIN_VALID

    def get_tile_png(
        self,
        product: str,
        requested_time: Optional[datetime],
        z: int,
        x: int,
        y: int,
        tile_size: int = MRMS_TILE_SIZE,
        max_zoom: int = MRMS_TILE_MAX_ZOOM,
    ) -> Tuple[bytes, dict]:
        if z < 0 or x < 0 or y < 0:
            raise ValueError("Invalid tile coordinates")
        if z > max_zoom:
            # Clamp to max zoom parent tile and upscale visually client-side.
            scale = 1 << (z - max_zoom)
            z = max_zoom
            x = x // scale
            y = y // scale

        n = 1 << z
        if x >= n or y >= n:
            raise ValueError("Tile x/y out of range for zoom")

        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        matched, latest = self._select_match(cfg, files, requested_time)
        frame = self._get_frame_data(cfg, matched)

        tile_path = self._tile_cache_path(cfg, matched, z, x, y, tile_size, max_zoom)
        if tile_path.exists() and tile_path.stat().st_size > 0:
            png_bytes = tile_path.read_bytes()
        else:
            png_bytes = self._render_tile_from_frame(frame, z, x, y, tile_size, cfg.id)
            tile_path.parent.mkdir(parents=True, exist_ok=True)
            tile_path.write_bytes(png_bytes)

        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        self._cleanup_if_needed(now)
        return png_bytes, {
            "matched_time": _iso_z(matched.valid_time),
            "latest_time": _iso_z(latest.valid_time),
            "age_minutes": round(age_min, 1),
            "stale_warning": stale,
        }

    def get_times(self, product: str) -> List[str]:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        return [_iso_z(f.valid_time) for f in files]

    def get_value(
        self,
        product: str,
        requested_time: Optional[datetime],
        lat: float,
        lon: float,
    ) -> dict:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        matched, latest = self._select_match(cfg, files, requested_time)
        frame = self._get_frame_data(cfg, matched)

        value = self._sample_frame_value(frame, lat, lon)
        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        self._cleanup_if_needed(now)
        return {
            "product": cfg.id,
            "requested_time": _iso_z(requested_time) if requested_time else None,
            "matched_time": _iso_z(matched.valid_time),
            "latest_time": _iso_z(latest.valid_time),
            "age_minutes": round(age_min, 1),
            "stale_warning": stale,
            "lat": float(lat),
            "lon": float(lon),
            "unit": "kft" if cfg.id == "etop18" else ("1/s" if cfg.id == "rotation240" else "dBZ"),
            "value": value,
            "value_dbz": value,
        }

    def get_rendered_image(self, product: str, requested_time: Optional[datetime]) -> Tuple[Path, dict]:
        cfg = self._product(product)
        now = datetime.now(timezone.utc)
        files = self._recent_files(cfg, now)
        matched, latest = self._select_match(cfg, files, requested_time)
        png_path = self._ensure_png(cfg, matched)
        age_min = (now - matched.valid_time).total_seconds() / 60.0
        stale = age_min > self.stale_warn_minutes
        self._cleanup_if_needed(now)
        return png_path, {
            "matched_time": _iso_z(matched.valid_time),
            "latest_time": _iso_z(latest.valid_time),
            "age_minutes": round(age_min, 1),
            "stale_warning": stale,
        }

    def cache_usage(self) -> dict:
        total = 0
        file_count = 0
        for p in self.cache_root.rglob("*"):
            if not p.is_file():
                continue
            file_count += 1
            total += p.stat().st_size
        return {"path": str(self.cache_root), "bytes": total, "files": file_count}

    def _product(self, product: str) -> MrmsProductConfig:
        key = (product or "").strip().lower()
        cfg = MRMS_PRODUCTS.get(key)
        if cfg is None:
            raise ValueError(f"Unsupported MRMS product '{product}'")
        return cfg

    def _recent_files(self, cfg: MrmsProductConfig, now: datetime) -> List[MrmsFile]:
        all_files = self._list_remote(cfg)
        cutoff = now - timedelta(minutes=self.history_minutes)
        recent = [f for f in all_files if f.valid_time >= cutoff]
        # Fallback: if no file in-window, still keep last few so UI can show something.
        if not recent and all_files:
            recent = all_files[-10:]
        if not recent:
            raise RuntimeError("No MRMS files available for selected product")
        return recent

    def _select_match(self, cfg: MrmsProductConfig, files: List[MrmsFile], requested_time: Optional[datetime]) -> Tuple[MrmsFile, MrmsFile]:
        latest = files[-1]
        if requested_time is None:
            latest_alias = self._latest_alias_file(cfg)
            if latest_alias is not None:
                return latest_alias, latest_alias
            return latest, latest

        prior = [f for f in files if f.valid_time <= requested_time]
        if prior:
            return prior[-1], latest
        # If target is earlier than oldest available in-window, return oldest available.
        return files[0], latest

    def _latest_alias_file(self, cfg: MrmsProductConfig) -> Optional[MrmsFile]:
        now = datetime.now(timezone.utc)
        with self._lock:
            cached = self._latest_file_cache.get(cfg.id)
            if cached is not None:
                fetched_at, f = cached
                if (now - fetched_at).total_seconds() <= self.listing_ttl_seconds:
                    return f

        alias_url = urljoin(cfg.base_url, cfg.latest_filename)
        tmp_file = MrmsFile(valid_time=now, filename=cfg.latest_filename, url=alias_url)
        try:
            raw_path = self._ensure_raw_download(cfg, tmp_file)
            grib_path = self._ensure_decompressed(raw_path)
            valid = self._extract_valid_time(grib_path) or now
            latest = MrmsFile(valid_time=valid, filename=cfg.latest_filename, url=alias_url)
            with self._lock:
                self._latest_file_cache[cfg.id] = (now, latest)
            return latest
        except Exception:
            return None

    def _list_remote(self, cfg: MrmsProductConfig) -> List[MrmsFile]:
        now = datetime.now(timezone.utc)
        with self._lock:
            cached = self._listing_cache.get(cfg.id)
            if cached is not None:
                fetched_at, files = cached
                if (now - fetched_at).total_seconds() <= self.listing_ttl_seconds:
                    return files

        resp = requests.get(cfg.base_url, timeout=25, headers={"User-Agent": "WxAnalysis/1.0"})
        resp.raise_for_status()
        html = resp.text

        hrefs = re.findall(r'href=["\']([^"\']+)["\']', html, flags=re.IGNORECASE)
        out: List[MrmsFile] = []
        seen = set()
        for href in hrefs:
            name = href.split("/")[-1].strip()
            if not name:
                continue
            if name in seen:
                continue
            if ".grib2" not in name.lower():
                continue
            t = self._parse_valid_time(name)
            if t is None:
                continue
            seen.add(name)
            out.append(MrmsFile(valid_time=t, filename=name, url=urljoin(cfg.base_url, href)))

        out.sort(key=lambda f: f.valid_time)
        with self._lock:
            self._listing_cache[cfg.id] = (now, out)
        return out

    @staticmethod
    def _parse_valid_time(name: str) -> Optional[datetime]:
        # Handles common MRMS filename patterns.
        patterns = [
            (r"(\d{8}-\d{6})", "%Y%m%d-%H%M%S"),
            (r"(\d{8}-\d{4})", "%Y%m%d-%H%M"),
            (r"(\d{14})", "%Y%m%d%H%M%S"),
            (r"(\d{12})", "%Y%m%d%H%M"),
        ]
        for regex, fmt in patterns:
            m = re.search(regex, name)
            if not m:
                continue
            try:
                dt = datetime.strptime(m.group(1), fmt).replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                continue
        return None

    def _ensure_png(self, cfg: MrmsProductConfig, f: MrmsFile) -> Path:
        if pygrib is None or np is None or Image is None:
            raise RuntimeError("MRMS rendering dependencies missing; install numpy, Pillow, and pygrib")

        png_dir = self.cache_root / cfg.id / "png"
        png_dir.mkdir(parents=True, exist_ok=True)
        stem = f.filename.replace(".gz", "")
        render_version = self._render_version_for_product(cfg.id)
        png_path = png_dir / f"{stem}_v{render_version}.png"
        if png_path.exists():
            return png_path

        raw_path = self._ensure_raw_download(cfg, f)
        grib_path = self._ensure_decompressed(raw_path)
        meta = self._get_grid_meta(cfg, f)
        self._render_product_to_png(grib_path, png_path, meta.row0_is_north, meta.col0_is_west, cfg.id)
        return png_path

    def _tile_cache_path(
        self,
        cfg: MrmsProductConfig,
        f: MrmsFile,
        z: int,
        x: int,
        y: int,
        tile_size: int,
        max_zoom: int,
    ) -> Path:
        stem = f.filename.replace(".gz", "")
        render_version = self._render_version_for_product(cfg.id)
        return (
            self.cache_root
            / cfg.id
            / "tiles"
            / f"{stem}_v{render_version}"
            / f"zmax{max_zoom}_s{tile_size}"
            / str(z)
            / str(x)
            / f"{y}.png"
        )

    def _ensure_raw_download(self, cfg: MrmsProductConfig, f: MrmsFile) -> Path:
        raw_dir = self.cache_root / cfg.id / "raw" / f.valid_time.strftime("%Y%m%d")
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = raw_dir / f.filename
        if raw_path.exists() and raw_path.stat().st_size > 0:
            return raw_path

        with requests.get(f.url, timeout=45, stream=True, headers={"User-Agent": "WxAnalysis/1.0"}) as r:
            r.raise_for_status()
            with raw_path.open("wb") as fp:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    fp.write(chunk)
        return raw_path

    @staticmethod
    def _ensure_decompressed(raw_path: Path) -> Path:
        if not raw_path.name.endswith(".gz"):
            return raw_path
        out_path = raw_path.with_suffix("")
        if out_path.exists() and out_path.stat().st_size > 0:
            return out_path
        with gzip.open(raw_path, "rb") as src, out_path.open("wb") as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)
        return out_path

    @staticmethod
    def _extract_valid_time(grib_path: Path) -> Optional[datetime]:
        if pygrib is None:
            return None
        try:
            with pygrib.open(str(grib_path)) as grbs:
                msg = grbs.message(1)
                dt = getattr(msg, "validDate", None)
            if dt is None:
                return None
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).replace(microsecond=0)
        except Exception:
            return None

    @staticmethod
    def _normalize_lon(lon: float) -> float:
        out = lon
        while out > 180.0:
            out -= 360.0
        while out < -180.0:
            out += 360.0
        return out

    def _get_grid_meta(self, cfg: MrmsProductConfig, f: MrmsFile) -> MrmsGridMeta:
        cache_key = f"{cfg.id}:{f.filename}"
        with self._lock:
            cached = self._grid_meta_cache.get(cache_key)
            if cached is not None:
                return cached

        raw_path = self._ensure_raw_download(cfg, f)
        grib_path = self._ensure_decompressed(raw_path)

        if pygrib is None:
            bounds = cfg.bbox_conus
            out = MrmsGridMeta(
                bounds=bounds,
                corners=((bounds[0], bounds[3]), (bounds[2], bounds[3]), (bounds[2], bounds[1]), (bounds[0], bounds[1])),
                row0_is_north=True,
                col0_is_west=True,
            )
            with self._lock:
                self._grid_meta_cache[cache_key] = out
            return out

        with pygrib.open(str(grib_path)) as grbs:
            msg = grbs.message(1)
            lats, lons = msg.latlons()
            lats = np.asarray(lats, dtype=np.float64) if np is not None else lats
            lons = np.asarray(lons, dtype=np.float64) if np is not None else lons

        if np is not None:
            lons = ((lons + 180.0) % 360.0) - 180.0
            valid = np.isfinite(lats) & np.isfinite(lons)
            if not np.any(valid):
                raise RuntimeError("No valid lat/lon coordinates in MRMS grid")
            min_lon = float(np.nanmin(lons[valid]))
            max_lon = float(np.nanmax(lons[valid]))
            min_lat = float(np.nanmin(lats[valid]))
            max_lat = float(np.nanmax(lats[valid]))
            row0_is_north = float(np.nanmean(lats[0, :])) >= float(np.nanmean(lats[-1, :]))
            col0_is_west = float(np.nanmean(lons[:, 0])) <= float(np.nanmean(lons[:, -1]))
        else:
            raise RuntimeError("numpy is required for MRMS geolocation")

        nw = (float(lons[0, 0]), float(lats[0, 0]))
        ne = (float(lons[0, -1]), float(lats[0, -1]))
        se = (float(lons[-1, -1]), float(lats[-1, -1]))
        sw = (float(lons[-1, 0]), float(lats[-1, 0]))

        # Normalize corners so returned order is always NW, NE, SE, SW.
        if not row0_is_north:
            nw, sw = sw, nw
            ne, se = se, ne
        if not col0_is_west:
            nw, ne = ne, nw
            sw, se = se, sw

        out = MrmsGridMeta(
            bounds=(min_lon, min_lat, max_lon, max_lat),
            corners=(nw, ne, se, sw),
            row0_is_north=row0_is_north,
            col0_is_west=col0_is_west,
        )
        with self._lock:
            self._grid_meta_cache[cache_key] = out
        return out

    def _get_frame_data(self, cfg: MrmsProductConfig, f: MrmsFile) -> MrmsFrameData:
        if np is None or pygrib is None:
            raise RuntimeError("MRMS rendering dependencies missing; install numpy and pygrib")
        cache_key = f"{cfg.id}:{f.filename}"
        with self._lock:
            cached = self._frame_cache.get(cache_key)
            if cached is not None:
                self._frame_cache.move_to_end(cache_key)
                return cached

        raw_path = self._ensure_raw_download(cfg, f)
        grib_path = self._ensure_decompressed(raw_path)
        meta = self._get_grid_meta(cfg, f)

        with pygrib.open(str(grib_path)) as grbs:
            msg = grbs.message(1)
            vals = msg.values

        arr = np.asarray(vals, dtype=np.float32)
        if np.ma.isMaskedArray(vals):
            mask = np.asarray(vals.mask, dtype=bool)
            arr[mask] = np.nan
        if cfg.id == "etop18":
            arr *= ETOP_KM_TO_KFT
        elif cfg.id == "rotation240":
            # RotationTrack240min is encoded in x10^-3 s^-1; convert to 1/s.
            arr *= ROT240_RAW_TO_SI
        _, min_valid = self._style_for_product(cfg.id)
        arr[arr < min_valid] = np.nan

        if not meta.row0_is_north:
            arr = np.flipud(arr)
        if not meta.col0_is_west:
            arr = np.fliplr(arr)

        frame = MrmsFrameData(
            values=arr,
            bounds=meta.bounds,
            nrows=arr.shape[0],
            ncols=arr.shape[1],
        )
        with self._lock:
            self._frame_cache[cache_key] = frame
            self._frame_cache.move_to_end(cache_key)
            while len(self._frame_cache) > 2:
                self._frame_cache.popitem(last=False)
        return frame

    @staticmethod
    def _tile_lonlat_bounds(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
        n = 1 << z
        lon_left = (x / n) * 360.0 - 180.0
        lon_right = ((x + 1) / n) * 360.0 - 180.0

        def tile_y_to_lat(tile_y: float) -> float:
            t = np.pi * (1.0 - 2.0 * tile_y / n)
            return float(np.degrees(np.arctan(np.sinh(t))))

        lat_top = tile_y_to_lat(y)
        lat_bottom = tile_y_to_lat(y + 1)
        return lon_left, lat_bottom, lon_right, lat_top

    @staticmethod
    def _render_tile_from_frame(
        frame: MrmsFrameData,
        z: int,
        x: int,
        y: int,
        tile_size: int,
        product_id: str,
    ) -> bytes:
        assert np is not None
        assert Image is not None
        style_mode, _ = MrmsService._style_for_product(product_id)

        lon_left, lat_bottom, lon_right, lat_top = MrmsService._tile_lonlat_bounds(z, x, y)
        min_lon, min_lat, max_lon, max_lat = frame.bounds

        if lon_right < min_lon or lon_left > max_lon or lat_top < min_lat or lat_bottom > max_lat:
            rgba = np.zeros((tile_size, tile_size, 4), dtype=np.uint8)
            buf = BytesIO()
            Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
            return buf.getvalue()

        xs = (np.arange(tile_size, dtype=np.float32) + 0.5) / tile_size
        ys = (np.arange(tile_size, dtype=np.float32) + 0.5) / tile_size
        lons = lon_left + xs * (lon_right - lon_left)

        # Y pixel centers in WebMercator, then invert to latitude.
        lat_top_clip = np.clip(lat_top, -85.0, 85.0)
        lat_bot_clip = np.clip(lat_bottom, -85.0, 85.0)
        my_top = np.log(np.tan(np.pi * 0.25 + np.deg2rad(lat_top_clip) * 0.5))
        my_bot = np.log(np.tan(np.pi * 0.25 + np.deg2rad(lat_bot_clip) * 0.5))
        my = my_top - ys * (my_top - my_bot)
        lats = np.degrees(2.0 * np.arctan(np.exp(my)) - np.pi * 0.5)

        row_f = (max_lat - lats) / max(max_lat - min_lat, 1e-6) * (frame.nrows - 1)
        col_f = (lons - min_lon) / max(max_lon - min_lon, 1e-6) * (frame.ncols - 1)
        row_idx = np.rint(row_f).astype(np.int32)
        col_idx = np.rint(col_f).astype(np.int32)

        valid_row = (row_idx >= 0) & (row_idx < frame.nrows)
        valid_col = (col_idx >= 0) & (col_idx < frame.ncols)

        rr = np.repeat(row_idx[:, None], tile_size, axis=1)
        cc = np.repeat(col_idx[None, :], tile_size, axis=0)
        sample_valid = valid_row[:, None] & valid_col[None, :]

        sample = np.full((tile_size, tile_size), np.nan, dtype=np.float32)
        if np.any(sample_valid):
            sample[sample_valid] = frame.values[rr[sample_valid], cc[sample_valid]]

        rgba = np.zeros((tile_size, tile_size, 4), dtype=np.uint8)
        s_valid = np.isfinite(sample)
        if style_mode == "reflectivity_piecewise":
            rr, gg, bb = MrmsService._interpolate_reflectivity_piecewise(sample)
            rgba[s_valid, 0] = rr[s_valid]
            rgba[s_valid, 1] = gg[s_valid]
            rgba[s_valid, 2] = bb[s_valid]
            rgba[s_valid, 3] = 255
        elif style_mode == "rotation240":
            idx = np.digitize(sample, ROT240_BIN_EDGES, right=False)
            idx = np.clip(idx, 0, len(ROT240_COLORS_RGB) - 1)
            for i, (r, g, b) in enumerate(ROT240_COLORS_RGB):
                m = s_valid & (idx == i)
                if not np.any(m):
                    continue
                rgba[m, 0] = r
                rgba[m, 1] = g
                rgba[m, 2] = b
                rgba[m, 3] = 255
        else:
            idx = np.digitize(sample, ETOP18_BIN_EDGES_KFT, right=False)
            idx = np.clip(idx, 0, len(ETOP18_COLORS_RGB) - 1)
            for i, (r, g, b) in enumerate(ETOP18_COLORS_RGB):
                m = s_valid & (idx == i)
                if not np.any(m):
                    continue
                rgba[m, 0] = r
                rgba[m, 1] = g
                rgba[m, 2] = b
                rgba[m, 3] = 255

        buf = BytesIO()
        Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
        return buf.getvalue()

    @staticmethod
    def _sample_frame_value(frame: MrmsFrameData, lat: float, lon: float) -> Optional[float]:
        assert np is not None
        min_lon, min_lat, max_lon, max_lat = frame.bounds
        if not np.isfinite(lat) or not np.isfinite(lon):
            return None
        if lon < min_lon or lon > max_lon or lat < min_lat or lat > max_lat:
            return None

        row_f = (max_lat - lat) / max(max_lat - min_lat, 1e-6) * (frame.nrows - 1)
        col_f = (lon - min_lon) / max(max_lon - min_lon, 1e-6) * (frame.ncols - 1)
        r = int(np.rint(row_f))
        c = int(np.rint(col_f))
        if r < 0 or r >= frame.nrows or c < 0 or c >= frame.ncols:
            return None
        v = frame.values[r, c]
        if not np.isfinite(v):
            return None
        return float(v)

    @staticmethod
    def _interpolate_reflectivity_piecewise(values: "np.ndarray") -> Tuple["np.ndarray", "np.ndarray", "np.ndarray"]:
        assert np is not None
        arr = np.asarray(values, dtype=np.float32)
        r = np.zeros(arr.shape, dtype=np.float32)
        g = np.zeros(arr.shape, dtype=np.float32)
        b = np.zeros(arr.shape, dtype=np.float32)

        # Default clamp colors at extremes.
        low_c = REFL_SEGMENTS[0][2]
        high_c = REFL_SEGMENTS[-1][3]
        r[:] = low_c[0]
        g[:] = low_c[1]
        b[:] = low_c[2]

        high_mask = arr >= REFL_MAX_VALID
        if np.any(high_mask):
            r[high_mask] = high_c[0]
            g[high_mask] = high_c[1]
            b[high_mask] = high_c[2]

        for lo, hi, c0, c1 in REFL_SEGMENTS:
            m = (arr >= lo) & (arr < hi)
            if not np.any(m):
                continue
            span = max(hi - lo, 1e-6)
            t = (arr[m] - lo) / span
            r[m] = c0[0] + (c1[0] - c0[0]) * t
            g[m] = c0[1] + (c1[1] - c0[1]) * t
            b[m] = c0[2] + (c1[2] - c0[2]) * t

        return r.astype(np.uint8), g.astype(np.uint8), b.astype(np.uint8)

    @staticmethod
    def _render_product_to_png(
        grib_path: Path,
        png_path: Path,
        row0_is_north: bool,
        col0_is_west: bool,
        product_id: str,
    ) -> None:
        assert np is not None
        assert Image is not None
        assert pygrib is not None
        style_mode, min_valid = MrmsService._style_for_product(product_id)

        with pygrib.open(str(grib_path)) as grbs:
            msg = grbs.message(1)
            vals = msg.values
            lats, lons = msg.latlons()

        arr = np.asarray(vals, dtype=np.float32)
        lats = np.asarray(lats, dtype=np.float32)
        lons = np.asarray(lons, dtype=np.float32)
        lons = ((lons + 180.0) % 360.0) - 180.0
        if product_id == "etop18":
            arr *= ETOP_KM_TO_KFT
        elif product_id == "rotation240":
            # RotationTrack240min is encoded in x10^-3 s^-1; convert to 1/s.
            arr *= ROT240_RAW_TO_SI

        if np.ma.isMaskedArray(vals):
            mask = np.asarray(vals.mask, dtype=bool)
        else:
            mask = np.zeros(arr.shape, dtype=bool)
        valid = np.isfinite(arr) & (~mask)
        valid &= arr >= min_valid

        # Render into WebMercator grid using native grid extents to align with basemap projection.
        finite_geo = np.isfinite(lats) & np.isfinite(lons)
        if np.any(finite_geo):
            min_lon = float(np.nanmin(lons[finite_geo]))
            max_lon = float(np.nanmax(lons[finite_geo]))
            min_lat = float(np.nanmin(lats[finite_geo]))
            max_lat = float(np.nanmax(lats[finite_geo]))
        else:
            min_lon, min_lat, max_lon, max_lat = -130.0, 20.0, -60.0, 55.0

        width = 2400
        height = 1600

        def merc_y(lat_deg: np.ndarray) -> np.ndarray:
            lat = np.clip(lat_deg, -85.0, 85.0)
            rad = np.deg2rad(lat)
            return np.log(np.tan(np.pi * 0.25 + rad * 0.5))

        min_my = float(merc_y(np.asarray([min_lat], dtype=np.float32))[0])
        max_my = float(merc_y(np.asarray([max_lat], dtype=np.float32))[0])
        if max_my <= min_my:
            max_my = min_my + 1e-6

        x = ((lons - min_lon) * (width - 1) / max(max_lon - min_lon, 1e-6)).astype(np.int32)
        my = merc_y(lats)
        y = ((max_my - my) * (height - 1) / (max_my - min_my)).astype(np.int32)

        in_bounds = valid & (x >= 0) & (x < width) & (y >= 0) & (y < height)
        max_grid = np.full((height, width), -9999.0, dtype=np.float32)
        if np.any(in_bounds):
            flat_idx = (y[in_bounds] * width + x[in_bounds]).astype(np.int64)
            flat_vals = arr[in_bounds]
            max_flat = max_grid.ravel()
            np.maximum.at(max_flat, flat_idx, flat_vals)

        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        out_valid = max_grid > -9000.0
        if style_mode == "reflectivity_piecewise":
            rr, gg, bb = MrmsService._interpolate_reflectivity_piecewise(max_grid)
            rgba[out_valid, 0] = rr[out_valid]
            rgba[out_valid, 1] = gg[out_valid]
            rgba[out_valid, 2] = bb[out_valid]
            rgba[out_valid, 3] = 255
        elif style_mode == "rotation240":
            idx = np.digitize(max_grid, ROT240_BIN_EDGES, right=False)
            idx = np.clip(idx, 0, len(ROT240_COLORS_RGB) - 1)
            for i, (r, g, b) in enumerate(ROT240_COLORS_RGB):
                m = out_valid & (idx == i)
                if not np.any(m):
                    continue
                rgba[m, 0] = r
                rgba[m, 1] = g
                rgba[m, 2] = b
                rgba[m, 3] = 255
        else:
            idx = np.digitize(max_grid, ETOP18_BIN_EDGES_KFT, right=False)
            idx = np.clip(idx, 0, len(ETOP18_COLORS_RGB) - 1)
            for i, (r, g, b) in enumerate(ETOP18_COLORS_RGB):
                m = out_valid & (idx == i)
                if not np.any(m):
                    continue
                rgba[m, 0] = r
                rgba[m, 1] = g
                rgba[m, 2] = b
                rgba[m, 3] = 255

        img = Image.fromarray(rgba, mode="RGBA")
        img.save(png_path, format="PNG")

    def _cleanup_if_needed(self, now: datetime) -> None:
        with self._lock:
            if self._last_cleanup is not None and now - self._last_cleanup < self.cleanup_interval:
                return
            self._last_cleanup = now
        self._cleanup_old_files(now)
        self._enforce_size_cap()

    def _cleanup_old_files(self, now: datetime) -> None:
        cutoff = now - timedelta(minutes=self.raw_retention_minutes)
        for p in self.cache_root.rglob("*"):
            if not p.is_file():
                continue
            try:
                mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
            if mtime < cutoff:
                try:
                    p.unlink()
                except OSError:
                    pass

    def _enforce_size_cap(self) -> None:
        entries: List[Tuple[float, int, Path]] = []
        total = 0
        for p in self.cache_root.rglob("*"):
            if not p.is_file():
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            total += st.st_size
            entries.append((st.st_mtime, st.st_size, p))

        if total <= self.max_cache_bytes:
            return

        entries.sort(key=lambda t: t[0])  # oldest first
        for _, size, path in entries:
            if total <= self.max_cache_bytes:
                break
            try:
                path.unlink()
                total -= size
            except OSError:
                continue
    @staticmethod
    def _render_version_for_product(product_id: str) -> int:
        return int(MRMS_RENDER_VERSION_BY_PRODUCT.get(product_id, 1))
