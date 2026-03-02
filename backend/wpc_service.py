from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any, Dict, List, Optional
import threading
import re

import requests

try:
    import pandas as pd
except Exception:  # pragma: no cover
    pd = None  # type: ignore

try:
    from metpy.io import parse_wpc_surface_bulletin
    from metpy.io.text import _decode_coords, _regroup_lines
except Exception:  # pragma: no cover
    parse_wpc_surface_bulletin = None  # type: ignore
    _decode_coords = None  # type: ignore
    _regroup_lines = None  # type: ignore


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


FRONT_FEATURES = {"WARM", "COLD", "STNRY", "OCFNT", "TROF", "DRYLINE"}
CENTER_FEATURES = {"HIGH", "LOW"}
DRYLINE_TOKENS = {"DRY", "DRYLN", "DRYLNE", "DRYLINE"}


@dataclass
class WpcCacheEntry:
    fetched_at: datetime
    payload: Dict[str, Any]


class WpcSurfaceService:
    def __init__(
        self,
        source_url: str = "https://www.wpc.ncep.noaa.gov/discussions/codsus_hr",
        request_timeout_sec: int = 25,
        refresh_ttl_minutes: int = 10,
        cycle_hours: int = 3,
        issue_delay_minutes: int = 75,
        overdue_grace_minutes: int = 30,
    ) -> None:
        self.source_url = source_url
        self.request_timeout_sec = request_timeout_sec
        self.refresh_ttl = timedelta(minutes=refresh_ttl_minutes)
        self.cycle_hours = cycle_hours
        self.issue_delay_minutes = issue_delay_minutes
        self.overdue_grace_minutes = overdue_grace_minutes
        self._lock = threading.Lock()
        self._cache: Optional[WpcCacheEntry] = None

    def get_latest(self) -> Dict[str, Any]:
        if parse_wpc_surface_bulletin is None or pd is None:
            raise RuntimeError("WPC parsing dependencies missing; install metpy and pandas")

        now = datetime.now(timezone.utc)
        with self._lock:
            if self._cache and (now - self._cache.fetched_at) < self.refresh_ttl:
                return self._cache.payload

        bulletin = self._fetch_bulletin_text()
        parsed = parse_wpc_surface_bulletin(BytesIO(bulletin.encode("utf-8")))
        dryline_rows = self._extract_dryline_rows(bulletin)
        if dryline_rows:
            parsed = pd.concat([parsed, pd.DataFrame(dryline_rows)], ignore_index=True)
        payload = self._build_payload(parsed, now)

        with self._lock:
            self._cache = WpcCacheEntry(fetched_at=now, payload=payload)
        return payload

    def _fetch_bulletin_text(self) -> str:
        resp = requests.get(
            self.source_url,
            timeout=self.request_timeout_sec,
            headers={"User-Agent": "WxAnalysis/1.0"},
        )
        resp.raise_for_status()
        return resp.text

    def _build_payload(self, df: "pd.DataFrame", fetched_at: datetime) -> Dict[str, Any]:
        expected_cycle = self._expected_cycle_valid_time(fetched_at)
        expected_issue_time = expected_cycle + timedelta(minutes=self.issue_delay_minutes)
        overdue_threshold = expected_issue_time + timedelta(minutes=self.overdue_grace_minutes)

        if df is None or df.empty:
            return {
                "product": "wpc_surface",
                "source_url": self.source_url,
                "fetched_at": _iso_z(fetched_at),
                "valid_time": None,
                "age_minutes": None,
                "stale_warning": fetched_at > overdue_threshold,
                "expected_cycle_valid_time": _iso_z(expected_cycle),
                "expected_issue_time": _iso_z(expected_issue_time),
                "overdue_threshold_time": _iso_z(overdue_threshold),
                "fronts": {"type": "FeatureCollection", "features": []},
                "centers": {"type": "FeatureCollection", "features": []},
                "counts": {"fronts": 0, "centers": 0},
                "front_types_present": [],
            }

        valid_series = pd.to_datetime(df["valid"], utc=True, errors="coerce")
        if valid_series.notna().any():
            latest_valid = valid_series.max().to_pydatetime().astimezone(timezone.utc)
            mask = valid_series == valid_series.max()
            active = df[mask].copy()
        else:
            latest_valid = None
            active = df.copy()

        fronts: List[Dict[str, Any]] = []
        centers: List[Dict[str, Any]] = []

        for _, row in active.iterrows():
            feature = str(row.get("feature", "")).upper().strip()
            geom = row.get("geometry")
            if geom is None:
                continue
            geom_json = getattr(geom, "__geo_interface__", None)
            if not geom_json:
                continue

            strength_raw = row.get("strength")
            strength = None
            if pd.notna(strength_raw):
                try:
                    strength = int(strength_raw)
                except Exception:
                    strength = None

            props: Dict[str, Any] = {"feature": feature, "strength": strength}
            ft = {"type": "Feature", "geometry": geom_json, "properties": props}

            if feature in FRONT_FEATURES:
                gtype = str(geom_json.get("type", ""))
                if gtype in {"LineString", "MultiLineString"}:
                    fronts.append(ft)
            elif feature in CENTER_FEATURES:
                gtype = str(geom_json.get("type", ""))
                if gtype == "Point":
                    centers.append(ft)

        age_minutes = None
        stale_warning = True
        if latest_valid is not None:
            age_minutes = round((datetime.now(timezone.utc) - latest_valid).total_seconds() / 60.0, 1)
            stale_warning = fetched_at > overdue_threshold and latest_valid < expected_cycle

        overdue_by_minutes = None
        if stale_warning:
            overdue_by_minutes = round((fetched_at - overdue_threshold).total_seconds() / 60.0, 1)

        return {
            "product": "wpc_surface",
            "source_url": self.source_url,
            "fetched_at": _iso_z(fetched_at),
            "valid_time": _iso_z(latest_valid) if latest_valid else None,
            "age_minutes": age_minutes,
            "stale_warning": stale_warning,
            "expected_cycle_valid_time": _iso_z(expected_cycle),
            "expected_issue_time": _iso_z(expected_issue_time),
            "overdue_threshold_time": _iso_z(overdue_threshold),
            "overdue_by_minutes": overdue_by_minutes,
            "fronts": {"type": "FeatureCollection", "features": fronts},
            "centers": {"type": "FeatureCollection", "features": centers},
            "counts": {"fronts": len(fronts), "centers": len(centers)},
            "front_types_present": sorted({str((f.get("properties") or {}).get("feature", "")).upper() for f in fronts}),
        }

    def _expected_cycle_valid_time(self, now_utc: datetime) -> datetime:
        now_utc = now_utc.astimezone(timezone.utc).replace(second=0, microsecond=0)
        cycle_hour = (now_utc.hour // self.cycle_hours) * self.cycle_hours
        cycle = now_utc.replace(hour=cycle_hour, minute=0)
        cycle_due = cycle + timedelta(minutes=self.issue_delay_minutes)
        if now_utc < cycle_due:
            cycle -= timedelta(hours=self.cycle_hours)
        return cycle

    def _extract_dryline_rows(self, bulletin_text: str) -> List[Dict[str, Any]]:
        if _decode_coords is None or _regroup_lines is None or pd is None:
            return []
        try:
            from shapely.geometry import LineString
        except Exception:
            return []

        now = datetime.now(timezone.utc)
        valid_time = now.replace(minute=0, second=0, microsecond=0)
        rows: List[Dict[str, Any]] = []

        for parts in _regroup_lines(bulletin_text.splitlines()):
            if not parts:
                continue
            head = str(parts[0]).upper()
            if head in {"VALID", "SURFACE PROG VALID"} and len(parts) > 1:
                dtstr = parts[-1]
                m = re.match(r"^(\d{2})(\d{2})(\d{2})Z?$", dtstr)
                if m:
                    mm, dd, hh = int(m.group(1)), int(m.group(2)), int(m.group(3))
                    try:
                        valid_time = valid_time.replace(month=mm, day=dd, hour=hh, tzinfo=timezone.utc)
                    except Exception:
                        pass
                continue

            feature = head
            if feature not in DRYLINE_TOKENS:
                continue

            coords: List[Any] = []
            for token in parts[1:]:
                t = str(token).strip().upper()
                if not t:
                    continue
                if re.match(r"^[A-Z]+$", t):
                    continue
                if not re.match(r"^-?\d+$", t):
                    continue
                try:
                    coords.append(_decode_coords(t))
                except Exception:
                    continue

            if len(coords) < 2:
                continue
            try:
                geom = LineString(coords)
            except Exception:
                continue
            rows.append({
                "valid": valid_time,
                "feature": "DRYLINE",
                "strength": None,
                "geometry": geom,
            })

        return rows
