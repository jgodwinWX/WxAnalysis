"""
METAR data fetcher using Iowa State IEM CSV service.
Fetches current METAR observations and parses them into our format.
"""
import requests
import csv
from io import StringIO
from typing import List, Optional
from datetime import datetime, timezone
from pathlib import Path
import logging
import time

logger = logging.getLogger(__name__)

# Iowa State IEM CSV service endpoint (more reliable than JSON API)
IEM_CSV_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
IEM_STATION_METADATA_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/station.py"

# Request headers to avoid being blocked
REQUEST_HEADERS = {
    "User-Agent": "WxAnalysis/1.0 (Weather Analysis Tool)",
    "Accept": "text/csv,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}


def fahrenheit_to_celsius(f: Optional[float]) -> Optional[float]:
    """Convert Fahrenheit to Celsius."""
    if f is None:
        return None
    return (f - 32) * 5 / 9


def parse_station_id(station: str) -> str:
    """Extract station ID from station code (handles 'KOKC' -> 'KOKC' or 'OKC' -> 'KOKC')."""
    if not station:
        return ""
    # If it doesn't start with K and is 3 chars, assume it's a US station and add K
    if len(station) == 3 and not station.startswith("K"):
        return f"K{station}"
    return station.upper()


def calculate_flight_rule(visibility_mi: Optional[float], ceiling_ft: Optional[float]) -> str:
    """
    Calculate flight rule based on visibility and ceiling.
    Returns: "VFR", "MVFR", "IFR", or "LIFR"
    """
    # VFR: visibility >= 5 SM and ceiling >= 3000 ft
    # MVFR: visibility 3-5 SM or ceiling 1000-3000 ft
    # IFR: visibility 1-3 SM or ceiling 500-1000 ft
    # LIFR: visibility < 1 SM or ceiling < 500 ft
    
    if visibility_mi is None and ceiling_ft is None:
        return "UNKNOWN"
    
    # Check visibility
    vis_vfr = visibility_mi is None or visibility_mi > 5.0
    vis_mvfr = visibility_mi is not None and 3.0 <= visibility_mi <= 5.0
    vis_ifr = visibility_mi is not None and 1.0 <= visibility_mi < 3.0
    vis_lifr = visibility_mi is not None and visibility_mi < 1.0
    
    # Check ceiling
    ceil_vfr = ceiling_ft is None or ceiling_ft > 3000
    ceil_mvfr = ceiling_ft is not None and 1000 <= ceiling_ft <= 3000
    ceil_ifr = ceiling_ft is not None and 500 <= ceiling_ft < 1000
    ceil_lifr = ceiling_ft is not None and ceiling_ft < 500
    
    # Determine worst condition
    if vis_lifr or ceil_lifr:
        return "LIFR"
    elif vis_ifr or ceil_ifr:
        return "IFR"
    elif vis_mvfr or ceil_mvfr:
        return "MVFR"
    elif vis_vfr and ceil_vfr:
        return "VFR"
    else:
        # Default to most restrictive
        if visibility_mi is not None and visibility_mi < 3.0:
            return "IFR"
        elif ceiling_ft is not None and ceiling_ft < 1000:
            return "IFR"
        else:
            return "MVFR"


def fetch_station_metadata() -> dict:
    """
    Load station metadata from APT_BASE.csv file.
    Uses ICAO_ID if available, otherwise ARPT_ID (with K prefix if needed).
    Combines CITY and ARPT_NAME for display name.
    Returns dict mapping station ID to descriptive name.
    """
    # Try to load from APT_BASE.csv file
    csv_path = Path(__file__).parent / "data" / "APT_BASE.csv"
    if csv_path.exists():
        try:
            metadata = {}
            with open(csv_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    # Try ICAO_ID first (4-letter code)
                    station_id = row.get("ICAO_ID", "").strip().upper()
                    
                    # If ICAO_ID is empty, use ARPT_ID (3-letter code)
                    if not station_id:
                        arpt_id = row.get("ARPT_ID", "").strip().upper()
                        if arpt_id:
                            # Add K prefix if it's 3 letters and doesn't start with K
                            if len(arpt_id) == 3 and not arpt_id.startswith("K"):
                                station_id = f"K{arpt_id}"
                            else:
                                station_id = arpt_id
                    
                    # Get city and airport name
                    city = row.get("CITY", "").strip()
                    arpt_name = row.get("ARPT_NAME", "").strip()
                    
                    # Combine CITY and ARPT_NAME for display
                    if city and arpt_name:
                        station_name = f"{city}/{arpt_name}"
                    elif city:
                        station_name = city
                    elif arpt_name:
                        station_name = arpt_name
                    else:
                        continue  # Skip if no name available
                    
                    if station_id:
                        metadata[station_id] = station_name
            
            logger.info(f"Loaded metadata for {len(metadata)} stations from APT_BASE.csv")
            return metadata
        except Exception as e:
            logger.warning(f"Error reading APT_BASE.csv: {e}, trying API fallback")
    
    # Fallback to API if local file doesn't exist
    try:
        response = requests.get(
            IEM_STATION_METADATA_URL,
            params={
                "network": "ASOS",
                "format": "csv",
            },
            headers=REQUEST_HEADERS,
            timeout=15
        )
        response.raise_for_status()
        
        metadata = {}
        reader = csv.DictReader(StringIO(response.text))
        for row in reader:
            station_id = row.get("id", "").strip().upper()
            station_name = row.get("name", "").strip()
            if station_id and station_name:
                metadata[station_id] = station_name
        
        logger.info(f"Fetched metadata for {len(metadata)} stations from API")
        return metadata
    except Exception as e:
        logger.warning(f"Could not fetch station metadata from API: {e}")
        return {}


def fetch_current_metars() -> List[dict]:
    """
    Fetch current METAR observations from IEM CSV service and parse them.
    Returns list of observation dicts.
    Implements retry logic with exponential backoff for 503 errors.
    """
    max_retries = 3
    retry_delay = 2  # seconds
    
    for attempt in range(max_retries):
        try:
            # Fetch current observations (last hour) from ASOS network
            response = requests.get(
                IEM_CSV_URL,
                params={
                    "network": "ASOS",
                    "data": "all",
                    "format": "onlycomma",
                    "latlon": "yes",
                    "hours": "1",  # Get observations from last hour
                },
                headers=REQUEST_HEADERS,
                timeout=30
            )
            
            # Handle 503 Service Unavailable with retry
            if response.status_code == 503:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)  # Exponential backoff
                    logger.warning(
                        f"Received 503 error, retrying in {wait_time} seconds "
                        f"(attempt {attempt + 1}/{max_retries})"
                    )
                    time.sleep(wait_time)
                    continue
                else:
                    logger.error("Received 503 error after all retries")
                    response.raise_for_status()
            
            # Raise for other HTTP errors
            response.raise_for_status()
            
            # Fetch station metadata for descriptive names
            station_metadata = fetch_station_metadata()
            
            # Parse CSV response
            csv_content = response.text
            reader = csv.DictReader(StringIO(csv_content))
            
            observations = []
            seen_stations = set()  # Track most recent obs per station
            
            # Process rows - we want the most recent observation per station
            rows = list(reader)
            # Sort by valid time (most recent first) and process
            rows.sort(key=lambda x: x.get("valid", ""), reverse=True)
            
            for row in rows:
                station_code = row.get("station", "").strip()
                if not station_code:
                    continue
                
                station_id = parse_station_id(station_code)
                
                # Skip if we've already processed this station (keep most recent)
                if station_id in seen_stations:
                    continue
                seen_stations.add(station_id)
                
                # Extract observation valid time (IEM "valid" looks like "YYYY-MM-DD HH:MM" UTC)
                obs_time = None
                valid_str = (row.get("valid") or "").strip()
                if valid_str:
                    try:
                        # Try ISO formats too
                        dt = datetime.fromisoformat(valid_str.replace("Z", "+00:00"))
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        obs_time = dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                    except Exception:
                        obs_time = None
                
                # Extract coordinates
                try:
                    lat = float(row.get("lat", 0))
                    lon = float(row.get("lon", 0))
                except (ValueError, TypeError):
                    continue
                
                # Skip if coordinates are invalid
                if lat == 0 and lon == 0:
                    continue
                
                # Extract temperature (in Fahrenheit, convert to Celsius)
                temp_f = None
                try:
                    temp_f_str = row.get("tmpf", "").strip()
                    if temp_f_str and temp_f_str.lower() not in ("", "m", "null"):
                        temp_f = float(temp_f_str)
                except (ValueError, TypeError):
                    pass
                
                temp_c = fahrenheit_to_celsius(temp_f)
                if temp_c is None:
                    continue  # Skip if no temperature
                
                # Extract dewpoint (in Fahrenheit, convert to Celsius)
                dewpoint_f = None
                try:
                    dwpf_str = row.get("dwpf", "").strip()
                    if dwpf_str and dwpf_str.lower() not in ("", "m", "null"):
                        dewpoint_f = float(dwpf_str)
                except (ValueError, TypeError):
                    pass
                
                dewpoint_c = fahrenheit_to_celsius(dewpoint_f)
                
                # Extract wind direction and speed
                wind_dir_deg = None
                try:
                    drct_str = row.get("drct", "").strip()
                    if drct_str and drct_str.lower() not in ("", "m", "null"):
                        wind_dir_deg = float(drct_str)
                except (ValueError, TypeError):
                    pass
                
                wind_speed_kt = None
                try:
                    sknt_str = row.get("sknt", "").strip()
                    if sknt_str and sknt_str.lower() not in ("", "m", "null"):
                        wind_speed_kt = float(sknt_str)
                except (ValueError, TypeError):
                    pass
                
                # Extract wind gust
                wind_gust_kt = None
                try:
                    gust_str = row.get("gust", "").strip()
                    if gust_str and gust_str.lower() not in ("", "m", "null"):
                        wind_gust_kt = float(gust_str)
                except (ValueError, TypeError):
                    pass
                
                # Extract visibility (in miles)
                visibility_mi = None
                try:
                    vsby_str = row.get("vsby", "").strip()
                    if vsby_str and vsby_str.lower() not in ("", "m", "null"):
                        visibility_mi = float(vsby_str)
                except (ValueError, TypeError):
                    pass
                
                # Extract ceiling (lowest broken/overcast layer in feet)
                ceiling_ft = None
                sky_conditions = []
                for i in range(1, 5):
                    skyc = row.get(f"skyc{i}", "").strip().upper()
                    skyl = row.get(f"skyl{i}", "").strip()
                    
                    if skyc and skyc not in ("", "M", "NULL"):
                        try:
                            level_ft = None
                            if skyl and skyl.lower() not in ("", "m", "null"):
                                level_ft = float(skyl)  # Convert to a float in feet
                            
                            sky_conditions.append({
                                "cover": skyc,
                                "level_ft": round(level_ft) if level_ft is not None else None
                            })
                            
                            # Ceiling is lowest BKN or OVC layer
                            if ceiling_ft is None and skyc in ("BKN", "OVC") and level_ft is not None:
                                ceiling_ft = level_ft
                        except (ValueError, TypeError):
                            pass
                
                # Extract altimeter (inches of mercury)
                altimeter_inhg = None
                try:
                    alti_str = row.get("alti", "").strip()
                    if alti_str and alti_str.lower() not in ("", "m", "null"):
                        altimeter_inhg = float(alti_str)
                except (ValueError, TypeError):
                    pass
                
                # Extract pressure (millibars)
                pressure_mb = None
                try:
                    mslp_str = row.get("mslp", "").strip()
                    if mslp_str and mslp_str.lower() not in ("", "m", "null"):
                        pressure_mb = float(mslp_str)
                except (ValueError, TypeError):
                    pass
                
                # Extract relative humidity
                relative_humidity = None
                try:
                    relh_str = row.get("relh", "").strip()
                    if relh_str and relh_str.lower() not in ("", "m", "null"):
                        relative_humidity = float(relh_str)
                except (ValueError, TypeError):
                    pass
                
                # Extract weather codes
                weather_codes = row.get("wxcodes", "").strip()
                
                # Extract raw METAR string
                raw_metar = row.get("metar", "").strip()
                
                # Calculate flight rule
                flight_rule = calculate_flight_rule(visibility_mi, ceiling_ft)
                
                # Get station name from metadata, fallback to station ID
                station_name = station_metadata.get(station_id, station_id)
                
                observations.append({
                    "id": station_id,
                    "name": station_name,
                    "obsTimeUtc": obs_time,
                    "lat": round(lat, 4),
                    "lon": round(lon, 4),
                    "tempC": round(temp_c, 1),
                    "dewpointC": round(dewpoint_c, 1) if dewpoint_c is not None else None,
                    "windDirDeg": round(wind_dir_deg, 0) if wind_dir_deg is not None else None,
                    "windSpeedKt": round(wind_speed_kt, 1) if wind_speed_kt is not None else None,
                    "windGustKt": round(wind_gust_kt, 1) if wind_gust_kt is not None else None,
                    "visibilityMi": round(visibility_mi, 2) if visibility_mi is not None else None,
                    "ceilingFt": round(ceiling_ft) if ceiling_ft is not None else None,
                    "skyConditions": sky_conditions,
                    "altimeterInhg": round(altimeter_inhg, 2) if altimeter_inhg is not None else None,
                    "pressureMb": round(pressure_mb, 1) if pressure_mb is not None else None,
                    "relativeHumidity": round(relative_humidity, 1) if relative_humidity is not None else None,
                    "weatherCodes": weather_codes if weather_codes else None,
                    "flightRule": flight_rule,
                    "rawMetar": raw_metar if raw_metar else None,
                })
            
            logger.info(f"Successfully fetched and parsed {len(observations)} METAR observations")
            return observations
            
        except requests.exceptions.RequestException as e:
            if attempt < max_retries - 1:
                wait_time = retry_delay * (2 ** attempt)
                logger.warning(
                    f"Request error: {e}, retrying in {wait_time} seconds "
                    f"(attempt {attempt + 1}/{max_retries})"
                )
                time.sleep(wait_time)
                continue
            else:
                logger.error(f"Error fetching METARs after {max_retries} attempts: {e}")
                return []
        except Exception as e:
            logger.error(f"Unexpected error fetching METARs: {e}")
            return []
    
    # If we get here, all retries failed
    logger.error(f"Failed to fetch METARs after {max_retries} attempts")
    return []

