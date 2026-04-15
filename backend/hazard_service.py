from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import unescape
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin
import re
import threading
import xml.etree.ElementTree as ET

import requests


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso_z(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0)


STATE_ABBR_TO_NAME = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}
STATE_NAME_TO_ABBR = {name.upper(): abbr for abbr, name in STATE_ABBR_TO_NAME.items()}
STATE_NAME_TO_ABBR["DISTRICT OF COLUMBIA"] = "DC"
ALERT_UGC_PREFIX_TO_STATE = {abbr: abbr for abbr in STATE_ABBR_TO_NAME}

EVENT_STYLE_BY_TYPE: Dict[str, Dict[str, str]] = {
    "tornado_watch": {"group": "watches", "menu_group": "convectiveWatches", "label": "Tornado Watch"},
    "severe_thunderstorm_watch": {"group": "watches", "menu_group": "convectiveWatches", "label": "Severe Thunderstorm Watch"},
    "tornado_warning": {"group": "warnings", "menu_group": "convectiveWarnings", "label": "Tornado Warning"},
    "severe_thunderstorm_warning": {"group": "warnings", "menu_group": "convectiveWarnings", "label": "Severe Thunderstorm Warning"},
    "flash_flood_warning": {"group": "warnings", "menu_group": "floodWarnings", "label": "Flash Flood Warning"},
    "spc_md": {"group": "discussions", "menu_group": "spcMesoscaleDiscussions", "label": "SPC Mesoscale Discussion"},
    "wpc_mpd": {"group": "discussions", "menu_group": "wpcMesoscaleDiscussions", "label": "WPC Mesoscale Discussion"},
}
NWS_EVENT_TO_KIND = {
    "Tornado Warning": "tornado_warning",
    "Severe Thunderstorm Warning": "severe_thunderstorm_warning",
    "Flash Flood Warning": "flash_flood_warning",
}


@dataclass
class HazardRecord:
    feature_id: str
    kind: str
    source: str
    product_number: Optional[str]
    title: str
    issued_at: Optional[datetime]
    ends_at: Optional[datetime]
    states: List[str]
    coverage_counties: List[str]
    text_url: Optional[str]
    discussion_text: Optional[str]
    summary: Optional[str]
    geometry: Optional[dict]
    bbox: Optional[List[float]]
    fetched_at: datetime

    def is_active_at(self, target: datetime) -> bool:
        if self.issued_at and target < self.issued_at:
            return False
        if self.ends_at and target > self.ends_at:
            return False
        return True

    def to_item(self) -> dict:
        style = EVENT_STYLE_BY_TYPE.get(self.kind, {})
        return {
            "id": self.feature_id,
            "kind": self.kind,
            "group": style.get("group"),
            "menu_group": style.get("menu_group"),
            "label": style.get("label", self.title),
            "product_number": self.product_number,
            "title": self.title,
            "issued_at": _iso_z(self.issued_at) if self.issued_at else None,
            "ends_at": _iso_z(self.ends_at) if self.ends_at else None,
            "states": self.states,
            "coverage_counties": self.coverage_counties,
            "text_url": self.text_url,
            "discussion_text": self.discussion_text,
            "summary": self.summary,
            "bbox": self.bbox,
        }

    def to_feature(self) -> Optional[dict]:
        if not self.geometry:
            return None
        properties = self.to_item()
        properties["source"] = self.source
        properties["fetched_at"] = _iso_z(self.fetched_at)
        return {"type": "Feature", "id": self.feature_id, "geometry": self.geometry, "properties": properties}


class HazardService:
    def __init__(
        self,
        request_timeout_sec: int = 25,
        current_ttl_minutes: int = 2,
        history_retention_hours: int = 24,
    ) -> None:
        self.request_timeout_sec = request_timeout_sec
        self.current_ttl = timedelta(minutes=current_ttl_minutes)
        self.history_retention = timedelta(hours=history_retention_hours)
        self.user_agent = "WxAnalysis/1.0"
        self._lock = threading.Lock()
        self._current_fetched_at: Optional[datetime] = None
        self._current_records: Dict[str, HazardRecord] = {}
        self._history_records: Dict[str, HazardRecord] = {}
        self._last_error: Optional[str] = None

    def refresh(self) -> dict:
        now = datetime.now(timezone.utc)
        headers = {"User-Agent": self.user_agent, "Accept": "application/geo+json, application/json;q=0.9, text/html;q=0.8"}
        records: List[HazardRecord] = []
        records.extend(self._fetch_nws_alerts(now, headers))
        records.extend(self._fetch_spc_watches(now, headers))
        records.extend(self._fetch_spc_mds(now, headers))
        records.extend(self._fetch_wpc_mpds(now, headers))

        current = {record.feature_id: record for record in records}
        with self._lock:
            self._current_fetched_at = now
            self._current_records = current
            for feature_id, record in current.items():
                self._history_records[feature_id] = record
            self._prune_history(now)
            self._last_error = None
        return self.get_summary(None, allow_refresh=False)

    def get_summary(self, requested_time: Optional[datetime], allow_refresh: bool = True) -> dict:
        now = datetime.now(timezone.utc)
        if allow_refresh and self._needs_refresh(now):
            try:
                return self.refresh()
            except Exception as e:
                with self._lock:
                    self._last_error = str(e)
                    self._prune_history(now)

        with self._lock:
            current_records = list(self._current_records.values())
            history_records = list(self._history_records.values())
            fetched_at = self._current_fetched_at
            last_error = self._last_error

        current_lists = self._build_current_lists(current_records)
        if requested_time is None:
            matched_records = sorted(current_records, key=self._sort_by_issued_desc)
            matched_time = fetched_at
            match_status = "latest"
            match_delta_minutes = 0.0
        else:
            target = requested_time.astimezone(timezone.utc).replace(microsecond=0)
            matched_records = sorted(
                [record for record in history_records if record.is_active_at(target)],
                key=self._sort_by_issued_desc,
            )
            matched_time = target
            match_status = "exact"
            match_delta_minutes = 0.0

        features = [record.to_feature() for record in matched_records]
        return {
            "requested_time": _iso_z(requested_time) if requested_time else None,
            "matched_time": _iso_z(matched_time) if matched_time else None,
            "match_status": match_status,
            "match_delta_minutes": match_delta_minutes,
            "history_retention_hours": int(self.history_retention.total_seconds() // 3600),
            "fetched_at": _iso_z(fetched_at) if fetched_at else None,
            "last_error": last_error,
            "current": current_lists,
            "matched": {"type": "FeatureCollection", "features": [feature for feature in features if feature is not None]},
        }

    def _needs_refresh(self, now: datetime) -> bool:
        with self._lock:
            return self._current_fetched_at is None or (now - self._current_fetched_at) > self.current_ttl

    def _prune_history(self, now: datetime) -> None:
        cutoff = now - self.history_retention
        stale_ids = []
        for feature_id, record in self._history_records.items():
            end = record.ends_at or record.issued_at or record.fetched_at
            if end < cutoff:
                stale_ids.append(feature_id)
        for feature_id in stale_ids:
            self._history_records.pop(feature_id, None)

    @staticmethod
    def _sort_by_issued_desc(record: HazardRecord) -> Tuple[float, str]:
        ts = record.issued_at.timestamp() if record.issued_at else 0.0
        return (-ts, record.feature_id)

    def _build_current_lists(self, records: List[HazardRecord]) -> dict:
        warnings = []
        watches = []
        discussions = []
        for record in sorted(records, key=self._sort_by_issued_desc):
            item = record.to_item()
            group = EVENT_STYLE_BY_TYPE.get(record.kind, {}).get("group")
            if group == "warnings":
                warnings.append(item)
            elif group == "watches":
                watches.append(item)
            elif group == "discussions":
                discussions.append(item)
        return {"warnings": warnings, "watches": watches, "discussions": discussions}

    def _fetch_nws_alerts(self, now: datetime, headers: Dict[str, str]) -> List[HazardRecord]:
        resp = requests.get(
            "https://api.weather.gov/alerts/active",
            params={"status": "actual"},
            timeout=self.request_timeout_sec,
            headers=headers,
        )
        resp.raise_for_status()
        payload = resp.json()
        features = payload.get("features")
        if not isinstance(features, list):
            return []
        out: List[HazardRecord] = []
        for feature in features:
            if not isinstance(feature, dict):
                continue
            record = self._normalize_nws_alert(feature, now)
            if record is not None:
                out.append(record)
        return out

    def _fetch_spc_watches(self, now: datetime, headers: Dict[str, str]) -> List[HazardRecord]:
        base_url = "https://www.spc.noaa.gov/products/watch/"
        resp = requests.get(base_url, timeout=self.request_timeout_sec, headers=headers)
        resp.raise_for_status()
        html = resp.text
        out: List[HazardRecord] = []
        pattern = re.compile(
            r'<strong><a href="(?P<href>[^"]*ww(?P<num>\d{4})\.html)">\s*(?P<title>(?:Tornado|Severe Thunderstorm) Watch)\s*#(?P<num2>\d+)\s*</a></strong><br\s*/?>\s*'
            r'Issued:\s*(?P<issued>[^<]+?)<br\s*/?>\s*'
            r'(?:Updated:\s*(?P<updated>[^<]+?)<br\s*/?>\s*)?'
            r'Expires:\s*(?P<expires>[^<]+?)<br',
            re.IGNORECASE | re.DOTALL,
        )
        for match in pattern.finditer(html):
            href = match.group("href")
            watch_number = str(int(match.group("num2")))
            title = _clean_text_block(match.group("title")) or "SPC Convective Watch"
            kind = "tornado_watch" if "tornado" in title.lower() else "severe_thunderstorm_watch"
            detail_url = urljoin(base_url, href)
            issued_at = _parse_spc_watch_datetime(match.group("issued"))
            ends_at = _parse_spc_watch_datetime(match.group("expires"))
            discussion_text, geometry, summary, states = self._fetch_spc_watch_detail(detail_url, headers)
            bbox = _bbox_from_geometry(geometry)
            out.append(
                HazardRecord(
                    feature_id=f"spc_watch_{watch_number}",
                    kind=kind,
                    source="spc",
                    product_number=watch_number,
                    title=title,
                    issued_at=issued_at,
                    ends_at=ends_at,
                    states=states,
                    coverage_counties=[],
                    text_url=None,
                    discussion_text=discussion_text,
                    summary=summary,
                    geometry=geometry,
                    bbox=bbox,
                    fetched_at=now,
                )
            )
        return out

    def _normalize_nws_alert(self, feature: dict, fetched_at: datetime) -> Optional[HazardRecord]:
        props = feature.get("properties") or {}
        event = str(props.get("event") or "").strip()
        kind = NWS_EVENT_TO_KIND.get(event)
        if kind is None:
            return None
        status = str(props.get("status") or "").upper()
        message_type = str(props.get("messageType") or "").upper()
        if status and status != "ACTUAL":
            return None
        if message_type and message_type not in {"ALERT", "UPDATE"}:
            return None

        feature_id = str(feature.get("id") or props.get("@id") or props.get("id") or "")
        if not feature_id:
            return None
        issued_at = _parse_iso_z(props.get("onset") or props.get("effective") or props.get("sent"))
        ends_at = _parse_iso_z(props.get("ends") or props.get("expires"))
        geometry = feature.get("geometry") if isinstance(feature.get("geometry"), dict) else None
        bbox = _bbox_from_geometry(geometry)
        states = _extract_states_from_ugc((props.get("geocode") or {}).get("UGC"))
        if not states:
            states = _extract_states_from_text(str(props.get("areaDesc") or ""))
        coverage_counties = _extract_warning_coverage_counties(str(props.get("areaDesc") or ""), states)
        product_number = _extract_nws_product_number(kind, props)
        text_url = str(props.get("@id") or props.get("id") or feature.get("id") or "")
        summary = str(props.get("headline") or props.get("description") or event).strip() or None
        discussion_text = _clean_text_block(
            "\n\n".join(part for part in [props.get("headline"), props.get("description"), props.get("instruction")] if part)
        )
        return HazardRecord(
            feature_id=feature_id,
            kind=kind,
            source="nws",
            product_number=product_number,
            title=event,
            issued_at=issued_at,
            ends_at=ends_at,
            states=states,
            coverage_counties=coverage_counties,
            text_url=text_url or None,
            discussion_text=discussion_text,
            summary=summary,
            geometry=geometry,
            bbox=bbox,
            fetched_at=fetched_at,
        )

    def _fetch_spc_mds(self, now: datetime, headers: Dict[str, str]) -> List[HazardRecord]:
        base_url = "https://www.spc.noaa.gov/products/md/"
        resp = requests.get(base_url, timeout=self.request_timeout_sec, headers=headers)
        resp.raise_for_status()
        html = resp.text
        out: List[HazardRecord] = []
        pattern = re.compile(
            r'href="(?P<href>md(?P<num>\d{4})\.html)".*?Mesoscale Discussion #(?P=num).*?Issued:\s*(?P<issued>\d{2}/\d{4}) UTC.*?Until:\s*(?P<until>\d{2}/\d{4}) UTC.*?Concerning:\s*(?P<concerning>[^<]+)',
            re.IGNORECASE | re.DOTALL,
        )
        for match in pattern.finditer(html):
            number = match.group("num")
            text_url = urljoin(base_url, match.group("href"))
            issued_at = _parse_monthless_day_time(match.group("issued"), now)
            ends_at = _parse_monthless_day_time(match.group("until"), now)
            concerning = _clean_text_block(match.group("concerning"))
            discussion_text, geometry = self._fetch_spc_md_detail(text_url, headers)
            bbox = _bbox_from_geometry(geometry)
            states = _extract_states_from_text(f"{concerning}\n{discussion_text or ''}")
            out.append(
                HazardRecord(
                    feature_id=f"spc_md_{number}",
                    kind="spc_md",
                    source="spc",
                    product_number=str(int(number)),
                    title="SPC Mesoscale Discussion",
                    issued_at=issued_at,
                    ends_at=ends_at,
                    states=states,
                    coverage_counties=[],
                    text_url=text_url,
                    discussion_text=discussion_text,
                    summary=concerning,
                    geometry=geometry,
                    bbox=bbox,
                    fetched_at=now,
                )
            )
        return out

    def _fetch_spc_md_detail(self, text_url: str, headers: Dict[str, str]) -> Tuple[Optional[str], Optional[dict]]:
        resp = requests.get(text_url, timeout=self.request_timeout_sec, headers=headers)
        resp.raise_for_status()
        product_text = _extract_preformatted_product_text(resp.text)
        text = product_text or _clean_html_text(resp.text)
        discussion_text = _extract_discussion_text(text)
        geometry = _geometry_from_lat_lon_block(text, expected_region="spc_md")
        return discussion_text, geometry

    def _fetch_spc_watch_detail(
        self,
        text_url: str,
        headers: Dict[str, str],
    ) -> Tuple[Optional[str], Optional[dict], Optional[str], List[str]]:
        resp = requests.get(text_url, timeout=self.request_timeout_sec, headers=headers)
        resp.raise_for_status()
        text = _clean_html_text(resp.text)
        discussion_text = _extract_watch_text(text)
        geometry = _geometry_from_lat_lon_block(text, expected_region="conus_watch")
        states = _extract_states_from_watch_text(discussion_text or text)
        summary = _extract_watch_summary(discussion_text)
        return discussion_text, geometry, summary, states

    def _fetch_wpc_mpds(self, now: datetime, headers: Dict[str, str]) -> List[HazardRecord]:
        base_url = "https://www.wpc.ncep.noaa.gov/metwatch/metwatch_mpd.php"
        resp = requests.get(base_url, timeout=self.request_timeout_sec, headers=headers)
        resp.raise_for_status()
        html = resp.text
        out: List[HazardRecord] = []
        pattern = re.compile(
            r'href="(?P<href>[^"]*metwatch_mpd\.php[^"]*)".*?MPD\s*#(?P<num>\d+).*?Issued:\s*(?P<issued>\d{2}/\d{4}) UTC.*?Until:\s*(?P<until>\d{2}/\d{4}) UTC.*?Concerning:\s*(?P<concerning>[^<]+)',
            re.IGNORECASE | re.DOTALL,
        )
        seen: set[str] = set()
        for match in pattern.finditer(html):
            href = match.group("href")
            if href in seen:
                continue
            seen.add(href)
            number = match.group("num")
            text_url = urljoin(base_url, href)
            issued_at = _parse_monthless_day_time(match.group("issued"), now)
            ends_at = _parse_monthless_day_time(match.group("until"), now)
            concerning = _clean_text_block(match.group("concerning"))
            discussion_text, geometry = self._fetch_wpc_mpd_detail(text_url, headers)
            bbox = _bbox_from_geometry(geometry)
            states = _extract_states_from_text(f"{concerning}\n{discussion_text or ''}")
            out.append(
                HazardRecord(
                    feature_id=f"wpc_mpd_{int(number)}",
                    kind="wpc_mpd",
                    source="wpc",
                    product_number=str(int(number)),
                    title="WPC Mesoscale Discussion",
                    issued_at=issued_at,
                    ends_at=ends_at,
                    states=states,
                    coverage_counties=[],
                    text_url=text_url,
                    discussion_text=discussion_text,
                    summary=concerning,
                    geometry=geometry,
                    bbox=bbox,
                    fetched_at=now,
                )
            )
        return out

    def _fetch_wpc_mpd_detail(self, text_url: str, headers: Dict[str, str]) -> Tuple[Optional[str], Optional[dict]]:
        resp = requests.get(text_url, timeout=self.request_timeout_sec, headers=headers)
        resp.raise_for_status()
        text = _clean_html_text(resp.text)
        discussion_text = _extract_discussion_text(text)
        geometry = _geometry_from_lat_lon_block(text)
        if geometry is None:
            geometry = _geometry_from_kml_link(resp.text, text_url, headers, self.request_timeout_sec)
        return discussion_text, geometry


def _extract_nws_product_number(kind: str, props: dict) -> Optional[str]:
    parameters = props.get("parameters") or {}
    for key in ("eventTrackingNumber", "ETN"):
        values = parameters.get(key)
        if isinstance(values, list) and values:
            raw = str(values[0]).strip()
            digits = re.findall(r"\d+", raw)
            if digits:
                return str(int(digits[-1]))
    vtec_list = parameters.get("VTEC")
    if isinstance(vtec_list, list):
        for item in vtec_list:
            m = re.search(r"\.(\d{4})\.", str(item))
            if m:
                return str(int(m.group(1)))
    return None


def _parse_spc_watch_datetime(value: str) -> Optional[datetime]:
    m = re.search(
        r"([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{2})(\d{2})\s+UTC",
        value or "",
        re.IGNORECASE,
    )
    if not m:
        return None
    month_name = m.group(1).title()
    month_map = {
        "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
        "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
    }
    month = month_map.get(month_name)
    if month is None:
        return None
    try:
        return datetime(
            int(m.group(3)),
            month,
            int(m.group(2)),
            int(m.group(4)),
            int(m.group(5)),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None


def _parse_monthless_day_time(value: str, ref: datetime) -> Optional[datetime]:
    m = re.match(r"^\s*(\d{2})/(\d{4})\s*$", value or "")
    if not m:
        return None
    day = int(m.group(1))
    hhmm = m.group(2)
    hour = int(hhmm[:2])
    minute = int(hhmm[2:])
    base = ref.astimezone(timezone.utc).replace(second=0, microsecond=0)
    candidate = base.replace(day=min(day, 28 if base.month == 2 else day), hour=hour, minute=minute)
    # Rebuild safely across month edges.
    for month_offset in (0, -1, 1):
        y = base.year
        month = base.month + month_offset
        while month < 1:
            month += 12
            y -= 1
        while month > 12:
            month -= 12
            y += 1
        try:
            dt = datetime(y, month, day, hour, minute, tzinfo=timezone.utc)
        except ValueError:
            continue
        if abs((dt - base).total_seconds()) <= 20 * 86400:
            return dt
    return None


def _clean_html_text(html: str) -> str:
    text = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
    text = re.sub(r"(?is)<style.*?>.*?</style>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</p>", "\n\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return _clean_text_block(unescape(text))


def _clean_text_block(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    cleaned = re.sub(r"\r", "", text)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n\s*\n\s*\n+", "\n\n", cleaned)
    cleaned = "\n".join(line.strip() for line in cleaned.splitlines())
    cleaned = cleaned.strip()
    return cleaned or None


def _extract_preformatted_product_text(html: str) -> Optional[str]:
    match = re.search(r"(?is)<pre[^>]*>(.*?)</pre>", html or "")
    if not match:
        return None
    return _clean_html_text(match.group(1))


def _extract_discussion_text(text: str) -> Optional[str]:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if not lines:
        return None
    keep = []
    for line in lines:
        if line.startswith("$$"):
            break
        if line.startswith("ATTN..."):
            continue
        if re.match(r"^[A-Z]{3,}\s+\d{6}", line):
            continue
        keep.append(line)
    return _clean_text_block("\n".join(keep))


def _extract_watch_text(text: str) -> Optional[str]:
    match = re.search(
        r"(URGENT\s*-\s*IMMEDIATE BROADCAST REQUESTED.*?)(?:\n\s*STATUS REPORT #|\n\s*THE WATCH STATUS MESSAGE IS FOR GUIDANCE PURPOSES ONLY|\Z)",
        text or "",
        re.IGNORECASE | re.DOTALL,
    )
    if match:
        return _clean_text_block(match.group(1))
    return _extract_discussion_text(text)


def _extract_watch_summary(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    m = re.search(r"\bSUMMARY\.\.\.(.*?)(?:\n\s*\n|\n\s*The tornado watch area is|\n\s*\*)", text, re.IGNORECASE | re.DOTALL)
    if m:
        return _clean_text_block(m.group(1))
    m = re.search(r"\*\s+Primary threats include\.\.\.(.*?)(?:\n\s*\n|\n\s*SUMMARY\.\.\.)", text, re.IGNORECASE | re.DOTALL)
    if m:
        return _clean_text_block(m.group(1))
    return None


def _extract_states_from_watch_text(text: str) -> List[str]:
    ordered = _extract_states_from_watch_portions_block(text)
    if ordered:
        return ordered
    ordered = _extract_states_from_watch_state_headers(text)
    if ordered:
        return ordered
    return _extract_states_from_text(text)


def _extract_states_from_watch_portions_block(text: str) -> List[str]:
    match = re.search(
        r"\*\s+(?:Tornado|Severe Thunderstorm)\s+Watch\s+for\s+portions\s+of\s+(.*?)(?:\n\s*\*|\n\s*SUMMARY\.\.\.|\n\s*The\s+\w+\s+watch\s+area\s+is)",
        text or "",
        re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return []
    block = match.group(1)
    lines = [line.strip(" .") for line in block.splitlines() if line.strip()]
    return _ordered_states_from_lines(lines)


def _extract_states_from_watch_state_headers(text: str) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for match in re.finditer(r"^\s*([A-Z]{2})\s*$", text or "", re.MULTILINE):
        abbr = match.group(1)
        if abbr in STATE_ABBR_TO_NAME and abbr not in seen:
            seen.add(abbr)
            ordered.append(abbr)
    return ordered


def _ordered_states_from_lines(lines: List[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for line in lines:
        upper = line.upper()
        for name, abbr in STATE_NAME_TO_ABBR.items():
            if re.search(rf"\b{re.escape(name)}\b", upper) and abbr not in seen:
                seen.add(abbr)
                ordered.append(abbr)
                break
    return ordered


def _geometry_from_lat_lon_block(text: str, expected_region: Optional[str] = None) -> Optional[dict]:
    m = re.search(r"LAT\.\.\.LON\s+([0-9\s]+)", text or "", re.IGNORECASE)
    if not m:
        return None
    tokens = re.findall(r"\d{8}", m.group(1))
    coords: List[List[float]] = []
    for token in tokens:
        lat = int(token[:4]) / 100.0
        lon_hundredths = int(token[4:])
        if expected_region in {"conus_watch", "spc_md"} and lon_hundredths < 4000:
            # SPC convective products omit the leading "1" for west
            # longitudes at or beyond 100W (e.g. 0047 => 100.47W).
            lon_hundredths += 10000
        lon = -(lon_hundredths / 100.0)
        coords.append([lon, lat])
    if len(coords) < 3:
        return None
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    geometry = {"type": "Polygon", "coordinates": [coords]}
    if not _geometry_is_valid_for_region(geometry, expected_region):
        return None
    return geometry


def _geometry_is_valid_for_region(geometry: Optional[dict], expected_region: Optional[str]) -> bool:
    if not isinstance(geometry, dict):
        return False
    bbox = _bbox_from_geometry(geometry)
    if bbox is None:
        return False
    min_lon, min_lat, max_lon, max_lat = bbox
    if expected_region in {"conus_watch", "spc_md"}:
        if min_lon < -130.0 or max_lon > -60.0 or min_lat < 20.0 or max_lat > 55.0:
            return False
        # SPC convective watches can legitimately be long north-south or
        # southwest-northeast boxes. Only reject obviously absurd spans.
        if (max_lon - min_lon) > 60.0 or (max_lat - min_lat) > 30.0:
            return False
    return True


def _geometry_from_kml_link(html: str, base_url: str, headers: Dict[str, str], timeout_sec: int) -> Optional[dict]:
    m = re.search(r'href="([^"]+\.kml[^"]*)"', html, re.IGNORECASE)
    if not m:
        return None
    kml_url = urljoin(base_url, m.group(1))
    resp = requests.get(kml_url, timeout=timeout_sec, headers=headers)
    resp.raise_for_status()
    try:
        root = ET.fromstring(resp.text)
    except Exception:
        return None
    for elem in root.iter():
        if elem.tag.lower().endswith("coordinates") and elem.text:
            coords: List[List[float]] = []
            for part in elem.text.strip().split():
                bits = part.split(",")
                if len(bits) < 2:
                    continue
                try:
                    lon = float(bits[0])
                    lat = float(bits[1])
                except Exception:
                    continue
                coords.append([lon, lat])
            if len(coords) >= 3:
                if coords[0] != coords[-1]:
                    coords.append(coords[0])
                return {"type": "Polygon", "coordinates": [coords]}
    return None


def _extract_states_from_ugc(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    out: set[str] = set()
    for value in values:
        token = str(value).strip().upper()
        if len(token) >= 2 and token[:2].isalpha() and token[:2] in ALERT_UGC_PREFIX_TO_STATE:
            out.add(token[:2])
    return sorted(out)


def _extract_states_from_text(text: str) -> List[str]:
    out: set[str] = set()
    upper = (text or "").upper()
    for name, abbr in STATE_NAME_TO_ABBR.items():
        if re.search(rf"\b{re.escape(name)}\b", upper):
            out.add(abbr)
    return sorted(out)


def _extract_warning_coverage_counties(area_desc: str, states: List[str]) -> List[str]:
    text = (area_desc or "").strip()
    if not text:
        return []

    default_state = states[0] if len(states) == 1 else None
    ordered: List[str] = []
    seen: set[str] = set()

    for segment in re.split(r"\s*;\s*", text):
        segment = segment.strip()
        if not segment:
            continue
        parts = [part.strip() for part in segment.split(",") if part.strip()]
        if not parts:
            continue

        state_abbr = _state_token_to_abbr(parts[-1])
        names = parts[:-1] if state_abbr else parts
        if not state_abbr:
            state_abbr = default_state

        for raw_name in names:
            cleaned = _clean_warning_coverage_name(raw_name)
            if not cleaned or _is_marine_warning_coverage(cleaned):
                continue
            label = f"{cleaned}, {state_abbr}" if state_abbr else cleaned
            if label not in seen:
                seen.add(label)
                ordered.append(label)
    return ordered


def _state_token_to_abbr(value: str) -> Optional[str]:
    token = (value or "").strip().upper()
    if not token:
        return None
    if token in STATE_ABBR_TO_NAME:
        return token
    return STATE_NAME_TO_ABBR.get(token)


def _clean_warning_coverage_name(value: str) -> Optional[str]:
    name = re.sub(r"\s+", " ", (value or "").strip())
    if not name:
        return None
    name = re.sub(r"(?i)^the city of\s+", "", name)
    name = re.sub(r"(?i)^city of\s+", "", name)
    name = re.sub(r"(?i)\s+(county|parish|borough|census area)$", "", name)
    return name.strip(" ,.-") or None


def _is_marine_warning_coverage(value: str) -> bool:
    upper = (value or "").upper()
    marine_markers = [
        "COASTAL WATERS",
        "OPEN WATERS",
        "GULF WATERS",
        "BAYS AND WATERWAYS",
        "LAKE ",
        "MARINE",
        "WATERS",
    ]
    return any(marker in upper for marker in marine_markers)


def _bbox_from_geometry(geometry: Optional[dict]) -> Optional[List[float]]:
    if not isinstance(geometry, dict):
        return None
    coords = list(_iter_coords(geometry.get("coordinates")))
    if not coords:
        return None
    lons = [lon for lon, _ in coords]
    lats = [lat for _, lat in coords]
    return [min(lons), min(lats), max(lons), max(lats)]


def _iter_coords(values: Any) -> Iterable[Tuple[float, float]]:
    if isinstance(values, list):
        if len(values) >= 2 and all(isinstance(v, (int, float)) for v in values[:2]):
            yield (float(values[0]), float(values[1]))
            return
        for item in values:
            yield from _iter_coords(item)
