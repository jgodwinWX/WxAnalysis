from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple
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


def _normalize_wpc_bulletin_text(bulletin_text: str) -> str:
    # Some WPC bulletins occasionally include a stray minus sign between the
    # latitude and longitude halves of a compact coordinate token, e.g.
    # "619-1795" instead of "6191795". MetPy's parser expects the compact form.
    return re.sub(r"\b(\d{3})-(\d{4})\b", r"\1\2", bulletin_text)


def _normalize_lon_lat(lon: Any, lat: Any) -> Tuple[float, float]:
    lon_f = float(lon)
    lat_f = float(lat)
    while abs(lon_f) > 180.0:
        lon_f /= 10.0
    while abs(lat_f) > 90.0:
        lat_f /= 10.0
    return lon_f, lat_f


def _normalize_geometry_geojson(geometry: Dict[str, Any]) -> Dict[str, Any]:
    gtype = str(geometry.get("type", ""))
    coords = geometry.get("coordinates")
    if coords is None:
        return geometry

    def normalize_pair(pair: Any) -> List[float]:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            return list(pair) if isinstance(pair, (list, tuple)) else [pair]
        lon_f, lat_f = _normalize_lon_lat(pair[0], pair[1])
        rest = list(pair[2:]) if len(pair) > 2 else []
        return [lon_f, lat_f, *rest]

    if gtype == "Point":
        out_coords = normalize_pair(coords)
    elif gtype == "LineString":
        out_coords = [normalize_pair(pair) for pair in coords]
    elif gtype == "MultiLineString":
        out_coords = [[normalize_pair(pair) for pair in line] for line in coords]
    else:
        return geometry

    out = dict(geometry)
    out["coordinates"] = out_coords
    return out


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
        history_retention_hours: int = 24,
    ) -> None:
        self.source_url = source_url
        self.request_timeout_sec = request_timeout_sec
        self.refresh_ttl = timedelta(minutes=refresh_ttl_minutes)
        self.cycle_hours = cycle_hours
        self.issue_delay_minutes = issue_delay_minutes
        self.overdue_grace_minutes = overdue_grace_minutes
        self.history_retention = timedelta(hours=history_retention_hours)
        self._lock = threading.Lock()
        self._cache: Optional[WpcCacheEntry] = None
        self._history: Dict[str, Dict[str, Any]] = {}

    def get_latest(self) -> Dict[str, Any]:
        if parse_wpc_surface_bulletin is None or pd is None:
            raise RuntimeError("WPC parsing dependencies missing; install metpy and pandas")

        now = datetime.now(timezone.utc)
        with self._lock:
            if self._cache and (now - self._cache.fetched_at) < self.refresh_ttl:
                return self._cache.payload

        bulletin = _normalize_wpc_bulletin_text(self._fetch_bulletin_text())
        parsed = parse_wpc_surface_bulletin(BytesIO(bulletin.encode("utf-8")))
        dryline_rows = self._extract_dryline_rows(bulletin)
        if dryline_rows:
            parsed = pd.concat([parsed, pd.DataFrame(dryline_rows)], ignore_index=True)
        payload = self._build_payload(parsed, now)

        with self._lock:
            self._cache = WpcCacheEntry(fetched_at=now, payload=payload)
            self._store_history_entry(payload, now)
        return payload

    def get_for_time(self, requested_time: Optional[datetime]) -> Dict[str, Any]:
        latest = self.get_latest()
        if requested_time is None:
            return self._decorate_payload(
                latest,
                requested_time=None,
                matched_time=latest.get("valid_time"),
                match_delta_minutes=0.0,
                match_status="latest",
                match_tolerance_minutes=None,
            )

        target = requested_time.astimezone(timezone.utc).replace(microsecond=0)
        tolerance_minutes = self._bucket_match_tolerance_minutes(target)
        history = self.get_timeseries()
        if not history:
            raise FileNotFoundError("No WPC surface analysis history available")

        def sort_key(payload: Dict[str, Any]) -> Any:
            valid_iso = payload.get("valid_time")
            valid_dt = self._parse_iso_time(valid_iso)
            if valid_dt is None:
                return (float("inf"), 0.0)
            diff_seconds = abs((valid_dt - target).total_seconds())
            return (diff_seconds, -valid_dt.timestamp())

        matched = min(history, key=sort_key)
        matched_time = self._parse_iso_time(matched.get("valid_time"))
        if matched_time is None:
            raise FileNotFoundError("No WPC surface analysis valid time available")
        delta_minutes = round((matched_time - target).total_seconds() / 60.0, 1)
        if abs(delta_minutes) > tolerance_minutes:
            raise FileNotFoundError(
                f"No WPC surface analysis available within {tolerance_minutes} minutes of {_iso_z(target)}"
            )
        return self._decorate_payload(
            matched,
            requested_time=target,
            matched_time=matched.get("valid_time"),
            match_delta_minutes=delta_minutes,
            match_status=self._match_status_from_delta(delta_minutes),
            match_tolerance_minutes=tolerance_minutes,
        )

    def get_timeseries(self) -> List[Dict[str, Any]]:
        self.get_latest()
        now = datetime.now(timezone.utc)
        with self._lock:
            self._prune_history(now)
            return sorted(
                self._history.values(),
                key=lambda payload: self._parse_iso_time(payload.get("valid_time")) or datetime.min.replace(tzinfo=timezone.utc),
            )

    def _fetch_bulletin_text(self) -> str:
        resp = requests.get(
            self.source_url,
            timeout=self.request_timeout_sec,
            headers={"User-Agent": "WxAnalysis/1.0"},
        )
        resp.raise_for_status()
        return resp.text

    def _store_history_entry(self, payload: Dict[str, Any], now: datetime) -> None:
        valid_time = payload.get("valid_time")
        if valid_time:
            self._history[str(valid_time)] = payload
        self._prune_history(now)

    def _prune_history(self, now: datetime) -> None:
        cutoff = now - self.history_retention
        stale_keys = [
            key
            for key, payload in self._history.items()
            if (self._parse_iso_time(payload.get("valid_time")) or now) < cutoff
        ]
        for key in stale_keys:
            self._history.pop(key, None)

    @staticmethod
    def _parse_iso_time(value: Any) -> Optional[datetime]:
        if not isinstance(value, str) or not value:
            return None
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).replace(microsecond=0)

    @staticmethod
    def _bucket_match_tolerance_minutes(target: datetime, now: Optional[datetime] = None) -> int:
        ref = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        age_minutes = max(0.0, (ref - target.astimezone(timezone.utc)).total_seconds() / 60.0)
        return 10 if age_minutes <= 60.0 else 15

    @staticmethod
    def _match_status_from_delta(delta_minutes: float) -> str:
        delta = abs(delta_minutes)
        if delta <= 2.0:
            return "exact"
        if delta <= 5.0:
            return "near"
        return "approximate"

    @staticmethod
    def _decorate_payload(
        payload: Dict[str, Any],
        requested_time: Optional[datetime],
        matched_time: Optional[str],
        match_delta_minutes: float,
        match_status: str,
        match_tolerance_minutes: Optional[int],
    ) -> Dict[str, Any]:
        out = dict(payload)
        out["requested_time"] = _iso_z(requested_time) if requested_time else None
        out["matched_time"] = matched_time
        out["match_delta_minutes"] = match_delta_minutes
        out["match_status"] = match_status
        out["match_tolerance_minutes"] = match_tolerance_minutes
        return out

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
            geom_json = _normalize_geometry_geojson(geom_json)

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
