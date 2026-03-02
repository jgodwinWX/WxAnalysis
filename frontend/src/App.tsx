import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import MapGL, { Marker, NavigationControl, ViewState, Source, Layer, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";

type SkyCondition = {
  cover: string;
  level_ft: number | null;
};

type SurfaceObs = {
  id: string;
  name: string;
  obsTimeUtc: string | null;
  lat: number;
  lon: number;
  tempC: number;
  dewpointC: number | null;
  windDirDeg: number | null;
  windSpeedKt: number | null;
  windGustKt: number | null;
  visibilityMi: number | null;
  ceilingFt: number | null;
  skyConditions: SkyCondition[];
  altimeterInhg: number | null;
  pressureMb: number | null;
  pressureIsEstimated?: boolean;
  relativeHumidity: number | null;
  weatherCodes: string | null;
  flightRule: string;
  rawMetar: string | null;
  qcFlags?: string[];
  analysisExcludeFields?: string[];
};

type TempUnit = "F" | "C";
type WindUnit = "KT" | "MPH" | "KPH";
type DisplayTimeZone = "UTC" | "LOCAL";
type MrmsField = "none" | "rala" | "composite" | "etop18" | "rotation240";
type NwsProduct = "none" | "wpcSurface";
type FrontRenderStyle = "simple" | "classic";

type MrmsMetaResponse = {
  product: "rala" | "composite" | "etop18" | "rotation240";
  requested_time: string | null;
  matched_time: string;
  latest_time: string;
  age_minutes: number;
  stale_warning: boolean;
  available_times: string[];
  image_url: string;
  tile_url_template?: string;
  corners?: [[number, number], [number, number], [number, number], [number, number]];
  bbox: {
    min_lon: number;
    min_lat: number;
    max_lon: number;
    max_lat: number;
  };
};

type MrmsValueResponse = {
  product: "rala" | "composite" | "etop18" | "rotation240";
  requested_time: string | null;
  matched_time: string;
  latest_time: string;
  age_minutes: number;
  stale_warning: boolean;
  lat: number;
  lon: number;
  unit?: string;
  value?: number | null;
  value_dbz: number | null;
};

type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: any[];
};

type WpcSurfaceResponse = {
  product: "wpc_surface";
  source_url: string;
  fetched_at: string;
  valid_time: string | null;
  age_minutes: number | null;
  stale_warning: boolean;
  fronts: GeoJsonFeatureCollection;
  centers: GeoJsonFeatureCollection;
  counts: {
    fronts: number;
    centers: number;
  };
  front_types_present?: string[];
};

type OpsSourceStats = {
  success: number;
  failure: number;
  last_success: string | null;
  last_failure: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
};

type OpsSummaryResponse = {
  generated_at: string;
  health: {
    status: "ok" | "degraded" | "error";
    generated_at: string;
    uptime_seconds: number;
    started_at: string;
    last_update: string | null;
    station_count: number;
    storage_total_bytes: number;
    metar_latest_age_minutes: number | null;
  };
  freshness: {
    generated_at: string;
    metar: {
      latest_update: string | null;
      latest_age_minutes: number | null;
      latest_station_count: number;
      latest_snapshot_time: string | null;
      latest_snapshot_station_count: number;
      snapshot_count: number;
    };
    mrms: {
      rala: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        available_count: number;
        last_error?: string | null;
      };
      composite: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        available_count: number;
        last_error?: string | null;
      };
      etop18: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        available_count: number;
        last_error?: string | null;
      };
      rotation240: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        available_count: number;
        last_error?: string | null;
      };
    };
    wpc: {
      status: string;
      valid_time?: string | null;
      valid_age_minutes?: number | null;
      stale_warning?: boolean;
      expected_cycle_valid_time?: string | null;
      expected_issue_time?: string | null;
      overdue_threshold_time?: string | null;
      overdue_by_minutes?: number | null;
      front_count?: number;
      center_count?: number;
      error?: string;
    };
  };
  storage: {
    generated_at: string;
    components: Record<string, { bytes: number; files: number; oldest_mtime: string | null; newest_mtime: string | null; exists: boolean }>;
  };
  errors: {
    generated_at: string;
    sources: Record<string, OpsSourceStats>;
  };
  config: Record<string, number>;
};

const WIND_FILL_BINS_KT = [0, 5, 10, 15, 20, 30, 40, 60, Number.POSITIVE_INFINITY];
const WIND_FILL_COLORS = [
  "#dbeafe",
  "#93c5fd",
  "#60a5fa",
  "#34d399",
  "#facc15",
  "#fb923c",
  "#ef4444",
  "#a855f7",
];

const CEILING_LEVELS_HUNDREDS_FT = [0, 2, 5, 10, 30, 50];
const CEILING_FILL_COLORS = [
  "#f472b6", // LIFR
  "#f87171", // IFR
  "#ef4444", // IFR deeper
  "#60a5fa", // MVFR
  "#4ade80", // VFR
];

const VISIBILITY_LEVELS_SM = [0, 0.25, 0.5, 1, 3, 5, 6];
const VISIBILITY_FILL_COLORS = [
  "#f472b6", // LIFR
  "#ec4899", // LIFR deeper
  "#f87171", // IFR edge
  "#ef4444", // IFR
  "#60a5fa", // MVFR
  "#4ade80", // VFR
];

const RH_DRY_LEVELS = [0, 10, 20, 25];
const RH_DRY_COLORS = ["#dc2626", "#fb923c", "#facc15"];
const RH_MOIST_LEVELS = [90, 95, 100];
const RH_MOIST_COLORS = ["#86efac", "#166534"];
const MOISTURE_CONV_LEVELS_X1E7 = [0, 1, 2, 4, 6, 8, 10, 14, 20, Number.POSITIVE_INFINITY];
const RALA_LEGEND_ITEMS = [
  { color: "#191919", label: ">=75 dBZ" },
  { color: "#ffffff", label: "65-75 dBZ" },
  { color: "#ffc8ff", label: "50-65 dBZ" },
  { color: "#ff0000", label: "40-50 dBZ" },
  { color: "#ffff6e", label: "20-40 dBZ" },
  { color: "#6eff6e", label: "0-20 dBZ" },
  { color: "#004b82", label: "-35-0 dBZ" },
  { color: "#ffffff", label: "<-35 dBZ" },
];
const ETOP18_LEGEND_ITEMS = [
  { color: "#ffffff", label: ">=70 kft" },
  { color: "#ff00ff", label: "65-70 kft" },
  { color: "#d2b4c8", label: "60-65 kft" },
  { color: "#dc0000", label: "50-60 kft" },
  { color: "#b4b400", label: "40-50 kft" },
  { color: "#1edc1e", label: "30-40 kft" },
  { color: "#4614c8", label: "20-30 kft" },
  { color: "#4678e6", label: "15-20 kft" },
  { color: "#46bed2", label: "10-15 kft" },
  { color: "#46d2d2", label: "6-10 kft" },
  { color: "#8cb4b4", label: "2-6 kft" },
  { color: "#bebebe", label: "0-2 kft" },
];
const ROT240_LEGEND_ITEMS = [
  { color: "#5ae6e6", label: ">=0.020 1/s" },
  { color: "#ffffff", label: "0.015-0.020 1/s" },
  { color: "#ff0000", label: "0.014-0.015 1/s" },
  { color: "#be0000", label: "0.013-0.014 1/s" },
  { color: "#aa0000", label: "0.012-0.013 1/s" },
  { color: "#960000", label: "0.011-0.012 1/s" },
  { color: "#820000", label: "0.010-0.011 1/s" },
  { color: "#ffff00", label: "0.009-0.010 1/s" },
  { color: "#d2d200", label: "0.008-0.009 1/s" },
  { color: "#aaaa00", label: "0.007-0.008 1/s" },
  { color: "#828200", label: "0.006-0.007 1/s" },
  { color: "#64645f", label: "0.005-0.006 1/s" },
  { color: "#969696", label: "0.004-0.005 1/s" },
  { color: "#b4bebe", label: "0.003-0.004 1/s" },
  { color: "#d2dcdc", label: "0.000-0.003 1/s" },
];
const REFL_GRADIENT_BREAKS = [
  { value: -35, color: "#ffffff" },
  { value: 0, color: "#1e1e1e" },
  { value: 0, color: "#004b82" },
  { value: 20, color: "#8282fa" },
  { value: 20, color: "#6eff6e" },
  { value: 40, color: "#003c00" },
  { value: 40, color: "#ffff6e" },
  { value: 50, color: "#ff6e00" },
  { value: 50, color: "#ff0000" },
  { value: 65, color: "#5a0000" },
  { value: 65, color: "#ffc8ff" },
  { value: 75, color: "#5a005a" },
  { value: 75, color: "#ffffff" },
  { value: 85, color: "#191919" },
];

function getMrmsProductLabel(product: MrmsField): string {
  if (product === "rala") return "RALA";
  if (product === "composite") return "Composite Reflectivity";
  if (product === "etop18") return "18 dBZ Echo Tops";
  if (product === "rotation240") return "4-hour Rotation Tracks";
  return "MRMS";
}

function getMrmsProductUnit(product: MrmsField): string {
  if (product === "etop18") return "kft";
  if (product === "rotation240") return "1/s";
  return "dBZ";
}

function makeReflectivityGradientCss() {
  const min = -35;
  const max = 85;
  const span = max - min;
  const stops = REFL_GRADIENT_BREAKS.map((s) => {
    const pct = ((s.value - min) / span) * 100;
    return `${s.color} ${pct}%`;
  });
  return `linear-gradient(to top, ${stops.join(", ")})`;
}
const WPC_LEGEND_ITEMS = [
  { color: "#2563eb", label: "Cold Front" },
  { color: "#dc2626", label: "Warm Front" },
  { color: "#7c3aed", label: "Occluded Front" },
  { color: "#a855f7", label: "Stationary Front" },
  { color: "#b45309", label: "Dryline" },
  { color: "#92400e", label: "Trough" },
  { color: "#2563eb", label: "H (Pressure Center)" },
  { color: "#dc2626", label: "L (Pressure Center)" },
];

const ADM0_BOUNDARIES_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_boundary_lines_land.geojson";
const ADM1_BOUNDARIES_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces_lines.geojson";
const ADM2_BOUNDARIES_URL =
  "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";
const ARTCC_BOUNDARIES_URL = "/api/geography/artcc";
const HISTORY_WINDOW_MINUTES = 360;
const CHANGE_WINDOW_HOURS = 24;

const DELTA_SLP_NEG_CUTS = [-16, -12, -8, -4];
const DELTA_SLP_POS_CUTS = [4, 8, 12, 16];
const DELTA_SLP_NEG_COLORS = ["#4c1d95", "#6d28d9", "#7c3aed", "#8b5cf6"]; // falls -> purple
const DELTA_SLP_POS_COLORS = ["#fdb863", "#f59e0b", "#d97706", "#92400e"]; // rises -> orange

const DELTA_TEMP_CUTS_F = { neg: [-20, -12, -8, -4], pos: [4, 8, 12, 20] };
const DELTA_TEMP_CUTS_C = { neg: [-10, -6, -4, -2], pos: [2, 4, 6, 10] };
const DELTA_TEMP_NEG_COLORS = ["#08306b", "#08519c", "#2171b5", "#6baed6"]; // cooling -> blue
const DELTA_TEMP_POS_COLORS = ["#fcae91", "#fb6a4a", "#de2d26", "#a50f15"]; // warming -> red

const DELTA_DEWPOINT_NEG_COLORS = ["#92400e", "#b45309", "#ea580c", "#fb923c"]; // drying -> warm
const DELTA_DEWPOINT_POS_COLORS = ["#93c5fd", "#60a5fa", "#3b82f6", "#1d4ed8"]; // moistening -> cool

const DELTA_THETAE_NEG_CUTS = [-10, -6, -4, -2];
const DELTA_THETAE_POS_CUTS = [2, 4, 6, 10];
const DELTA_THETAE_NEG_COLORS = ["#543005", "#8c510a", "#bf812d", "#dfc27d"];
const DELTA_THETAE_POS_COLORS = ["#c7eae5", "#80cdc1", "#35978f", "#01665e"];

type PresetView = {
  id: string;
  label: string;
  lon: number;
  lat: number;
  zoom: number;
};

const REGION_VIEWS: PresetView[] = [
  { id: "region-conus", label: "CONUS", lon: -98.5, lat: 39.8, zoom: 4.2 },
  { id: "region-midwest", label: "Midwest", lon: -93.5, lat: 41.5, zoom: 5.5 },
  { id: "region-northeast", label: "Northeast", lon: -74.5, lat: 42.5, zoom: 5.7 },
  { id: "region-northwest", label: "Northwest", lon: -120.5, lat: 46.5, zoom: 5.4 },
  { id: "region-south-central", label: "South-Central", lon: -97.0, lat: 32.5, zoom: 5.5 },
  { id: "region-southeast", label: "Southeast", lon: -83.5, lat: 33.0, zoom: 5.6 },
  { id: "region-southwest", label: "Southwest", lon: -112.0, lat: 34.0, zoom: 5.4 },
];

const STATE_TERRITORY_VIEWS: PresetView[] = [
  { id: "state-AK", label: "AK", lon: -152.4, lat: 64.5, zoom: 3.7 },
  { id: "state-AL", label: "AL", lon: -86.8, lat: 32.8, zoom: 6.6 },
  { id: "state-AR", label: "AR", lon: -92.3, lat: 34.9, zoom: 6.6 },
  { id: "state-AS", label: "AS", lon: -170.7, lat: -14.3, zoom: 8.3 },
  { id: "state-AZ", label: "AZ", lon: -111.7, lat: 34.2, zoom: 6.2 },
  { id: "state-CA", label: "CA", lon: -119.5, lat: 37.2, zoom: 5.5 },
  { id: "state-CO", label: "CO", lon: -105.5, lat: 39.0, zoom: 6.2 },
  { id: "state-CT", label: "CT", lon: -72.7, lat: 41.6, zoom: 7.8 },
  { id: "state-DC", label: "DC", lon: -77.03, lat: 38.9, zoom: 9.2 },
  { id: "state-DE", label: "DE", lon: -75.5, lat: 39.0, zoom: 8.1 },
  { id: "state-FL", label: "FL", lon: -82.4, lat: 28.6, zoom: 6.0 },
  { id: "state-GA", label: "GA", lon: -83.5, lat: 32.6, zoom: 6.4 },
  { id: "state-GU", label: "GU", lon: 144.8, lat: 13.45, zoom: 9.0 },
  { id: "state-HI", label: "HI", lon: -157.9, lat: 20.8, zoom: 6.2 },
  { id: "state-IA", label: "IA", lon: -93.5, lat: 42.1, zoom: 6.6 },
  { id: "state-ID", label: "ID", lon: -114.4, lat: 44.2, zoom: 6.1 },
  { id: "state-IL", label: "IL", lon: -89.3, lat: 40.0, zoom: 6.4 },
  { id: "state-IN", label: "IN", lon: -86.2, lat: 39.9, zoom: 6.7 },
  { id: "state-KS", label: "KS", lon: -98.2, lat: 38.5, zoom: 6.3 },
  { id: "state-KY", label: "KY", lon: -84.9, lat: 37.8, zoom: 6.7 },
  { id: "state-LA", label: "LA", lon: -91.8, lat: 30.9, zoom: 6.7 },
  { id: "state-MA", label: "MA", lon: -71.8, lat: 42.2, zoom: 7.2 },
  { id: "state-MD", label: "MD", lon: -76.7, lat: 39.0, zoom: 7.3 },
  { id: "state-ME", label: "ME", lon: -69.1, lat: 45.3, zoom: 6.4 },
  { id: "state-MI", label: "MI", lon: -85.5, lat: 44.3, zoom: 5.8 },
  { id: "state-MN", label: "MN", lon: -94.6, lat: 46.2, zoom: 5.9 },
  { id: "state-MO", label: "MO", lon: -92.5, lat: 38.4, zoom: 6.4 },
  { id: "state-MP", label: "MP", lon: 145.7, lat: 15.2, zoom: 8.7 },
  { id: "state-MS", label: "MS", lon: -89.8, lat: 32.8, zoom: 6.7 },
  { id: "state-MT", label: "MT", lon: -110.3, lat: 46.9, zoom: 5.7 },
  { id: "state-NC", label: "NC", lon: -79.4, lat: 35.4, zoom: 6.3 },
  { id: "state-ND", label: "ND", lon: -100.5, lat: 47.5, zoom: 6.0 },
  { id: "state-NE", label: "NE", lon: -99.8, lat: 41.5, zoom: 6.3 },
  { id: "state-NH", label: "NH", lon: -71.5, lat: 43.9, zoom: 7.2 },
  { id: "state-NJ", label: "NJ", lon: -74.5, lat: 40.1, zoom: 7.7 },
  { id: "state-NM", label: "NM", lon: -106.1, lat: 34.4, zoom: 6.2 },
  { id: "state-NV", label: "NV", lon: -117.0, lat: 39.3, zoom: 5.9 },
  { id: "state-NY", label: "NY", lon: -75.2, lat: 42.9, zoom: 6.1 },
  { id: "state-OH", label: "OH", lon: -82.8, lat: 40.3, zoom: 6.5 },
  { id: "state-OK", label: "OK", lon: -97.5, lat: 35.6, zoom: 6.4 },
  { id: "state-OR", label: "OR", lon: -120.6, lat: 43.9, zoom: 6.0 },
  { id: "state-PA", label: "PA", lon: -77.8, lat: 40.9, zoom: 6.4 },
  { id: "state-PR", label: "PR", lon: -66.4, lat: 18.2, zoom: 8.1 },
  { id: "state-RI", label: "RI", lon: -71.5, lat: 41.7, zoom: 8.8 },
  { id: "state-SC", label: "SC", lon: -80.8, lat: 33.8, zoom: 7.0 },
  { id: "state-SD", label: "SD", lon: -100.3, lat: 44.3, zoom: 6.0 },
  { id: "state-TN", label: "TN", lon: -86.3, lat: 35.8, zoom: 6.7 },
  { id: "state-TX", label: "TX", lon: -99.4, lat: 31.1, zoom: 5.5 },
  { id: "state-UT", label: "UT", lon: -111.6, lat: 39.4, zoom: 6.2 },
  { id: "state-VA", label: "VA", lon: -78.7, lat: 37.6, zoom: 6.4 },
  { id: "state-VI", label: "VI", lon: -64.75, lat: 18.33, zoom: 9.0 },
  { id: "state-VT", label: "VT", lon: -72.7, lat: 44.0, zoom: 7.3 },
  { id: "state-WA", label: "WA", lon: -120.6, lat: 47.4, zoom: 6.0 },
  { id: "state-WI", label: "WI", lon: -89.8, lat: 44.6, zoom: 6.3 },
  { id: "state-WV", label: "WV", lon: -80.6, lat: 38.6, zoom: 7.0 },
  { id: "state-WY", label: "WY", lon: -107.5, lat: 43.0, zoom: 6.0 },
];

const ARTCC_VIEWS: PresetView[] = [
  { id: "artcc-ZAB", label: "ZAB", lon: -106.1, lat: 34.3, zoom: 6.0 },
  { id: "artcc-ZAN", label: "ZAN", lon: -150.0, lat: 63.0, zoom: 3.9 },
  { id: "artcc-ZAU", label: "ZAU", lon: -88.0, lat: 41.7, zoom: 6.2 },
  { id: "artcc-ZBW", label: "ZBW", lon: -71.0, lat: 43.0, zoom: 6.2 },
  { id: "artcc-ZDC", label: "ZDC", lon: -77.0, lat: 38.5, zoom: 6.4 },
  { id: "artcc-ZDV", label: "ZDV", lon: -104.7, lat: 39.5, zoom: 6.0 },
  { id: "artcc-ZFW", label: "ZFW", lon: -97.0, lat: 32.8, zoom: 6.0 },
  { id: "artcc-ZHU", label: "ZHU", lon: -95.3, lat: 29.8, zoom: 6.2 },
  { id: "artcc-ZID", label: "ZID", lon: -86.2, lat: 39.8, zoom: 6.3 },
  { id: "artcc-ZJX", label: "ZJX", lon: -82.2, lat: 30.4, zoom: 6.5 },
  { id: "artcc-ZKC", label: "ZKC", lon: -95.6, lat: 39.1, zoom: 6.3 },
  { id: "artcc-ZLA", label: "ZLA", lon: -118.2, lat: 34.1, zoom: 6.0 },
  { id: "artcc-ZLC", label: "ZLC", lon: -111.9, lat: 40.8, zoom: 6.1 },
  { id: "artcc-ZMA", label: "ZMA", lon: -80.3, lat: 25.8, zoom: 6.8 },
  { id: "artcc-ZME", label: "ZME", lon: -90.1, lat: 35.1, zoom: 6.3 },
  { id: "artcc-ZMP", label: "ZMP", lon: -93.2, lat: 45.0, zoom: 6.1 },
  { id: "artcc-ZNY", label: "ZNY", lon: -74.8, lat: 41.0, zoom: 6.7 },
  { id: "artcc-ZOA", label: "ZOA", lon: -121.5, lat: 37.6, zoom: 6.0 },
  { id: "artcc-ZOB", label: "ZOB", lon: -81.7, lat: 41.4, zoom: 6.4 },
  { id: "artcc-ZSE", label: "ZSE", lon: -122.3, lat: 47.6, zoom: 6.0 },
  { id: "artcc-ZTL", label: "ZTL", lon: -84.4, lat: 33.8, zoom: 6.5 },
];

function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
}

function knotsToWindUnit(kt: number, unit: WindUnit): number {
  if (unit === "MPH") return kt * 1.15078;
  if (unit === "KPH") return kt * 1.852;
  return kt;
}

function getWindFillThresholds(unit: WindUnit): number[] {
  if (unit === "MPH") return [0, 6, 12, 17, 23, 35, 46, 70, Number.POSITIVE_INFINITY];
  if (unit === "KPH") return [0, 9, 19, 28, 37, 56, 74, 111, Number.POSITIVE_INFINITY];
  return [0, 5, 10, 15, 20, 30, 40, 60, Number.POSITIVE_INFINITY];
}

function mixingRatioGkgFromDewpointPressure(dewpointC: number, pressureMb: number): number | null {
  // Magnus form for vapor pressure over water (hPa/mb).
  const e = 6.112 * Math.exp((17.67 * dewpointC) / (dewpointC + 243.5));
  if (!Number.isFinite(e) || pressureMb <= e) return null;
  // w (g/kg) = 621.97 * e / (p - e)
  const w = (621.97 * e) / (pressureMb - e);
  return Number.isFinite(w) ? w : null;
}

function equivalentPotentialTemperatureK(
  tempC: number,
  dewpointC: number,
  pressureMb: number
): number | null {
  const tK = tempC + 273.15;
  const tdK = dewpointC + 273.15;
  if (!Number.isFinite(tK) || !Number.isFinite(tdK) || !Number.isFinite(pressureMb) || pressureMb <= 0) {
    return null;
  }

  const wGkg = mixingRatioGkgFromDewpointPressure(dewpointC, pressureMb);
  if (wGkg == null) return null;
  const r = wGkg / 1000; // kg/kg
  if (!Number.isFinite(r) || r <= 0) return null;

  const tlcl = 1 / (1 / (tdK - 56) + Math.log(tK / tdK) / 800) + 56;
  if (!Number.isFinite(tlcl) || tlcl <= 0) return null;

  // Bolton (1980)-style theta-e approximation.
  const thetaE =
    tK
    * Math.pow(1000 / pressureMb, 0.2854 * (1 - 0.28 * r))
    * Math.exp(((3376 / tlcl) - 2.54) * r * (1 + 0.81 * r));

  return Number.isFinite(thetaE) ? thetaE : null;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

type ScalarGrid = {
  values: Float32Array;
  nx: number;
  ny: number;
  step: number;
};

type VectorGrid = {
  u: Float32Array;
  v: Float32Array;
  nx: number;
  ny: number;
  step: number;
};

type AnalysisGridStore = {
  temp?: ScalarGrid;
  dewpoint?: ScalarGrid;
  slp?: ScalarGrid;
  windSpeed?: ScalarGrid;
  ceiling?: ScalarGrid;
  visibility?: ScalarGrid;
  relativeHumidity?: ScalarGrid;
  mixingRatio?: ScalarGrid;
  thetaE?: ScalarGrid;
  moistureConvergence?: ScalarGrid;
  deltaSlp24h?: ScalarGrid;
  deltaTemp24h?: ScalarGrid;
  deltaDewpoint24h?: ScalarGrid;
  deltaThetaE24h?: ScalarGrid;
  windVector?: VectorGrid;
};

function sampleScalarGrid(grid: ScalarGrid | undefined, xPx: number, yPx: number): number | null {
  if (!grid) return null;
  const gx = xPx / grid.step;
  const gy = yPx / grid.step;
  const i0 = Math.floor(gx);
  const j0 = Math.floor(gy);
  const i1 = i0 + 1;
  const j1 = j0 + 1;
  if (i0 < 0 || j0 < 0 || i1 >= grid.nx || j1 >= grid.ny) return null;

  const idx00 = j0 * grid.nx + i0;
  const idx10 = j0 * grid.nx + i1;
  const idx01 = j1 * grid.nx + i0;
  const idx11 = j1 * grid.nx + i1;
  const v00 = grid.values[idx00];
  const v10 = grid.values[idx10];
  const v01 = grid.values[idx01];
  const v11 = grid.values[idx11];
  if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) {
    return null;
  }

  const tx = gx - i0;
  const ty = gy - j0;
  const a = v00 * (1 - tx) + v10 * tx;
  const b = v01 * (1 - tx) + v11 * tx;
  return a * (1 - ty) + b * ty;
}

function sampleVectorGrid(grid: VectorGrid | undefined, xPx: number, yPx: number): { u: number; v: number } | null {
  if (!grid) return null;
  const gx = xPx / grid.step;
  const gy = yPx / grid.step;
  const i0 = Math.floor(gx);
  const j0 = Math.floor(gy);
  const i1 = i0 + 1;
  const j1 = j0 + 1;
  if (i0 < 0 || j0 < 0 || i1 >= grid.nx || j1 >= grid.ny) return null;

  const idx00 = j0 * grid.nx + i0;
  const idx10 = j0 * grid.nx + i1;
  const idx01 = j1 * grid.nx + i0;
  const idx11 = j1 * grid.nx + i1;

  const u00 = grid.u[idx00], u10 = grid.u[idx10], u01 = grid.u[idx01], u11 = grid.u[idx11];
  const v00 = grid.v[idx00], v10 = grid.v[idx10], v01 = grid.v[idx01], v11 = grid.v[idx11];
  if (
    !Number.isFinite(u00) || !Number.isFinite(u10) || !Number.isFinite(u01) || !Number.isFinite(u11)
    || !Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)
  ) {
    return null;
  }

  const tx = gx - i0;
  const ty = gy - j0;
  const ua = u00 * (1 - tx) + u10 * tx;
  const ub = u01 * (1 - tx) + u11 * tx;
  const va = v00 * (1 - tx) + v10 * tx;
  const vb = v01 * (1 - tx) + v11 * tx;
  return { u: ua * (1 - ty) + ub * ty, v: va * (1 - ty) + vb * ty };
}

function gaussianBlurNaN(values: Float32Array, nx: number, ny: number, passes = 1): Float32Array {
  let src = values.slice();
  const kernel = [1, 4, 6, 4, 1];
  const radius = 2;

  for (let pass = 0; pass < passes; pass++) {
    const tmp = new Float32Array(nx * ny);
    tmp.fill(Number.NaN);

    // Horizontal pass
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let wSum = 0;
        let vSum = 0;
        for (let k = -radius; k <= radius; k++) {
          const ii = i + k;
          if (ii < 0 || ii >= nx) continue;
          const idx = j * nx + ii;
          const v = src[idx];
          if (!Number.isFinite(v)) continue;
          const w = kernel[k + radius];
          wSum += w;
          vSum += w * v;
        }
        if (wSum > 0) tmp[j * nx + i] = vSum / wSum;
      }
    }

    const dst = new Float32Array(nx * ny);
    dst.fill(Number.NaN);

    // Vertical pass
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let wSum = 0;
        let vSum = 0;
        for (let k = -radius; k <= radius; k++) {
          const jj = j + k;
          if (jj < 0 || jj >= ny) continue;
          const idx = jj * nx + i;
          const v = tmp[idx];
          if (!Number.isFinite(v)) continue;
          const w = kernel[k + radius];
          wSum += w;
          vSum += w * v;
        }
        if (wSum > 0) dst[j * nx + i] = vSum / wSum;
      }
    }

    src = dst;
  }

  return src;
}

function divergingColorForDelta(
  value: number,
  negCuts: number[],
  posCuts: number[],
  negColors: string[],
  posColors: string[]
): string | null {
  if (!Number.isFinite(value)) return null;
  if (value < 0) {
    for (let i = 0; i < negCuts.length; i++) {
      if (value <= negCuts[i]) return negColors[i];
    }
    return null;
  }
  if (value > 0) {
    for (let i = posCuts.length - 1, c = posColors.length - 1; i >= 0; i--, c--) {
      if (value >= posCuts[i]) return posColors[Math.max(0, c)];
    }
    return null;
  }
  return null;
}

function makeDivergingLegend(
  negCuts: number[],
  posCuts: number[],
  negColors: string[],
  posColors: string[],
  unitLabel: string
): Array<{ color: string; label: string }> {
  return [
    // Positive bins first (top of legend), strongest at top.
    { color: posColors[3], label: `> +${posCuts[3]} ${unitLabel}` },
    { color: posColors[2], label: `+${posCuts[2]}..+${posCuts[3]} ${unitLabel}` },
    { color: posColors[1], label: `+${posCuts[1]}..+${posCuts[2]} ${unitLabel}` },
    { color: posColors[0], label: `+${posCuts[0]}..+${posCuts[1]} ${unitLabel}` },
    // Negative bins last (bottom of legend), strongest at bottom.
    { color: negColors[3], label: `${negCuts[2]}..${negCuts[3]} ${unitLabel}` },
    { color: negColors[2], label: `${negCuts[1]}..${negCuts[2]} ${unitLabel}` },
    { color: negColors[1], label: `${negCuts[0]}..${negCuts[1]} ${unitLabel}` },
    { color: negColors[0], label: `< ${negCuts[0]} ${unitLabel}` },
  ];
}

// Thin the stations by a pixel grid to reduce the number of points on the map
function thinByPixelGrid(
  stations: SurfaceObs[],
  map: maplibregl.Map,
  cellSizePx: number
): SurfaceObs[] {
  const seen = new Set<string>();
  const out: SurfaceObs[] = [];

  for (const s of stations) {
    const p = map.project([s.lon, s.lat]); // -> {x,y} pixels
    const key = `${Math.floor(p.x / cellSizePx)}:${Math.floor(p.y / cellSizePx)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function getMapOrNull(mapRef: React.RefObject<MapRef | null>): maplibregl.Map | null {
  return mapRef.current?.getMap?.() ?? null;
}

// Compute the number of minutes ago that an observation was made
function minutesAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((Date.now() - t) / 60000);
}

function ageMinutes(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function formatAge(iso: string | null): string {
  const m = ageMinutes(iso);
  if (m === null) return "";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m ago`;
}

// Determine the CSS class for the observation age
function obsAgeClass(iso: string | null): string {
  const m = ageMinutes(iso);
  if (m === null) return "";
  if (m < 60) return "obs-age-fresh";      // < 60 min
  if (m <= 120) return "obs-age-amber";    // 60–120 min
  return "obs-age-old";                    // > 120 min
}

// Format a UTC ISO string as "HH:MMZ"
function formatZulu(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 16) + "Z";
}

function formatLocalDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatValidTimeLabel(iso: string | null, zone: DisplayTimeZone): string {
  if (!iso) return "---- UTC --- -- --- ----";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "---- UTC --- -- --- ----";

  if (zone === "UTC") {
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const dow = d.toLocaleString("en-US", { weekday: "short", timeZone: "UTC" });
    const day = String(d.getUTCDate()).padStart(2, "0");
    const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const year = String(d.getUTCFullYear());
    return `${hh}${mm} UTC ${dow} ${day} ${mon} ${year}`;
  }

  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const dow = d.toLocaleString("en-US", { weekday: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  const mon = d.toLocaleString("en-US", { month: "short" });
  const year = String(d.getFullYear());

  const tzPart = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  const tz = tzPart && tzPart.trim() ? tzPart.trim() : "LOCAL";

  return `${hh}${mm} ${tz} ${dow} ${day} ${mon} ${year}`;
}

// Format the sky conditions as "CLR///" or "SCT015"
function formatSky(sky: SkyCondition[]) {
  return sky
    .map(l => `${l.cover}${l.level_ft !== null ? String(Math.round(l.level_ft / 100)).padStart(3,"0") : "///"}`)
    .join(" ");
}

function hasQcFlags(station: SurfaceObs): boolean {
  return Array.isArray(station.qcFlags) && station.qcFlags.length > 0;
}

function isExcludedFromAnalysis(
  station: SurfaceObs,
  field: "temp" | "dewpoint" | "slp" | "wind" | "ceiling" | "visibility" | "humidity" | "relativeHumidity"
): boolean {
  return Array.isArray(station.analysisExcludeFields) && station.analysisExcludeFields.includes(field);
}

function drawWindBarb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  attachRadius: number,
  dirDeg: number | null,
  spdKt: number | null
) {

  if (dirDeg == null || spdKt == null) return;
  const spd = Math.max(0, spdKt);

  // Calm wind: small circle
  if (spd < 2) {
    const prev = ctx.lineWidth;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = prev;
    return;
  }

  // Staff points TOWARD the direction wind is coming FROM
  const theta = ((dirDeg - 90) * Math.PI) / 180;
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);

  const staffLen = 30;
  // Start at the edge of the station circle so the barb is "attached"
  const x0 = x + attachRadius * dx;
  const y0 = y + attachRadius * dy;

  // Staff end point
  const x2 = x0 + staffLen * dx;
  const y2 = y0 + staffLen * dy;

  // Draw staff
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Barb geometry: draw barbs on the "right" side of the staff
  const px = Math.cos(theta + Math.PI / 2);
  const py = Math.sin(theta + Math.PI / 2);

  // Round to nearest 5 kt for standard barbs
  let v = Math.round(spd / 5) * 5;

  const n50 = Math.floor(v / 50);
  v -= n50 * 50;
  const n10 = Math.floor(v / 10);
  v -= n10 * 10;
  const n5 = v >= 5 ? 1 : 0;

  // Start near the tip, move inward as we add barbs
  let bx = x2;
  let by = y2;
  const calmCircleR = 6;
  const step = 5;          // spacing between barbs along staff
  const barbLen = 11;       // length of barb line
  const flagLen = 12;      // length along staff for 50kt flag

  // Helper to step back along the staff
  const back = (dist: number) => {
    bx -= dist * dx;
    by -= dist * dy;
  };

  // 50-kt flags (filled triangles)
  for (let i = 0; i < n50; i++) {
    const fx1 = bx;
    const fy1 = by;

    const fx2 = bx - flagLen * dx;
    const fy2 = by - flagLen * dy;

    const fx3 = fx2 + barbLen * px;
    const fy3 = fy2 + barbLen * py;

    ctx.beginPath();
    ctx.moveTo(fx1, fy1);
    ctx.lineTo(fx2, fy2);
    ctx.lineTo(fx3, fy3);
    ctx.closePath();
    ctx.fill();          // uses current fillStyle
    ctx.stroke();

    back(flagLen + 1);
  }

  // 10-kt full barbs
  for (let i = 0; i < n10; i++) {
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + barbLen * px, by + barbLen * py);
    ctx.stroke();
    back(step);
  }

  // 5-kt half barb
  if (n5) {
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + (barbLen * 0.5) * px, by + (barbLen * 0.5) * py);
    ctx.stroke();
  }
}

function drawWindVector(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dirFromDeg: number,
  spdKt: number
) {
  // Arrow points TOWARD where wind is going TO
  // given dirFromDeg (meteorological "from" direction)
  const theta = ((dirFromDeg + 90) * Math.PI) / 180; // +90 rotates to "to"
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);

  // length scaling (tune to taste)
  const len = Math.max(10, Math.min(42, spdKt * 1.2));
  const x2 = x + len * dx;
  const y2 = y + len * dy;

  // shaft
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // arrow head
  const head = 7;
  const ang = Math.PI / 7;
  const lx = x2 - head * Math.cos(theta - ang);
  const ly = y2 - head * Math.sin(theta - ang);
  const rx = x2 - head * Math.cos(theta + ang);
  const ry = y2 - head * Math.sin(theta + ang);

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(lx, ly);
  ctx.moveTo(x2, y2);
  ctx.lineTo(rx, ry);
  ctx.stroke();
}

type ScreenPoint = { x: number; y: number };
type SamplePoint = { x: number; y: number; tx: number; ty: number };

function flattenFeatureLineCoordinates(geometry: any): number[][][] {
  if (!geometry || typeof geometry !== "object") return [];
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates as number[][]];
  }
  if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates as number[][][];
  }
  return [];
}

function samplePolylineAtDistance(points: ScreenPoint[], distance: number): SamplePoint | null {
  if (points.length < 2 || distance < 0) return null;
  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-6) continue;
    if (traveled + segLen >= distance) {
      const t = (distance - traveled) / segLen;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      return { x, y, tx: dx / segLen, ty: dy / segLen };
    }
    traveled += segLen;
  }
  return null;
}

function polylineLength(points: ScreenPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

function drawFrontTriangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tx: number,
  ty: number,
  nx: number,
  ny: number,
  size: number,
  color: string
) {
  const apexX = x + nx * size * 1.15;
  const apexY = y + ny * size * 1.15;
  const baseCenterX = x - nx * size * 0.05;
  const baseCenterY = y - ny * size * 0.05;
  const halfBase = size * 0.85;
  const p1x = baseCenterX + tx * halfBase;
  const p1y = baseCenterY + ty * halfBase;
  const p2x = baseCenterX - tx * halfBase;
  const p2y = baseCenterY - ty * halfBase;

  ctx.beginPath();
  ctx.moveTo(apexX, apexY);
  ctx.lineTo(p1x, p1y);
  ctx.lineTo(p2x, p2y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.fill();
  ctx.stroke();
}

function drawFrontSemicircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tx: number,
  ty: number,
  nx: number,
  ny: number,
  size: number,
  color: string
) {
  const r = size * 0.72;
  const cx = x + nx * r * 0.85;
  const cy = y + ny * r * 0.85;
  const ex1 = cx - tx * r;
  const ey1 = cy - ty * r;
  const ex2 = cx + tx * r;
  const ey2 = cy + ty * r;
  const c1x = cx + nx * r * 1.1 + tx * r * 0.55;
  const c1y = cy + ny * r * 1.1 + ty * r * 0.55;
  const c2x = cx + nx * r * 1.1 - tx * r * 0.55;
  const c2y = cy + ny * r * 1.1 - ty * r * 0.55;

  ctx.beginPath();
  ctx.moveTo(ex1, ey1);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex2, ey2);
  ctx.lineTo(ex1, ey1);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.fill();
  ctx.stroke();
}

function drawDrylineScallop(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tx: number,
  ty: number,
  nx: number,
  ny: number,
  size: number,
  color: string
) {
  const r = size * 0.62;
  const cx = x + nx * r * 0.8;
  const cy = y + ny * r * 0.8;
  const ex1 = cx - tx * r;
  const ey1 = cy - ty * r;
  const ex2 = cx + tx * r;
  const ey2 = cy + ty * r;
  const c1x = cx + nx * r * 1.05 + tx * r * 0.55;
  const c1y = cy + ny * r * 1.05 + ty * r * 0.55;
  const c2x = cx + nx * r * 1.05 - tx * r * 0.55;
  const c2y = cy + ny * r * 1.05 - ty * r * 0.55;

  ctx.beginPath();
  ctx.moveTo(ex1, ey1);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex2, ey2);
  ctx.strokeStyle = color;
  ctx.stroke();
}

function hasReportedWeather(weatherCodes: string | null | undefined): boolean {
  if (!weatherCodes) return false;
  const tokens = weatherCodes
    .toUpperCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tokens.some((t) => t !== "M" && t !== "NULL" && t !== "NIL");
}

type WeatherSymbolSpec = {
  metpyCode: number;
  fallbackGlyph: string;
  color: string;
  priority: number;
};

// MetPy/WMO current weather code mapping (subset used for station weather mode).
const METPY_WX_SYMBOL_TABLE: Record<string, WeatherSymbolSpec> = {
  "FU": { metpyCode: 4, fallbackGlyph: "~", color: "#475569", priority: 1 },
  "VA": { metpyCode: 4, fallbackGlyph: "~", color: "#475569", priority: 1 },
  "HZ": { metpyCode: 5, fallbackGlyph: "oo", color: "#64748b", priority: 1 },
  "DU": { metpyCode: 6, fallbackGlyph: "S", color: "#92400e", priority: 1 },
  "SA": { metpyCode: 6, fallbackGlyph: "S", color: "#92400e", priority: 1 },
  "PO": { metpyCode: 8, fallbackGlyph: "@", color: "#7c2d12", priority: 2 },
  "VCSS": { metpyCode: 9, fallbackGlyph: "(SS)", color: "#92400e", priority: 1 },
  "BR": { metpyCode: 10, fallbackGlyph: "=", color: "#64748b", priority: 1 },
  "MIFG": { metpyCode: 11, fallbackGlyph: "=-", color: "#475569", priority: 2 },
  "VCTS": { metpyCode: 13, fallbackGlyph: "VCTS", color: "#6d28d9", priority: 6 },
  "VIRGA": { metpyCode: 14, fallbackGlyph: "VIR", color: "#0f766e", priority: 2 },
  "VCSH": { metpyCode: 16, fallbackGlyph: "VCSH", color: "#0f766e", priority: 3 },
  "TS": { metpyCode: 17, fallbackGlyph: "TS", color: "#6d28d9", priority: 8 },
  "SQ": { metpyCode: 18, fallbackGlyph: "SQ", color: "#1e293b", priority: 5 },
  "FC": { metpyCode: 19, fallbackGlyph: "FC", color: "#7f1d1d", priority: 8 },
  "SS": { metpyCode: 30, fallbackGlyph: "SS", color: "#92400e", priority: 4 },
  "+SS": { metpyCode: 31, fallbackGlyph: "SS+", color: "#7c2d12", priority: 5 },
  "BLSN": { metpyCode: 38, fallbackGlyph: "BLSN", color: "#1d4ed8", priority: 5 },
  "DRSN": { metpyCode: 39, fallbackGlyph: "DRSN", color: "#1d4ed8", priority: 5 },
  "VCFG": { metpyCode: 40, fallbackGlyph: "VCFG", color: "#64748b", priority: 2 },
  "BCFG": { metpyCode: 41, fallbackGlyph: "BCFG", color: "#64748b", priority: 2 },
  "PRFG": { metpyCode: 44, fallbackGlyph: "PRFG", color: "#475569", priority: 2 },
  "FG": { metpyCode: 45, fallbackGlyph: "==", color: "#64748b", priority: 2 },
  "FZFG": { metpyCode: 49, fallbackGlyph: "FZFG", color: "#1d4ed8", priority: 3 },
  "-DZ": { metpyCode: 51, fallbackGlyph: ",", color: "#0f766e", priority: 3 },
  "DZ": { metpyCode: 53, fallbackGlyph: ",,", color: "#0f766e", priority: 3 },
  "+DZ": { metpyCode: 55, fallbackGlyph: ",,,", color: "#0f766e", priority: 4 },
  "-FZDZ": { metpyCode: 56, fallbackGlyph: "FZDZ", color: "#be185d", priority: 6 },
  "FZDZ": { metpyCode: 57, fallbackGlyph: "FZDZ", color: "#be185d", priority: 6 },
  "+FZDZ": { metpyCode: 57, fallbackGlyph: "FZDZ+", color: "#9d174d", priority: 7 },
  "-DZRA": { metpyCode: 58, fallbackGlyph: "DZRA", color: "#0f766e", priority: 4 },
  "DZRA": { metpyCode: 59, fallbackGlyph: "DZRA", color: "#0f766e", priority: 4 },
  "-RA": { metpyCode: 61, fallbackGlyph: "\u2022", color: "#0f766e", priority: 4 },
  "RA": { metpyCode: 63, fallbackGlyph: "\u2022\u2022", color: "#0f766e", priority: 4 },
  "+RA": { metpyCode: 65, fallbackGlyph: "\u2022\u2022\u2022", color: "#0f766e", priority: 5 },
  "-FZRA": { metpyCode: 66, fallbackGlyph: "FZRA", color: "#be185d", priority: 7 },
  "FZRA": { metpyCode: 67, fallbackGlyph: "FZRA", color: "#be185d", priority: 7 },
  "+FZRA": { metpyCode: 67, fallbackGlyph: "FZRA+", color: "#9d174d", priority: 8 },
  "-RASN": { metpyCode: 68, fallbackGlyph: "RA/SN", color: "#2563eb", priority: 5 },
  "RASN": { metpyCode: 69, fallbackGlyph: "RA/SN", color: "#2563eb", priority: 5 },
  "-SN": { metpyCode: 71, fallbackGlyph: "*", color: "#2563eb", priority: 5 },
  "SN": { metpyCode: 73, fallbackGlyph: "**", color: "#2563eb", priority: 5 },
  "+SN": { metpyCode: 75, fallbackGlyph: "***", color: "#1d4ed8", priority: 6 },
  "SG": { metpyCode: 77, fallbackGlyph: "SG", color: "#334155", priority: 4 },
  "IC": { metpyCode: 78, fallbackGlyph: "IC", color: "#334155", priority: 4 },
  "PE": { metpyCode: 79, fallbackGlyph: "PL", color: "#334155", priority: 5 },
  "PL": { metpyCode: 79, fallbackGlyph: "PL", color: "#334155", priority: 5 },
  "-SHRA": { metpyCode: 80, fallbackGlyph: "SHRA", color: "#0f766e", priority: 5 },
  "SHRA": { metpyCode: 81, fallbackGlyph: "SHRA", color: "#0f766e", priority: 5 },
  "+SHRA": { metpyCode: 81, fallbackGlyph: "SHRA+", color: "#0f766e", priority: 6 },
  "-SHRASN": { metpyCode: 84, fallbackGlyph: "SHRASN", color: "#2563eb", priority: 6 },
  "SHRASN": { metpyCode: 85, fallbackGlyph: "SHRASN", color: "#2563eb", priority: 6 },
  "+SHRASN": { metpyCode: 85, fallbackGlyph: "SHRASN+", color: "#2563eb", priority: 7 },
  "-SHSN": { metpyCode: 86, fallbackGlyph: "SHSN", color: "#2563eb", priority: 6 },
  "SHSN": { metpyCode: 87, fallbackGlyph: "SHSN", color: "#2563eb", priority: 6 },
  "+SHSN": { metpyCode: 87, fallbackGlyph: "SHSN+", color: "#1d4ed8", priority: 7 },
  "-GR": { metpyCode: 88, fallbackGlyph: "GR", color: "#7c2d12", priority: 7 },
  "GR": { metpyCode: 89, fallbackGlyph: "GR", color: "#7c2d12", priority: 7 },
  "TSRA": { metpyCode: 95, fallbackGlyph: "TSRA", color: "#6d28d9", priority: 9 },
  "TSGR": { metpyCode: 96, fallbackGlyph: "TSGR", color: "#6d28d9", priority: 10 },
  "+TSRA": { metpyCode: 97, fallbackGlyph: "TSRA+", color: "#581c87", priority: 10 },
};

function weatherTokens(weatherCodes: string): string[] {
  return weatherCodes
    .toUpperCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "M" && t !== "NULL" && t !== "NIL");
}

function canonicalWxToken(token: string): string {
  let out = token.toUpperCase().trim();
  if (out.startsWith("VC")) out = out.slice(2);
  return out;
}

function weatherGlyphFromCodes(weatherCodes: string | null | undefined): { metpyCode: number; color: string; unknown: boolean } | null {
  if (!hasReportedWeather(weatherCodes)) return null;
  const tokens = weatherTokens(weatherCodes ?? "");
  if (tokens.length === 0) return null;

  let best: WeatherSymbolSpec | null = null;
  let sawUnknown = false;
  for (const rawToken of tokens) {
    const token = canonicalWxToken(rawToken);
    if (token === "UP") {
      sawUnknown = true;
      continue;
    }
    let spec = METPY_WX_SYMBOL_TABLE[token];
    if (!spec) {
      const unsigned = token.replace(/^[-+]/, "");
      spec = METPY_WX_SYMBOL_TABLE[unsigned];
    }
    if (!spec) {
      sawUnknown = true;
      continue;
    }
    if (best == null || spec.priority > best.priority) best = spec;
  }

  if (best) return { metpyCode: best.metpyCode, color: best.color, unknown: false };
  if (sawUnknown) return { metpyCode: -1, color: "#111827", unknown: true };
  return null;
}

function App() {
  const [obs, setObs] = useState<SurfaceObs[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewState, setViewState] = useState<ViewState>({
    longitude: -94.5928,
    latitude: 39.1232,
    zoom: 6,
    bearing: 0,
    pitch: 0,
    padding: { top: 0, left: 0, bottom: 0, right: 0 },
  });
  type TimelineMode = "live" | "history";
  const timelineMode: TimelineMode = "history";
  const [availableTimes, setAvailableTimes] = useState<string[]>([]);
  const [timeIndex, setTimeIndex] = useState<number>(-1);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeedMs, setPlaySpeedMs] = useState<number>(600);

  // simple cache to avoid refetching frames while animating
  const obsCacheRef = useRef<Map<string, SurfaceObs[]>>(new Map());
  const inflightRef = useRef<AbortController | null>(null);
  const plotDetail = useMemo(() => {
    if (viewState.zoom && viewState.zoom < 5.5) return "low";
    if (viewState.zoom && viewState.zoom < 7.5) return "medium";
    return "high";
  }, [viewState.zoom]);
  const [expandedStations, setExpandedStations] = useState<Set<string>>(new Set());
  const [selectedStation, setSelectedStation] = useState<SurfaceObs | null>(null);
  // Reference to the underlying MapLibre map instance
  const mapRef = useRef<MapRef | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wpcFrontCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analysisLabelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analysisGridRef = useRef<AnalysisGridStore>({});
  const animationFrameRef = useRef<number | null>(null);
  const wpcFrontAnimationFrameRef = useRef<number | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [cursorProbe, setCursorProbe] = useState<{ x: number; y: number; lng: number; lat: number } | null>(null);
  const obsById = useMemo(() => {
    const m = new Map<string, SurfaceObs>();
    for (const s of obs) m.set(s.id, s);
    return m;
  }, [obs]);

  type DensityMode = "sparse" | "medium" | "dense";

  const [densityMode, setDensityMode] = useState<DensityMode>(() => {
    const saved = localStorage.getItem("densityMode");
    return saved === "sparse" || saved === "medium" || saved === "dense" ? saved : "medium";
  });

  const densityMultiplier = useMemo(() => {
    switch (densityMode) {
      case "dense":
        return 0.25;
      case "sparse":
        return 4.0;
      case "medium":
      default:
        return 2.0;
    }
  }, [densityMode]);

  // Thin the stations by a pixel grid to reduce the number of points on the map
  const declutteredObs = useMemo<SurfaceObs[]>(() => {
    const map = getMapOrNull(mapRef);
    if (!map) return obs; // <- IMPORTANT: return obs, not undefined
  
    const z = viewState.zoom ?? 0;
  
    const baseCell =
      z < 4 ? 30 :
      z < 6 ? 22 :
      z < 8 ? 15 :
      z < 10 ? 10 :
      0;
  
    if (baseCell === 0) return obs;
  
    const cell = Math.max(6, Math.round(baseCell * densityMultiplier));
    return thinByPixelGrid(obs, map, cell);
  }, [obs, densityMultiplier, viewState.longitude, viewState.latitude, viewState.zoom]);
  
  // Layer for displaying the number of stations in each cluster
  const clusterCountLayer: any = {
    id: "cluster-count",
    type: "symbol",
    source: "stations",
    filter: ["has", "point_count"],
    layout: {
      "text-field": "{point_count_abbreviated}",
      "text-size": 12,
    },
  };
  
  // Expression for coloring the stations by flight rule
  const flightRuleColorExpr: any = useMemo(
    () => [
      "match",
      ["upcase", ["get", "flightRule"]],
      "VFR", "#4ade80",
      "MVFR", "#60a5fa",
      "IFR", "#f87171",
      "LIFR", "#f472b6",
      "#9ca3af",
    ],
    []
  );

  type WindRenderMode = "barbs" | "vectors";

const [windRenderMode, setWindRenderMode] = useState<WindRenderMode>(() => {
  const saved = localStorage.getItem("windRenderMode");
  return saved === "vectors" || saved === "barbs" ? (saved as WindRenderMode) : "barbs";
});

useEffect(() => {
  localStorage.setItem("windRenderMode", windRenderMode);
}, [windRenderMode]);

  // Load flight rule color coding preference from localStorage, default to off
  const [colorCodeByFlightRule, setColorCodeByFlightRule] = useState<boolean>(() => {
    const saved = localStorage.getItem("colorCodeByFlightRule");
    return saved === "true";
  });
  
  useEffect(() => {
    localStorage.setItem("densityMode", densityMode);
  }, [densityMode]);

const densityPx = useMemo(() => {
  // minimum spacing (pixels) between plotted stations
  switch (densityMode) {
    case "dense":
      return 55;
    case "sparse":
      return 110;
    case "medium":
    default:
      return 80;
  }
}, [densityMode]);

  // Load display mode preference from localStorage, default to dots
  type DisplayMode = "plots" | "dots" | "weather";

  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    const saved = localStorage.getItem("displayMode");
    return saved === "dots" || saved === "plots" || saved === "weather" ? (saved as DisplayMode) : "plots";
  });
  const [metpyWxGlyphMap, setMetpyWxGlyphMap] = useState<Record<number, string>>({});
  const [metpyWxFontReady, setMetpyWxFontReady] = useState(false);
  const [unknownWxSymbolCount, setUnknownWxSymbolCount] = useState(0);
  
  const setSurfaceObsMode = (mode: DisplayMode) => {
    setDisplayMode(mode);
    localStorage.setItem("displayMode", mode);
  };

  useEffect(() => {
    let cancelled = false;
    const styleId = "metpy-wx-font-style";
    if (!document.getElementById(styleId)) {
      const styleEl = document.createElement("style");
      styleEl.id = styleId;
      styleEl.textContent = `
        @font-face {
          font-family: "MetPyWxSymbols";
          src: url("/api/metpy/wx_font") format("truetype");
          font-display: swap;
        }
      `;
      document.head.appendChild(styleEl);
    }

    const loadGlyphMap = async () => {
      try {
        const res = await fetch("/api/metpy/wx_symbol_map");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const raw = (data?.glyphs ?? {}) as Record<string, string>;
        const parsed: Record<number, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          const idx = Number(k);
          if (Number.isFinite(idx) && typeof v === "string" && v.length > 0) {
            parsed[idx] = v;
          }
        }
        if (!cancelled) setMetpyWxGlyphMap(parsed);
      } catch {
        if (!cancelled) setMetpyWxGlyphMap({});
      }
    };

    const loadFont = async () => {
      try {
        if ((document as any).fonts?.load) {
          await (document as any).fonts.load(`24px "MetPyWxSymbols"`);
          if (!cancelled) setMetpyWxFontReady(true);
        }
      } catch {
        if (!cancelled) setMetpyWxFontReady(false);
      }
    };

    loadGlyphMap();
    loadFont();

    return () => {
      cancelled = true;
    };
  }, []);

  // Layer for displaying individual stations that are not part of a cluster
  const unclusteredLayer: any = {
    id: "unclustered",
    type: "circle",
    source: "stations",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": 5,
      "circle-stroke-width": 1,
      "circle-opacity": 0.9,
      "circle-stroke-color": "#111827",
      "circle-color": colorCodeByFlightRule ? flightRuleColorExpr : "#111827",
    },
  };

  // Invisible hit-target layer for plots mode (larger radius for easier clicking)
  const hitTargetsLayer: any = useMemo(() => ({
    id: "hit-targets",
    type: "circle",
    source: "stations",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": 12,                 // bigger = easier to click
      "circle-color": "rgba(0,0,0,0)",     // fully transparent
      "circle-stroke-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 0,
    },
  }), []);

  // GeoJSON data for the stations
  const stationsGeoJson = useMemo(() => {
    const list = (declutteredObs ?? []).filter((s) => {
      if (displayMode !== "weather") return true;
      return hasReportedWeather(s.weatherCodes);
    });
    return {
      type: "FeatureCollection",
      features: list.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { id: s.id, flightRule: s.flightRule },
      })),
    } as any;
  }, [declutteredObs, displayMode]);
  
  // Load temperature unit preference from localStorage, default to Fahrenheit
  const [tempUnit, setTempUnit] = useState<TempUnit>(() => {
    const saved = localStorage.getItem("tempUnit");
    return (saved === "C" || saved === "F" ? saved : "F") as TempUnit;
  });

  const [windUnit, setWindUnit] = useState<WindUnit>(() => {
    const saved = localStorage.getItem("windUnit");
    return saved === "MPH" || saved === "KPH" || saved === "KT" ? saved : "KT";
  });

  const fetchObservations = async () => {
    try {
      const res = await fetch("/api/obs/latest");
      const data = await res.json();
      setObs(data.stations ?? []);
      setLastUpdate(data.generated_at);
      setIsLoading(false);
    } catch (err) {
      console.error("Failed to fetch observations:", err);
      setIsLoading(false);
    }
  };

  const fetchAvailableTimes = useCallback(async (minutes = HISTORY_WINDOW_MINUTES) => {
    try {
      const res = await fetch(`/api/obs/times?minutes=${minutes}`);
      const data = await res.json();
      const rawTimes: string[] = Array.isArray(data.times) ? data.times : [];
      const cutoffMs = Date.now() - HISTORY_WINDOW_MINUTES * 60_000;
      const filteredTimes = rawTimes.filter((t) => {
        const ms = new Date(t).getTime();
        return Number.isFinite(ms) ? ms >= cutoffMs : true;
      });
      const times = filteredTimes;
      setAvailableTimes(times);
      // default to latest if we haven't chosen yet
      if (times.length > 0) setTimeIndex(times.length - 1);
    } catch (e) {
      console.error("Failed to fetch available times:", e);
      setAvailableTimes([]);
      setTimeIndex(-1);
    }
  }, []);
  
  const fetchObsAtTime = useCallback(async (iso: string) => {
    // cache hit
    const cached = obsCacheRef.current.get(iso);
    if (cached) {
      setObs(cached);
      setLastUpdate(iso);
      setIsLoading(false);
      return;
    }
  
    // cancel any inflight request (fast scrubbing)
    inflightRef.current?.abort();
    const ac = new AbortController();
    inflightRef.current = ac;
  
    try {
      const res = await fetch(`/api/obs/at?time=${encodeURIComponent(iso)}`, {
        signal: ac.signal,
      });
      const data = await res.json();
      const stations: SurfaceObs[] = data.stations ?? [];
      obsCacheRef.current.set(iso, stations);
  
      setObs(stations);
      // use returned time if you prefer: data.generated_at or data.snapshot_time
      setLastUpdate(data.generated_at ?? iso);
      setIsLoading(false);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      console.error("Failed to fetch obs at time:", e);
      setIsLoading(false);
    }
  }, []);

  const fetchObsSnapshot = useCallback(async (iso: string): Promise<SurfaceObs[]> => {
    const cached = obsCacheRef.current.get(iso);
    if (cached) return cached;
    try {
      const res = await fetch(`/api/obs/at?time=${encodeURIComponent(iso)}`);
      const data = await res.json();
      const stations: SurfaceObs[] = data.stations ?? [];
      obsCacheRef.current.set(iso, stations);
      return stations;
    } catch (e) {
      console.error("Failed to fetch snapshot for delta:", e);
      return [];
    }
  }, []);

  const [showStations, setShowStations] = useState<boolean>(() => {
    const saved = localStorage.getItem("showStations");
    return saved === null ? true : saved === "true";
  });
  const [changeBaselineObs, setChangeBaselineObs] = useState<SurfaceObs[]>([]);
  const [changeBaselineIso, setChangeBaselineIso] = useState<string | null>(null);

  const [selectedViewId, setSelectedViewId] = useState<string>(() => {
    return localStorage.getItem("selectedViewId") ?? "";
  });

  const [includeLegendInExport, setIncludeLegendInExport] = useState<boolean>(() => {
    const saved = localStorage.getItem("includeLegendInExport");
    return saved === null ? false : saved === "true";
  });
  const [legendsCollapsed, setLegendsCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem("legendsCollapsed");
    return saved === "true";
  });

  const [showCursorDiagnostics, setShowCursorDiagnostics] = useState<boolean>(() => {
    const saved = localStorage.getItem("cursorReadoutDiagnostics");
    return saved === null ? false : saved === "true";
  });

  const [displayTimeZone, setDisplayTimeZone] = useState<DisplayTimeZone>(() => {
    const saved = localStorage.getItem("displayTimeZone");
    return saved === "LOCAL" || saved === "UTC" ? (saved as DisplayTimeZone) : "UTC";
  });

  const [mrmsField, setMrmsField] = useState<MrmsField>(() => {
    const saved = localStorage.getItem("mrmsField");
    return saved === "rala" || saved === "composite" || saved === "etop18" || saved === "rotation240"
      ? (saved as MrmsField)
      : "none";
  });
  const [mrmsMeta, setMrmsMeta] = useState<MrmsMetaResponse | null>(null);
  const [mrmsError, setMrmsError] = useState<string | null>(null);
  const [mrmsCursorValue, setMrmsCursorValue] = useState<number | null>(null);
  const [nwsProduct, setNwsProduct] = useState<NwsProduct>(() => {
    const saved = localStorage.getItem("nwsProduct");
    return saved === "wpcSurface" ? "wpcSurface" : "none";
  });
  const [wpcSurface, setWpcSurface] = useState<WpcSurfaceResponse | null>(null);
  const [wpcError, setWpcError] = useState<string | null>(null);
  const [isOpsOpen, setIsOpsOpen] = useState(false);
  const [opsSummary, setOpsSummary] = useState<OpsSummaryResponse | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsLoading, setOpsLoading] = useState(false);
  const [frontRenderStyle, setFrontRenderStyle] = useState<FrontRenderStyle>(() => {
    const saved = localStorage.getItem("frontRenderStyle");
    return saved === "simple" || saved === "classic" ? saved : "classic";
  });

  const applyPresetView = useCallback((view: PresetView) => {
    setSelectedViewId(view.id);
    const map = mapRef.current?.getMap();
    if (!map) {
      setViewState((prev) => ({
        ...prev,
        longitude: view.lon,
        latitude: view.lat,
        zoom: view.zoom,
      }));
      return;
    }
    map.easeTo({
      center: [view.lon, view.lat],
      zoom: view.zoom,
      duration: 650,
      essential: true,
    });
  }, []);

  useEffect(() => {
    // Always drive the UI from history snapshots / slider frames.
    fetchAvailableTimes(HISTORY_WINDOW_MINUTES);
    const interval = setInterval(() => fetchAvailableTimes(HISTORY_WINDOW_MINUTES), 300000);
    return () => clearInterval(interval);
  }, [fetchAvailableTimes]);

  useEffect(() => {
    if (timelineMode !== "history") return;
    if (timeIndex < 0) return;
    if (timeIndex >= availableTimes.length) return;
  
    const t = availableTimes[timeIndex];
    if (!t) return;
  
    fetchObsAtTime(t);
  }, [timelineMode, timeIndex, availableTimes, fetchObsAtTime]);

  useEffect(() => {
    if (timelineMode !== "history") return;
    if (!isPlaying) return;
    if (availableTimes.length < 2) return;
    if (timeIndex < 0) return; // wait until we have a valid index
  
    const lastIdx = availableTimes.length - 1;
    const isLastFrame = timeIndex >= lastIdx;
  
    // Hold the last frame for 2x the selected speed
    const delay = isLastFrame ? playSpeedMs * 2 : playSpeedMs;
  
    const id = window.setTimeout(() => {
      setTimeIndex((prev) => {
        const last = availableTimes.length - 1;
        if (prev >= last) return 0;     // loop back to start
        return prev + 1;                // advance
      });
    }, delay);
  
    return () => window.clearTimeout(id);
  }, [timelineMode, isPlaying, playSpeedMs, availableTimes.length, timeIndex]);

  // Handle ESC key to close popup
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedStation) {
        closePopup();
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [selectedStation]);

  function lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
  }
  
  function clamp01(x: number) {
    return Math.max(0, Math.min(1, x));
  }
  
  // Simple temperature ramp (in °F): blue -> cyan -> green -> yellow -> orange -> red
  function tempToRgbaF(tempF: number, alpha: number): string {
    // Tune range to taste:
    const tMin = 0;
    const tMax = 100;
    const t = clamp01((tempF - tMin) / (tMax - tMin));
  
    // piecewise stops
    const stops = [
      { t: 0.0, c: [30, 64, 175] },   // deep blue
      { t: 0.2, c: [56, 189, 248] },  // cyan
      { t: 0.4, c: [74, 222, 128] },  // green
      { t: 0.6, c: [250, 204, 21] },  // yellow
      { t: 0.8, c: [251, 146, 60] },  // orange
      { t: 1.0, c: [239, 68, 68] },   // red
    ];
  
    let i = 0;
    while (i < stops.length - 1 && t > stops[i + 1].t) i++;
  
    const a = stops[i];
    const b = stops[Math.min(i + 1, stops.length - 1)];
    const localT = (t - a.t) / Math.max(1e-9, (b.t - a.t));
  
    const r = Math.round(lerp(a.c[0], b.c[0], localT));
    const g = Math.round(lerp(a.c[1], b.c[1], localT));
    const bl = Math.round(lerp(a.c[2], b.c[2], localT));
  
    return `rgba(${r}, ${g}, ${bl}, ${alpha})`;
  }
  
  // Draw station plots on canvas overlay
  const drawStationPlots = useCallback(() => {
    // Only draw if using a canvas-based station mode
    if (!showStations) return;
    if (displayMode !== "plots" && displayMode !== "weather") return;
    
    const canvas = canvasRef.current;
    const map = getMapOrNull(mapRef);
    if (!canvas || !map) return;
    const zoom = map.getZoom();
    const showNumbers = zoom >= 4; //temp/dewpoint numbers
    const showPressure = zoom >= 5; //SLP code

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Set canvas size accounting for devicePixelRatio
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Scale context for devicePixelRatio
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    let unknownCount = 0;

    // Draw each station in declutteredObs
    for (const station of declutteredObs) {
      try {
        const point = map.project([station.lon, station.lat]);
        
        // Skip if outside viewport
        if (point.x < -50 || point.x > width + 50 || point.y < -50 || point.y > height + 50) {
          continue;
        }

        const x = point.x;
        const y = point.y;
        const radius = zoom < 7.5 ? 6 : 8;

        if (displayMode === "weather") {
          const glyph = weatherGlyphFromCodes(station.weatherCodes);
          if (!glyph) continue;
          const symbolSize = zoom < 6 ? 18 : zoom < 8 ? 22 : 26;
          const metpyGlyph = glyph.metpyCode >= 0 ? metpyWxGlyphMap[glyph.metpyCode] : undefined;
          const useMetpyGlyph = Boolean(metpyGlyph && metpyWxFontReady);
          const symbolText = useMetpyGlyph ? (metpyGlyph as string) : "?";
          const fontFamily = useMetpyGlyph ? "MetPyWxSymbols" : "system-ui, sans-serif";
          if (!useMetpyGlyph) unknownCount += 1;

          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `700 ${symbolSize}px ${fontFamily}`;
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(255,255,255,0.92)";
          ctx.strokeText(symbolText, x, y);
          ctx.fillStyle = glyph.color;
          ctx.fillText(symbolText, x, y);
          continue;
        }

        // Calculate sky cover fill fraction
        let maxFill = 0;
        for (const sc of station.skyConditions) {
          const fill = 
            sc.cover === "OVC" ? 1.0 :
            sc.cover === "BKN" ? 0.75 :
            sc.cover === "SCT" ? 0.5 :
            sc.cover === "FEW" ? 0.25 : 0;
          maxFill = Math.max(maxFill, fill);
        }

        // Draw station circle outline
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();

        // Draw sky cover fill (wedge)
        if (maxFill > 0) {
          ctx.fillStyle = "rgba(148, 163, 184, 0.4)";
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * maxFill);
          ctx.closePath();
          ctx.fill();
        }

        // Temperature (upper-left)
        if (showNumbers) {
          const temp = tempUnit === "F" 
            ? Math.round(celsiusToFahrenheit(station.tempC))
            : Math.round(station.tempC);
          ctx.fillStyle = "#f87171";
          ctx.font = "10px system-ui, sans-serif";
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${temp}`, x - radius - 2, y - radius - 2);

          // Dewpoint (lower-left)
          if (station.dewpointC !== null) {
            const dewp = tempUnit === "F"
              ? Math.round(celsiusToFahrenheit(station.dewpointC))
              : Math.round(station.dewpointC);
            ctx.fillStyle = "#4ade80";
            ctx.textBaseline = "top";
            ctx.fillText(`${dewp}`, x - radius - 2, y + radius + 2);
          }
        }

        // SLP code (upper-right)
        if (showPressure && station.pressureMb !== null) {
          const slp = Math.round(station.pressureMb * 10) % 1000;
          const slpStr = String(slp).padStart(3, "0");
          ctx.fillStyle = "#000000";
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(slpStr, x + radius + 2, y - radius - 2);
        }

        // Wind barb (to the right of circle)
        if (station.windDirDeg !== null && station.windSpeedKt !== null) {
          const windDir = station.windDirDeg;
          const windSpeed = station.windSpeedKt;
          // Wind barb (attached to circle edge)
          ctx.strokeStyle = "#000000";
          ctx.fillStyle = "#000000";
          ctx.lineWidth = 1.5;
          drawWindBarb(ctx, x, y, radius, station.windDirDeg, station.windSpeedKt);
          ctx.lineWidth = 1; // reset if you want consistent width elsewhere
        }
      } catch (e) {
        // Skip stations that can't be projected
        continue;
      }
    }
    setUnknownWxSymbolCount(unknownCount);
  }, [declutteredObs, tempUnit, viewState, displayMode, showStations, metpyWxGlyphMap, metpyWxFontReady]);

  useEffect(() => {
    if (displayMode !== "weather") {
      setUnknownWxSymbolCount(0);
    }
  }, [displayMode]);

  // Redraw canvas on map move/zoom/resize
  useEffect(() => {
    const redraw = () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = requestAnimationFrame(() => {
        drawStationPlots();
      });
    };

    if (!mapLoaded) return;

    const map = mapRef.current?.getMap();
    if (!map) return;

    map.on("move", redraw);
    map.on("zoom", redraw);
    map.on("resize", redraw);

    // Initial draw
    redraw();

    return () => {
      map.off("move", redraw);
      map.off("zoom", redraw);
      map.off("resize", redraw);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [drawStationPlots, mapLoaded]);

  const drawClassicWpcFronts = useCallback(() => {
    const canvas = wpcFrontCanvasRef.current;
    const map = getMapOrNull(mapRef);
    if (!canvas || !map) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (nwsProduct !== "wpcSurface" || frontRenderStyle !== "classic" || !wpcSurface) return;

    const zoom = map.getZoom();
    const spacing = zoom < 4.5 ? 56 : zoom < 6.5 ? 44 : zoom < 8.5 ? 34 : 28;
    const symbolSize = zoom < 4.5 ? 7 : zoom < 6.5 ? 8.5 : zoom < 8.5 ? 10 : 11;
    const lineWidth = zoom < 4.5 ? 2.0 : zoom < 7.5 ? 2.5 : 2.8;

    const frontFeatures = wpcSurface.fronts?.features ?? [];
    for (const feature of frontFeatures) {
      const frontType = String(feature?.properties?.feature ?? "").toUpperCase();
      const lineGroups = flattenFeatureLineCoordinates(feature?.geometry);
      for (const line of lineGroups) {
        if (!Array.isArray(line) || line.length < 2) continue;
        const points: ScreenPoint[] = [];
        for (const coord of line) {
          if (!Array.isArray(coord) || coord.length < 2) continue;
          const lon = Number(coord[0]);
          const lat = Number(coord[1]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const p = map.project([lon, lat]);
          points.push({ x: p.x, y: p.y });
        }
        if (points.length < 2) continue;

        let lineColor = "#334155";
        let dashed = false;
        switch (frontType) {
          case "COLD":
            lineColor = "#2563eb";
            break;
          case "WARM":
            lineColor = "#dc2626";
            break;
          case "OCFNT":
            lineColor = "#7c3aed";
            break;
          case "STNRY":
            lineColor = "#a855f7";
            dashed = true;
            break;
          case "DRYLINE":
            lineColor = "#b45309";
            dashed = true;
            break;
          case "TROF":
            lineColor = "#92400e";
            dashed = true;
            break;
        }

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = lineWidth;
        ctx.setLineDash(dashed ? [7, 5] : []);
        ctx.stroke();
        ctx.setLineDash([]);

        if (frontType === "TROF") continue;
        const length = polylineLength(points);
        if (length < spacing) continue;
        let idx = 0;
        for (let d = spacing * 0.5; d < length - spacing * 0.35; d += spacing, idx++) {
          const sample = samplePolylineAtDistance(points, d);
          if (!sample) continue;
          const nx = sample.ty;
          const ny = -sample.tx;
          if (frontType === "COLD") {
            drawFrontTriangle(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#2563eb");
          } else if (frontType === "WARM") {
            drawFrontSemicircle(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#dc2626");
          } else if (frontType === "OCFNT") {
            if (idx % 2 === 0) {
              drawFrontSemicircle(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#7c3aed");
            } else {
              drawFrontTriangle(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#7c3aed");
            }
          } else if (frontType === "STNRY") {
            if (idx % 2 === 0) {
              drawFrontSemicircle(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#dc2626");
            } else {
              drawFrontTriangle(ctx, sample.x, sample.y, sample.tx, sample.ty, -nx, -ny, symbolSize, "#2563eb");
            }
          } else if (frontType === "DRYLINE") {
            drawDrylineScallop(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#b45309");
          }
        }
      }
    }
  }, [nwsProduct, frontRenderStyle, wpcSurface]);

  useEffect(() => {
    if (!mapLoaded) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const redraw = () => {
      if (wpcFrontAnimationFrameRef.current) cancelAnimationFrame(wpcFrontAnimationFrameRef.current);
      wpcFrontAnimationFrameRef.current = requestAnimationFrame(() => drawClassicWpcFronts());
    };
    map.on("move", redraw);
    map.on("zoom", redraw);
    map.on("resize", redraw);
    redraw();
    return () => {
      map.off("move", redraw);
      map.off("zoom", redraw);
      map.off("resize", redraw);
      if (wpcFrontAnimationFrameRef.current) cancelAnimationFrame(wpcFrontAnimationFrameRef.current);
    };
  }, [mapLoaded, drawClassicWpcFronts]);

  const mapStyle = useMemo(
    () => "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    []
  );

  const toggleTempUnit = () => {
    const newUnit = tempUnit === "F" ? "C" : "F";
    setTempUnit(newUnit);
    localStorage.setItem("tempUnit", newUnit);
  };

  const toggleColorCodeByFlightRule = () => {
    const newValue = !colorCodeByFlightRule;
    setColorCodeByFlightRule(newValue);
    localStorage.setItem("colorCodeByFlightRule", String(newValue));
  };

  const toggleDisplayMode = () => {
    const modeOrder: DisplayMode[] = ["plots", "dots", "weather"];
    const idx = modeOrder.indexOf(displayMode);
    const newMode = modeOrder[(idx + 1) % modeOrder.length];
    setDisplayMode(newMode);
    localStorage.setItem("displayMode", newMode);
  };

  const getFlightRuleColor = (flightRule: string): string => {
    const rule = flightRule.toUpperCase();
    switch (rule) {
      case "VFR":
        return "#4ade80"; // green
      case "MVFR":
        return "#60a5fa"; // blue
      case "IFR":
        return "#f87171"; // red
      case "LIFR":
        return "#f472b6"; // magenta
      default:
        return "#9ca3af"; // gray
    }
  };

  const formatTemp = (tempC: number): string => {
    if (tempUnit === "F") {
      return `${celsiusToFahrenheit(tempC).toFixed(0)}°`;
    }
    return `${tempC.toFixed(0)}°`;
  };

  const formatTempDetailed = (tempC: number): string => {
    if (tempUnit === "F") {
      return `${celsiusToFahrenheit(tempC).toFixed(1)}°F`;
    }
    return `${tempC.toFixed(1)}°C`;
  };

  const formatDewpoint = (dewpointC: number | null): string => {
    if (dewpointC === null) return "";
    if (tempUnit === "F") {
      return ` / ${celsiusToFahrenheit(dewpointC).toFixed(1)}°F`;
    }
    return ` / ${dewpointC.toFixed(1)}°C`;
  };

  const formatTempDewpoint = (tempC: number, dewpointC: number | null): string => {
    // Format as "50/38" or just "50" if no dewpoint
    let temp: number;
    if (tempUnit === "F") {
      temp = Math.round(celsiusToFahrenheit(tempC));
    } else {
      temp = Math.round(tempC);
    }
    
    if (dewpointC !== null) {
      let dewpoint: number;
      if (tempUnit === "F") {
        dewpoint = Math.round(celsiusToFahrenheit(dewpointC));
      } else {
        dewpoint = Math.round(dewpointC);
      }
      return `${temp}/${dewpoint}`;
    }
    
    // If no dewpoint, show just temperature
    return `${temp}`;
  };

  // Filter observations to only those visible in current map viewport
  const visibleObs = useMemo(() => {
    if (!viewState || obs.length === 0) return obs;
    
    // Calculate viewport bounds based on zoom level
    // Using Mercator projection approximation
    const latRad = (viewState.latitude * Math.PI) / 180;
    const n = Math.pow(2, viewState.zoom);
    const latRange = 360 / n;
    const lonRange = (360 / n) / Math.cos(latRad);
    
    // Add padding to ensure we capture stations near edges
    const padding = 0.15;
    const latPadding = latRange * padding;
    const lonPadding = lonRange * padding;
    
    const minLat = viewState.latitude - latRange / 2 - latPadding;
    const maxLat = viewState.latitude + latRange / 2 + latPadding;
    let minLon = viewState.longitude - lonRange / 2 - lonPadding;
    let maxLon = viewState.longitude + lonRange / 2 + lonPadding;
    
    // Handle longitude wrapping
    if (minLon < -180) minLon += 360;
    if (maxLon > 180) maxLon -= 360;
    
    return obs.filter((station) => {
      const inLatRange = station.lat >= minLat && station.lat <= maxLat;
      
      // Handle longitude wrapping
      let inLonRange = false;
      if (minLon <= maxLon) {
        // Normal case, no wrapping
        inLonRange = station.lon >= minLon && station.lon <= maxLon;
      } else {
        // Wrapping case (e.g., minLon = 170, maxLon = -170)
        inLonRange = station.lon >= minLon || station.lon <= maxLon;
      }
      
      return inLatRange && inLonRange;
    });
  }, [obs, viewState]);

  const toggleExpanded = (stationId: string) => {
    setExpandedStations((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(stationId)) {
        newSet.delete(stationId);
      } else {
        newSet.add(stationId);
      }
      return newSet;
    });
  };

  const handleMarkerClick = (station: SurfaceObs) => {
    setSelectedStation(station);
  };

  const closePopup = () => {
    setSelectedStation(null);
  };

  const formatWindDirection = (deg: number | null): string => {
    if (deg === null) return "VRB";
    const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const index = Math.round(deg / 22.5) % 16;
    return directions[index];
  };

  const formatWindSpeed = useCallback((kt: number, digits = 1): string => {
    const value = knotsToWindUnit(kt, windUnit);
    return `${value.toFixed(digits)} ${windUnit}`;
  }, [windUnit]);

  const formatWindSpeedCompact = useCallback((kt: number): string => {
    const value = knotsToWindUnit(kt, windUnit);
    return `${Math.round(value)}${windUnit.toLowerCase()}`;
  }, [windUnit]);

  const windFillLegend = useMemo(() => {
    const thresholds = getWindFillThresholds(windUnit);
    return WIND_FILL_COLORS.map((color, idx) => {
      const start = thresholds[idx];
      const end = thresholds[idx + 1];
      return {
        color,
        label: !Number.isFinite(end) ? `>${start} ${windUnit}` : `${start}-${end} ${windUnit}`,
      };
    });
  }, [windUnit]);

  const ceilingFillLegend = useMemo(
    () => CEILING_FILL_COLORS.map((color, idx) => {
      const start = CEILING_LEVELS_HUNDREDS_FT[idx];
      const end = CEILING_LEVELS_HUNDREDS_FT[idx + 1];
      const fmt = (v: number) => String(Math.round(v)).padStart(3, "0");
      return { color, label: `${fmt(start)}-${fmt(end)}` };
    }),
    []
  );

  const visibilityFillLegend = useMemo(
    () => VISIBILITY_FILL_COLORS.map((color, idx) => {
      const start = VISIBILITY_LEVELS_SM[idx];
      const end = VISIBILITY_LEVELS_SM[idx + 1];
      const formatSm = (v: number) => {
        if (Math.abs(v - 0.25) < 1e-6) return "1/4SM";
        if (Math.abs(v - 0.5) < 1e-6) return "1/2SM";
        return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2)}SM`;
      };
      return { color, label: `${formatSm(start)}-${formatSm(end)}` };
    }),
    []
  );

  const relativeHumidityLegend = useMemo(
    () => [
      ...RH_DRY_COLORS.map((color, idx) => {
        const start = RH_DRY_LEVELS[idx];
        const end = RH_DRY_LEVELS[idx + 1];
        return { color, label: `${start}-${end}%` };
      }),
      ...RH_MOIST_COLORS.map((color, idx) => {
        const start = RH_MOIST_LEVELS[idx];
        const end = RH_MOIST_LEVELS[idx + 1];
        return { color, label: !Number.isFinite(end) ? `>${start}%` : `${start}-${end}%` };
      }),
    ],
    []
  );

  const deltaSlpLegend = useMemo(
    () => makeDivergingLegend(DELTA_SLP_NEG_CUTS, DELTA_SLP_POS_CUTS, DELTA_SLP_NEG_COLORS, DELTA_SLP_POS_COLORS, "mb"),
    []
  );

  const deltaTempLegend = useMemo(() => {
    const cuts = tempUnit === "F" ? DELTA_TEMP_CUTS_F : DELTA_TEMP_CUTS_C;
    return makeDivergingLegend(cuts.neg, cuts.pos, DELTA_TEMP_NEG_COLORS, DELTA_TEMP_POS_COLORS, `°${tempUnit}`);
  }, [tempUnit]);

  const deltaDewpointLegend = useMemo(() => {
    const cuts = tempUnit === "F" ? DELTA_TEMP_CUTS_F : DELTA_TEMP_CUTS_C;
    return makeDivergingLegend(cuts.neg, cuts.pos, DELTA_DEWPOINT_NEG_COLORS, DELTA_DEWPOINT_POS_COLORS, `°${tempUnit}`);
  }, [tempUnit]);

  const deltaThetaELegend = useMemo(
    () => makeDivergingLegend(DELTA_THETAE_NEG_CUTS, DELTA_THETAE_POS_CUTS, DELTA_THETAE_NEG_COLORS, DELTA_THETAE_POS_COLORS, "K"),
    []
  );

  type AnalysisOverlay =
    | "temp"
    | "dewpoint"
    | "slp"
    | "wind"
    | "windSpeedFill"
    | "ceilingFill"
    | "visibilityFill"
    | "relativeHumidityFill";
  type AnalysisOverlaySet = Record<AnalysisOverlay, boolean>;
  type DerivedOverlay =
    | "mixingRatio"
    | "moistureConvergence"
    | "thetaE"
    | "deltaSlp24h"
    | "deltaTemp24h"
    | "deltaDewpoint24h"
    | "deltaThetaE24h";
  type DerivedOverlaySet = Record<DerivedOverlay, boolean>;
  type GeographyOverlay = "adm0" | "adm1" | "adm2" | "artcc";
  type GeographyOverlaySet = Record<GeographyOverlay, boolean>;
  
  const [analysisOverlays, setAnalysisOverlays] = useState<AnalysisOverlaySet>(() => {
    const saved = localStorage.getItem("analysisOverlays");
    if (saved) {
      try {
        const obj = JSON.parse(saved) as Partial<AnalysisOverlaySet>;
        return {
          temp: !!obj.temp,
          dewpoint: !!obj.dewpoint,
          slp: !!obj.slp,
          wind: !!obj.wind,
          windSpeedFill: !!obj.windSpeedFill,
          ceilingFill: !!obj.ceilingFill,
          visibilityFill: !!obj.visibilityFill,
          relativeHumidityFill: !!obj.relativeHumidityFill,
        };
      } catch {}
    }
    return {
      temp: true,
      dewpoint: false,
      slp: false,
      wind: false,
      windSpeedFill: false,
      ceilingFill: false,
      visibilityFill: false,
      relativeHumidityFill: false,
    };
  });
  
  const anyOverlayOn =
  analysisOverlays.temp
  || analysisOverlays.dewpoint
  || analysisOverlays.slp
  || analysisOverlays.wind
  || analysisOverlays.windSpeedFill
  || analysisOverlays.ceilingFill
  || analysisOverlays.visibilityFill
  || analysisOverlays.relativeHumidityFill;

  const [derivedOverlays, setDerivedOverlays] = useState<DerivedOverlaySet>(() => {
    const saved = localStorage.getItem("derivedOverlays");
    if (saved) {
      try {
        const obj = JSON.parse(saved) as Partial<DerivedOverlaySet> & {
          deltaSlp3h?: boolean;
          deltaTemp3h?: boolean;
          deltaDewpoint3h?: boolean;
          deltaThetaE3h?: boolean;
        };
        return {
          mixingRatio: !!obj.mixingRatio,
          moistureConvergence: !!obj.moistureConvergence,
          thetaE: !!obj.thetaE,
          // Backward-compatible migration from older `*3h` keys.
          deltaSlp24h: !!(obj.deltaSlp24h ?? obj.deltaSlp3h),
          deltaTemp24h: !!(obj.deltaTemp24h ?? obj.deltaTemp3h),
          deltaDewpoint24h: !!(obj.deltaDewpoint24h ?? obj.deltaDewpoint3h),
          deltaThetaE24h: !!(obj.deltaThetaE24h ?? obj.deltaThetaE3h),
        };
      } catch {}
    }
    return {
      mixingRatio: false,
      moistureConvergence: false,
      thetaE: false,
      deltaSlp24h: false,
      deltaTemp24h: false,
      deltaDewpoint24h: false,
      deltaThetaE24h: false,
    };
  });

  const anyAnalysisLikeOverlayOn =
    anyOverlayOn
    || derivedOverlays.mixingRatio
    || derivedOverlays.moistureConvergence
    || derivedOverlays.thetaE
    || derivedOverlays.deltaSlp24h
    || derivedOverlays.deltaTemp24h
    || derivedOverlays.deltaDewpoint24h
    || derivedOverlays.deltaThetaE24h;

  type LegendItem = { color: string; label: string };
  type LegendCard = { title: string; items: LegendItem[] };
  const mrmsGradientLegend = useMemo(() => {
    if (mrmsField !== "rala" && mrmsField !== "composite") return null;
    return {
      title: `MRMS ${getMrmsProductLabel(mrmsField)} (dBZ)`,
      labels: ["85+", "75", "65", "50", "40", "20", "0", "-35"],
      gradientCss: makeReflectivityGradientCss(),
    };
  }, [mrmsField]);
  const activeFillLegendCards = useMemo<LegendCard[]>(() => {
    const cards: LegendCard[] = [];
    if (analysisOverlays.windSpeedFill) {
      cards.push({ title: `Wind Speed (${windUnit})`, items: windFillLegend });
    }
    if (analysisOverlays.ceilingFill) {
      cards.push({ title: "Ceiling (hundreds ft)", items: ceilingFillLegend });
    }
    if (analysisOverlays.visibilityFill) {
      cards.push({ title: "Visibility (SM)", items: visibilityFillLegend });
    }
    if (analysisOverlays.relativeHumidityFill) {
      cards.push({ title: "RH Critical (%)", items: relativeHumidityLegend });
    }
    if (derivedOverlays.deltaSlp24h) {
      cards.push({ title: "24h SLP Change (mb)", items: deltaSlpLegend });
    }
    if (derivedOverlays.deltaTemp24h) {
      cards.push({ title: `24h Temp Change (°${tempUnit})`, items: deltaTempLegend });
    }
    if (derivedOverlays.deltaDewpoint24h) {
      cards.push({ title: `24h Dewpoint Change (°${tempUnit})`, items: deltaDewpointLegend });
    }
    if (derivedOverlays.deltaThetaE24h) {
      cards.push({ title: "24h Theta-e Change (K)", items: deltaThetaELegend });
    }
    if (mrmsField === "etop18") {
      cards.push({
        title: `MRMS ${getMrmsProductLabel(mrmsField)} (${getMrmsProductUnit(mrmsField)})`,
        items: ETOP18_LEGEND_ITEMS,
      });
    }
    if (mrmsField === "rotation240") {
      cards.push({
        title: `MRMS ${getMrmsProductLabel(mrmsField)} (${getMrmsProductUnit(mrmsField)})`,
        items: ROT240_LEGEND_ITEMS,
      });
    }
    if (nwsProduct === "wpcSurface") {
      cards.push({ title: "WPC Surface Analysis", items: WPC_LEGEND_ITEMS });
    }
    return cards;
  }, [
    analysisOverlays.windSpeedFill,
    analysisOverlays.ceilingFill,
    analysisOverlays.visibilityFill,
    analysisOverlays.relativeHumidityFill,
    windUnit,
    windFillLegend,
    ceilingFillLegend,
    visibilityFillLegend,
    relativeHumidityLegend,
    derivedOverlays.deltaSlp24h,
    derivedOverlays.deltaTemp24h,
    derivedOverlays.deltaDewpoint24h,
    derivedOverlays.deltaThetaE24h,
    deltaSlpLegend,
    deltaTempLegend,
    deltaDewpointLegend,
    deltaThetaELegend,
    tempUnit,
    mrmsField,
    nwsProduct,
  ]);

  type ContourLegendItem = {
    key: "temp" | "dewpoint" | "slp" | "mixingRatio" | "moistureConvergence" | "thetaE";
    label: string;
    color: string;
    width: number;
    dash?: number[];
  };
  const contourLegendItems = useMemo<ContourLegendItem[]>(() => {
    const items: ContourLegendItem[] = [];
    if (analysisOverlays.temp) {
      items.push({ key: "temp", label: `Temperature (°${tempUnit})`, color: "#dc2626", width: 2 });
    }
    if (analysisOverlays.dewpoint) {
      const dpThreshold = tempUnit === "F" ? 45 : 8;
      items.push({
        key: "dewpoint",
        label: `Dewpoint (°${tempUnit}, ≥${dpThreshold})`,
        color: "#14532d",
        width: 2,
        dash: [5, 6],
      });
    }
    if (analysisOverlays.slp) items.push({ key: "slp", label: "Sea-Level Pressure (mb)", color: "#111827", width: 3 });
    if (derivedOverlays.mixingRatio) {
      items.push({ key: "mixingRatio", label: "Mixing Ratio (g/kg, ≥10)", color: "#14532d", width: 3 });
    }
    if (derivedOverlays.thetaE) {
      items.push({ key: "thetaE", label: "Theta-e (K, ≥330)", color: "#15803d", width: 1.2 });
    }
    if (derivedOverlays.moistureConvergence) {
      items.push({
        key: "moistureConvergence",
        label: "Moisture Convergence (x10⁷ s⁻¹)",
        color: "#1d4ed8",
        width: 2.6,
      });
    }
    return items;
  }, [
    analysisOverlays.temp,
    analysisOverlays.dewpoint,
    analysisOverlays.slp,
    derivedOverlays.mixingRatio,
    derivedOverlays.thetaE,
    derivedOverlays.moistureConvergence,
    tempUnit,
  ]);

  const diagnosticsRows = useMemo(() => {
    if (!cursorProbe || !showCursorDiagnostics) return [] as Array<{ label: string; value: string }>;
    const g = analysisGridRef.current;
    const x = cursorProbe.x;
    const y = cursorProbe.y;
    const rows: Array<{ label: string; value: string }> = [];

    if (analysisOverlays.temp) {
      const v = sampleScalarGrid(g.temp, x, y);
      rows.push({ label: `Temperature (°${tempUnit})`, value: v == null ? "—" : v.toFixed(1) });
    }
    if (analysisOverlays.dewpoint) {
      const v = sampleScalarGrid(g.dewpoint, x, y);
      rows.push({ label: `Dewpoint (°${tempUnit})`, value: v == null ? "—" : v.toFixed(1) });
    }
    if (analysisOverlays.slp) {
      const v = sampleScalarGrid(g.slp, x, y);
      rows.push({ label: "SLP (mb)", value: v == null ? "—" : v.toFixed(1) });
    }
    if (analysisOverlays.wind) {
      const vv = sampleVectorGrid(g.windVector, x, y);
      if (vv == null) {
        rows.push({ label: `Wind (${windUnit})`, value: "—" });
      } else {
        const ws = uvToDirSpd(vv.u, vv.v);
        rows.push({
          label: `Wind (${windUnit})`,
          value: `${Math.round(ws.dir)}° ${knotsToWindUnit(ws.spd, windUnit).toFixed(1)}`,
        });
      }
    }
    if (analysisOverlays.windSpeedFill) {
      const v = sampleScalarGrid(g.windSpeed, x, y);
      rows.push({
        label: `Wind Speed Fill (${windUnit})`,
        value: v == null ? "—" : knotsToWindUnit(v, windUnit).toFixed(1),
      });
    }
    if (analysisOverlays.ceilingFill) {
      const v = sampleScalarGrid(g.ceiling, x, y);
      const val = v == null ? "—" : String(Math.round(v)).padStart(3, "0");
      const suffix = v != null && v > 50 ? " (hidden on map)" : "";
      rows.push({ label: "Ceiling (hundreds ft)", value: `${val}${suffix}` });
    }
    if (analysisOverlays.visibilityFill) {
      const v = sampleScalarGrid(g.visibility, x, y);
      const suffix = v != null && v > 6 ? " (hidden on map)" : "";
      rows.push({ label: "Visibility (SM)", value: v == null ? "—" : `${v.toFixed(2)}${suffix}` });
    }
    if (analysisOverlays.relativeHumidityFill) {
      const v = sampleScalarGrid(g.relativeHumidity, x, y);
      const hidden = v != null && v >= 25 && v <= 90;
      rows.push({
        label: "Relative Humidity (%)",
        value: v == null ? "—" : `${v.toFixed(1)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (derivedOverlays.mixingRatio) {
      const v = sampleScalarGrid(g.mixingRatio, x, y);
      const hidden = v != null && v < 10;
      rows.push({
        label: "Mixing Ratio (g/kg)",
        value: v == null ? "—" : `${v.toFixed(2)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (derivedOverlays.thetaE) {
      const v = sampleScalarGrid(g.thetaE, x, y);
      const hidden = v != null && v < 330;
      rows.push({
        label: "Theta-e (K)",
        value: v == null ? "—" : `${v.toFixed(1)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (derivedOverlays.deltaSlp24h) {
      const v = sampleScalarGrid(g.deltaSlp24h, x, y);
      const hidden = v != null && Math.abs(v) <= 4;
      rows.push({
        label: "24h SLP Change (mb)",
        value: v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (derivedOverlays.deltaTemp24h) {
      const v = sampleScalarGrid(g.deltaTemp24h, x, y);
      const warmCut = tempUnit === "F" ? 4 : 2;
      const coolCut = tempUnit === "F" ? -4 : -2;
      const hidden = v != null && !(v > warmCut || v < coolCut);
      rows.push({
        label: `24h Temp Change (°${tempUnit})`,
        value: v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (derivedOverlays.deltaDewpoint24h) {
      const v = sampleScalarGrid(g.deltaDewpoint24h, x, y);
      const warmCut = tempUnit === "F" ? 4 : 2;
      const coolCut = tempUnit === "F" ? -4 : -2;
      const hidden = v != null && !(v > warmCut || v < coolCut);
      rows.push({
        label: `24h Dewpoint Change (°${tempUnit})`,
        value: v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (derivedOverlays.deltaThetaE24h) {
      const v = sampleScalarGrid(g.deltaThetaE24h, x, y);
      const hidden = v != null && !(v > 2 || v < -2);
      rows.push({
        label: "24h Theta-e Change (K)",
        value: v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (derivedOverlays.moistureConvergence) {
      const v = sampleScalarGrid(g.moistureConvergence, x, y);
      const hidden = v != null && v < 1;
      rows.push({
        label: "Moisture Conv. (x10⁷ s⁻¹)",
        value: v == null ? "—" : `${v.toFixed(2)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (mrmsField !== "none") {
      const precision = mrmsField === "rotation240" ? 3 : 1;
      rows.push({
        label: `MRMS ${getMrmsProductLabel(mrmsField)} (${getMrmsProductUnit(mrmsField)})`,
        value: mrmsCursorValue == null ? "—" : mrmsCursorValue.toFixed(precision),
      });
    }

    return rows;
  }, [
    cursorProbe,
    showCursorDiagnostics,
    analysisOverlays,
    derivedOverlays,
    tempUnit,
    windUnit,
    mrmsField,
    mrmsCursorValue,
  ]);

  const activeFrameIso = useMemo(() => {
    if (timelineMode === "history") {
      const t = availableTimes[timeIndex];
      if (t) return t;
    }
    return lastUpdate;
  }, [timelineMode, availableTimes, timeIndex, lastUpdate]);

  useEffect(() => {
    let cancelled = false;
    if (!activeFrameIso) {
      setChangeBaselineObs([]);
      setChangeBaselineIso(null);
      return;
    }

    const targetMs = new Date(activeFrameIso).getTime() - CHANGE_WINDOW_HOURS * 60 * 60 * 1000;
    if (!Number.isFinite(targetMs)) {
      setChangeBaselineObs([]);
      setChangeBaselineIso(null);
      return;
    }

    const targetIso = new Date(targetMs).toISOString();

    (async () => {
      const baseline = await fetchObsSnapshot(targetIso);
      if (cancelled) return;
      setChangeBaselineObs(baseline);
      setChangeBaselineIso(targetIso);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeFrameIso, fetchObsSnapshot]);

  const changeBaselineById = useMemo(() => {
    const m = new Map<string, SurfaceObs>();
    for (const s of changeBaselineObs) m.set(s.id, s);
    return m;
  }, [changeBaselineObs]);

  const validTimeLabel = useMemo(
    () => formatValidTimeLabel(activeFrameIso, displayTimeZone),
    [activeFrameIso, displayTimeZone]
  );

  const refreshMrmsMeta = useCallback(async () => {
    if (mrmsField === "none") {
      setMrmsMeta(null);
      setMrmsError(null);
      return;
    }
    const targetTime = activeFrameIso ?? new Date().toISOString();
    try {
      const res = await fetch(`/api/mrms/meta?product=${encodeURIComponent(mrmsField)}&time=${encodeURIComponent(targetTime)}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as MrmsMetaResponse;
      setMrmsMeta(data);
      setMrmsError(null);
    } catch (e: any) {
      setMrmsMeta(null);
      setMrmsError(e?.message ?? "Failed to load MRMS metadata");
    }
  }, [mrmsField, activeFrameIso]);

  useEffect(() => {
    refreshMrmsMeta();
  }, [refreshMrmsMeta]);

  useEffect(() => {
    if (!showCursorDiagnostics || mrmsField === "none" || !mrmsMeta || !cursorProbe) {
      setMrmsCursorValue(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          product: mrmsField,
          time: mrmsMeta.matched_time,
          lat: cursorProbe.lat.toFixed(5),
          lon: cursorProbe.lng.toFixed(5),
        });
        const res = await fetch(`/api/mrms/value?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) {
          setMrmsCursorValue(null);
          return;
        }
        const data = (await res.json()) as MrmsValueResponse;
        const sampled = data.value != null ? data.value : data.value_dbz;
        setMrmsCursorValue(sampled == null || !Number.isFinite(sampled) ? null : sampled);
      } catch (e: any) {
        if (e?.name !== "AbortError") setMrmsCursorValue(null);
      }
    }, 120);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    showCursorDiagnostics,
    mrmsField,
    mrmsMeta,
    cursorProbe?.lat,
    cursorProbe?.lng,
  ]);

  const refreshWpcSurface = useCallback(async () => {
    if (nwsProduct !== "wpcSurface") {
      setWpcSurface(null);
      setWpcError(null);
      return;
    }
    try {
      const res = await fetch("/api/nws/wpc_surface/latest");
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as WpcSurfaceResponse;
      setWpcSurface(data);
      setWpcError(null);
    } catch (e: any) {
      setWpcSurface(null);
      setWpcError(e?.message ?? "Failed to load WPC surface analysis");
    }
  }, [nwsProduct]);

  useEffect(() => {
    refreshWpcSurface();
    if (nwsProduct !== "wpcSurface") return;
    const id = window.setInterval(refreshWpcSurface, 10 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [nwsProduct, refreshWpcSurface]);

  const refreshOpsSummary = useCallback(async () => {
    setOpsLoading(true);
    try {
      const res = await fetch("/api/ops/summary");
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as OpsSummaryResponse;
      setOpsSummary(data);
      setOpsError(null);
    } catch (e: any) {
      setOpsError(e?.message ?? "Failed to load API diagnostics");
    } finally {
      setOpsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpsOpen) return;
    refreshOpsSummary();
    const id = window.setInterval(refreshOpsSummary, 15000);
    return () => window.clearInterval(id);
  }, [isOpsOpen, refreshOpsSummary]);

  const [isOptionsOpen, setIsOptionsOpen] = useState(false);

  const mrmsTileTemplate = useMemo(() => {
    if (mrmsField === "none" || !mrmsMeta) return null;
    const base =
      mrmsMeta.tile_url_template ??
      `/api/mrms/tile/{z}/{x}/{y}.png?product=${encodeURIComponent(mrmsField)}&time=${encodeURIComponent(
        mrmsMeta.matched_time
      )}`;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}cb=${encodeURIComponent(mrmsMeta.matched_time)}`;
  }, [mrmsField, mrmsMeta]);

  const mrmsRasterLayer: any = useMemo(
    () => ({
      id: "mrms-raster-layer",
      type: "raster",
      source: "mrms-raster-tiles",
      maxzoom: 10,
      paint: {
        "raster-opacity": 0.78,
        "raster-resampling": "nearest",
      },
    }),
    []
  );

  const wpcFrontBaseWidth: any = useMemo(
    () => [
      "interpolate",
      ["linear"],
      ["zoom"],
      3, 2.2,
      6, 2.6,
      9, 3.0,
    ],
    []
  );

  const wpcFrontColdLayer: any = useMemo(
    () => ({
      id: "wpc-fronts-cold-layer",
      type: "line",
      source: "wpc-fronts",
      filter: ["==", ["get", "feature"], "COLD"],
      paint: {
        "line-color": "#2563eb",
        "line-width": wpcFrontBaseWidth,
      },
    }),
    [wpcFrontBaseWidth]
  );

  const wpcFrontWarmLayer: any = useMemo(
    () => ({
      id: "wpc-fronts-warm-layer",
      type: "line",
      source: "wpc-fronts",
      filter: ["==", ["get", "feature"], "WARM"],
      paint: {
        "line-color": "#dc2626",
        "line-width": wpcFrontBaseWidth,
      },
    }),
    [wpcFrontBaseWidth]
  );

  const wpcFrontOccludedLayer: any = useMemo(
    () => ({
      id: "wpc-fronts-occluded-layer",
      type: "line",
      source: "wpc-fronts",
      filter: ["==", ["get", "feature"], "OCFNT"],
      paint: {
        "line-color": "#7c3aed",
        "line-width": wpcFrontBaseWidth,
      },
    }),
    [wpcFrontBaseWidth]
  );

  const wpcFrontStationaryLayer: any = useMemo(
    () => ({
      id: "wpc-fronts-stationary-layer",
      type: "line",
      source: "wpc-fronts",
      filter: ["==", ["get", "feature"], "STNRY"],
      paint: {
        "line-color": "#a855f7",
        "line-width": wpcFrontBaseWidth,
        "line-dasharray": [5, 3],
      },
    }),
    [wpcFrontBaseWidth]
  );

  const wpcFrontTroughLayer: any = useMemo(
    () => ({
      id: "wpc-fronts-trough-layer",
      type: "line",
      source: "wpc-fronts",
      filter: ["==", ["get", "feature"], "TROF"],
      paint: {
        "line-color": "#92400e",
        "line-width": wpcFrontBaseWidth,
        "line-dasharray": [2, 2],
      },
    }),
    [wpcFrontBaseWidth]
  );

  const wpcFrontDrylineLayer: any = useMemo(
    () => ({
      id: "wpc-fronts-dryline-layer",
      type: "line",
      source: "wpc-fronts",
      filter: ["==", ["get", "feature"], "DRYLINE"],
      paint: {
        "line-color": "#b45309",
        "line-width": wpcFrontBaseWidth,
        "line-dasharray": [4, 4],
      },
    }),
    [wpcFrontBaseWidth]
  );

  const wpcCenterLayer: any = useMemo(
    () => ({
      id: "wpc-centers-layer",
      type: "symbol",
      source: "wpc-centers",
      layout: {
        "text-field": [
          "case",
          ["==", ["get", "feature"], "HIGH"], "H",
          ["==", ["get", "feature"], "LOW"], "L",
          "",
        ],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3, 32,
          8, 40,
        ],
        "text-font": ["Open Sans Bold"],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": [
          "case",
          ["==", ["get", "feature"], "HIGH"], "#2563eb",
          ["==", ["get", "feature"], "LOW"], "#dc2626",
          "#111827",
        ],
        "text-halo-color": "rgba(255,255,255,0.95)",
        "text-halo-width": 1.2,
      },
    }),
    []
  );

  const wpcCenterPressureLayer: any = useMemo(
    () => ({
      id: "wpc-centers-pressure-layer",
      type: "symbol",
      source: "wpc-centers",
      layout: {
        "text-field": [
          "case",
          ["!=", ["get", "strength"], null],
          ["to-string", ["get", "strength"]],
          "",
        ],
        "text-size": 11,
        "text-font": ["Open Sans Semibold"],
        "text-offset": [0.0, 1.35],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#111827",
        "text-halo-color": "rgba(255,255,255,0.95)",
        "text-halo-width": 1.0,
      },
    }),
    []
  );

  const [geographyOverlays, setGeographyOverlays] = useState<GeographyOverlaySet>(() => {
    const saved = localStorage.getItem("geographyOverlays");
    if (saved) {
      try {
        const obj = JSON.parse(saved) as Partial<GeographyOverlaySet>;
        return {
          adm0: !!obj.adm0,
          adm1: !!obj.adm1,
          adm2: !!obj.adm2,
          artcc: !!obj.artcc,
        };
      } catch {}
    }
    return { adm0: true, adm1: true, adm2: false, artcc: false };
  });

  const adm0BoundaryLayer: any = useMemo(
    () => ({
      id: "adm0-boundaries-layer",
      type: "line",
      source: "adm0-boundaries",
      paint: {
        "line-color": "rgba(17, 24, 39, 0.9)",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 1.0,
          5, 1.4,
          8, 2.0,
        ],
        "line-opacity": 0.78,
      },
    }),
    []
  );

  const adm1BoundaryLayer: any = useMemo(
    () => ({
      id: "adm1-boundaries-layer",
      type: "line",
      source: "adm1-boundaries",
      paint: {
        "line-color": "rgba(30, 41, 59, 0.72)",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 0.35,
          5, 0.55,
          8, 0.9,
        ],
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 0.36,
          4, 0.56,
          8, 0.8,
        ],
      },
    }),
    []
  );

  const adm2BoundaryLayer: any = useMemo(
    () => ({
      id: "adm2-boundaries-layer",
      type: "line",
      source: "adm2-boundaries",
      paint: {
        "line-color": "rgba(51, 65, 85, 0.52)",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4, 0.2,
          7, 0.3,
          10, 0.55,
        ],
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4, 0.12,
          6, 0.2,
          8, 0.38,
          10, 0.55,
        ],
      },
    }),
    []
  );

  const artccBoundaryLayer: any = useMemo(
    () => ({
      id: "artcc-boundaries-layer",
      type: "line",
      source: "artcc-boundaries",
      paint: {
        "line-color": "rgba(0, 0, 0, 0.9)",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 1.4,
          5, 2.1,
          8, 2.8,
          10, 3.4,
        ],
        "line-opacity": 0.92,
      },
    }),
    []
  );

type Pt = { x: number; y: number };

function interp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// Marching squares for one contour level.
// gridVals is row-major: gridVals[j * nx + i]
function contoursForLevel(
  gridVals: Float32Array,
  nx: number,
  ny: number,
  step: number,
  level: number
): Pt[][] {
  const lines: Pt[][] = [];

  const idx = (i: number, j: number) => j * nx + i;

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v0 = gridVals[idx(i, j)];
      const v1 = gridVals[idx(i + 1, j)];
      const v2 = gridVals[idx(i + 1, j + 1)];
      const v3 = gridVals[idx(i, j + 1)];

      // Skip cells with missing data
      if (!Number.isFinite(v0) || !Number.isFinite(v1) || !Number.isFinite(v2) || !Number.isFinite(v3)) {
        continue;
      }

      // bitmask: 1,2,4,8 for corners >= level
      let c = 0;
      if (v0 >= level) c |= 1;
      if (v1 >= level) c |= 2;
      if (v2 >= level) c |= 4;
      if (v3 >= level) c |= 8;

      if (c === 0 || c === 15) continue;

      const x = i * step;
      const y = j * step;

      // Edge interpolation helpers (avoid divide by zero)
      const t01 = (level - v0) / (v1 - v0 || 1e-9);
      const t12 = (level - v1) / (v2 - v1 || 1e-9);
      const t23 = (level - v2) / (v3 - v2 || 1e-9);
      const t30 = (level - v3) / (v0 - v3 || 1e-9);

      const p01: Pt = { x: x + interp(0, step, t01), y: y };
      const p12: Pt = { x: x + step, y: y + interp(0, step, t12) };
      const p23: Pt = { x: x + interp(step, 0, t23), y: y + step };
      const p30: Pt = { x: x, y: y + interp(step, 0, t30) };

      // Cases as line segments. (We return short segments; that’s fine for v1.)
      // If you want joined polylines later, we can stitch segments.
      switch (c) {
        case 1:  lines.push([p30, p01]); break;
        case 2:  lines.push([p01, p12]); break;
        case 3:  lines.push([p30, p12]); break;
        case 4:  lines.push([p12, p23]); break;
        case 5:  lines.push([p30, p23], [p01, p12]); break; // ambiguous saddle
        case 6:  lines.push([p01, p23]); break;
        case 7:  lines.push([p30, p23]); break;
        case 8:  lines.push([p23, p30]); break;
        case 9:  lines.push([p01, p23]); break;
        case 10: lines.push([p01, p30], [p12, p23]); break; // ambiguous saddle
        case 11: lines.push([p12, p23]); break;
        case 12: lines.push([p12, p30]); break;
        case 13: lines.push([p01, p12]); break;
        case 14: lines.push([p30, p01]); break;
      }
    }
  }

  return lines;
}

function strokeIsotherms(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][],
  level: number,
  freezingLevel: number
) {
  const belowFreezing = level < freezingLevel;
  const isFreezing = Math.abs(level - freezingLevel) < 1e-6;

  ctx.save();

  if (isFreezing) {
    ctx.strokeStyle = "#0000ff"; // dark blue
    ctx.lineWidth = 2.6;
    ctx.setLineDash([]); // solid
  } else if (belowFreezing) {
    ctx.strokeStyle = "#2563eb"; // blue
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 5]); // dashed
  } else {
    ctx.strokeStyle = "#dc2626"; // dark
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 5]); // dashed
  }

  for (const seg of segments) {
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    for (let k = 1; k < seg.length; k++) ctx.lineTo(seg[k].x, seg[k].y);
    ctx.stroke();
  }

  ctx.restore();
}

function strokeIsodrosotherms(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][],
  level: number
) {
  ctx.save();
  ctx.strokeStyle = "#14532d"; // dark green
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 6]); // dotted-ish (tweak: [2,6] if too faint)

  for (const seg of segments) {
    if (!seg) continue;
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
    ctx.stroke();
  }

  ctx.restore();
}

function strokeIsobars(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][],
  level: number
) {
  ctx.save();
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 2.6;
  ctx.setLineDash([]); // solid

  for (const seg of segments) {
    if (!seg || seg.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
    ctx.stroke();
  }

  ctx.restore();
}

function strokeMixingRatioContours(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][]
) {
  ctx.save();
  ctx.strokeStyle = "#14532d";
  ctx.lineWidth = 3.0;
  ctx.setLineDash([]);

  for (const seg of segments) {
    if (!seg || seg.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
    ctx.stroke();
  }

  ctx.restore();
}

function strokeThetaEContours(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][]
) {
  ctx.save();
  ctx.strokeStyle = "#15803d";
  ctx.lineWidth = 1.2;
  ctx.setLineDash([]);

  for (const seg of segments) {
    if (!seg || seg.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
    ctx.stroke();
  }

  ctx.restore();
}

function strokeMoistureConvergenceContours(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][]
) {
  ctx.save();
  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = 2.6;
  ctx.setLineDash([]);

  for (const seg of segments) {
    if (!seg || seg.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
    ctx.stroke();
  }

  ctx.restore();
}

type LabelMode = "temp" | "dewpoint" | "slp" | "mixingRatio" | "thetaE";
function labelContours(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][],
  level: number,
  mode: LabelMode,
  opts: { tempUnit: "F" | "C"; freezingLevel?: number }
) {
  const tempUnit = opts.tempUnit;
  const freezingLevel = opts.freezingLevel ?? (tempUnit === "F" ? 32 : 0);

  // Color/text by mode
  let labelColor = "#111827";
  let text = "";

  if (mode === "temp") {
    const belowFreezing = level < freezingLevel;
    const isFreezing = Math.abs(level - freezingLevel) < 1e-6;
    labelColor = isFreezing ? "#111827" : belowFreezing ? "#2563eb" : "#dc2626";
    text = `${Math.round(level)}°${tempUnit}`;
  } else if (mode === "dewpoint") {
    labelColor = "#14532d";
    text = `${Math.round(level)}°${tempUnit}`;
  } else if (mode === "mixingRatio") {
    labelColor = "#14532d";
    text = `${Math.round(level)} g/kg`;
  } else if (mode === "thetaE") {
    labelColor = "#15803d";
    text = `${Math.round(level)}K`;
  } else {
    // slp
    labelColor = "#111827";
    text = `${Math.round(level)}`; // mb
  }

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.setLineDash([]);
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const maxLabels = 5;
  const minLen = 30;

  // Build candidates from segment endpoints
  const candidates: Array<{ a: Pt; b: Pt; len: number }> = [];
  for (const seg of segments) {
    if (!seg || seg.length < 2) continue;
    const a = seg[0];
    const b = seg[seg.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= minLen) candidates.push({ a, b, len });
  }
  if (candidates.length === 0) {
    ctx.restore();
    return;
  }

  candidates.sort((a, b) => b.len - a.len);

  for (let i = 0; i < candidates.length && i < maxLabels; i++) {
    const { a, b } = candidates[i];

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;

    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle < -Math.PI / 2) angle += Math.PI;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);

    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(text, 0, 0);

    ctx.fillStyle = labelColor;
    ctx.fillText(text, 0, 0);

    ctx.restore();
  }

  ctx.restore();
}

// Draw the analysis overlay on the canvas
const drawAnalysisOverlay = useCallback(() => {
  if (!anyAnalysisLikeOverlayOn) {
    analysisGridRef.current = {};
    return;
  }

  const canvas = analysisCanvasRef.current;
  const mapObj = mapRef.current?.getMap();
  if (!canvas || !mapObj) return;

  const map = mapObj;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx0 = canvas.getContext("2d");
  if (!ctx0) return;
  const ctx = ctx0;

  // Work in CSS pixel space
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const ANALYSIS_ALPHA = 0.6;
  ctx.globalAlpha = ANALYSIS_ALPHA;

  // Use declutteredObs as requested
  const stations = declutteredObs;
  if (!stations || stations.length === 0) {
    analysisGridRef.current = {};
    return;
  }

  // Performance knobs (contours are heavier than shading)
  const step = 24;          // grid spacing in pixels; 20–32 is typical
  const power = 2;
  const maxRadius = 200;    // px search radius
  const maxRadius2 = maxRadius * maxRadius;
  const kMax = 10;
  const windStep = 42;
  const computedGrids: AnalysisGridStore = {};

  function windFillColorForSpeedKt(spdKt: number): string {
    const value = knotsToWindUnit(spdKt, windUnit);
    const thresholds = getWindFillThresholds(windUnit);
    for (let i = 1; i < thresholds.length; i++) {
      if (value < thresholds[i]) return WIND_FILL_COLORS[i - 1];
    }
    return WIND_FILL_COLORS[WIND_FILL_COLORS.length - 1];
  }

  function drawWindSpeedFill() {
    const pts: Array<{ x: number; y: number; val: number }> = [];
    for (const s of declutteredObs) {
      if (isExcludedFromAnalysis(s, "wind")) continue;
      if (s.windSpeedKt == null) continue;
      const p = map.project([s.lon, s.lat]);
      pts.push({ x: p.x, y: p.y, val: s.windSpeedKt });
    }
    if (pts.length < 3) return;

    const fillStep = 6;
    const nx = Math.floor(width / fillStep) + 1;
    const ny = Math.floor(height / fillStep) + 1;
    const gridVals = new Float32Array(nx * ny);
    gridVals.fill(Number.NaN);

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const gx = i * fillStep;
        const gy = j * fillStep;

        const neighbors: Array<{ d2: number; val: number }> = [];
        for (const p of pts) {
          const dx = p.x - gx;
          const dy = p.y - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxRadius2) continue;

          let inserted = false;
          for (let k = 0; k < neighbors.length; k++) {
            if (d2 < neighbors[k].d2) {
              neighbors.splice(k, 0, { d2, val: p.val });
              inserted = true;
              break;
            }
          }
          if (!inserted) neighbors.push({ d2, val: p.val });
          if (neighbors.length > kMax) neighbors.pop();
        }

        if (neighbors.length < 3) continue;

        let wSum = 0;
        let vSum = 0;
        for (const n of neighbors) {
          const w = 1 / Math.pow(Math.max(n.d2, 9), power / 2);
          wSum += w;
          vSum += w * n.val;
        }
        if (wSum <= 0) continue;

        gridVals[j * nx + i] = vSum / wSum;
      }
    }
    computedGrids.windSpeed = { values: gridVals, nx, ny, step: fillStep };

    ctx.save();
    ctx.globalAlpha = 0.46;
    ctx.setLineDash([]);
    const offscreen = document.createElement("canvas");
    offscreen.width = nx;
    offscreen.height = ny;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) {
      ctx.restore();
      return;
    }
    const image = offCtx.createImageData(nx, ny);
    const data = image.data;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        const v = gridVals[idx];
        const p = idx * 4;
        if (!Number.isFinite(v)) {
          data[p + 3] = 0;
          continue;
        }
        const color = windFillColorForSpeedKt(v);
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
      }
    }
    offCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(offscreen, 0, 0, nx, ny, 0, 0, width, height);
    ctx.restore();
  }

  function scalarFillColorForCeilingHundreds(ceilingHundreds: number): string | null {
    if (!Number.isFinite(ceilingHundreds) || ceilingHundreds < 0 || ceilingHundreds > 50) return null;
    const upperBounds = CEILING_LEVELS_HUNDREDS_FT.slice(1);
    for (let i = 0; i < upperBounds.length; i++) {
      if (ceilingHundreds <= upperBounds[i]) return CEILING_FILL_COLORS[i];
    }
    return null;
  }

  function scalarFillColorForVisibilityMi(visibilityMi: number): string | null {
    if (!Number.isFinite(visibilityMi) || visibilityMi < 0 || visibilityMi > 6) return null;
    const upperBounds = VISIBILITY_LEVELS_SM.slice(1);
    for (let i = 0; i < upperBounds.length; i++) {
      if (visibilityMi <= upperBounds[i]) return VISIBILITY_FILL_COLORS[i];
    }
    return null;
  }

  function scalarFillColorForRelativeHumidity(relativeHumidity: number): string | null {
    if (!Number.isFinite(relativeHumidity) || relativeHumidity < 0 || relativeHumidity > 100) return null;
    if (relativeHumidity < 25) {
      if (relativeHumidity <= RH_DRY_LEVELS[1]) return RH_DRY_COLORS[0];
      if (relativeHumidity <= RH_DRY_LEVELS[2]) return RH_DRY_COLORS[1];
      return RH_DRY_COLORS[2];
    }
    if (relativeHumidity > 90) {
      if (relativeHumidity <= RH_MOIST_LEVELS[1]) return RH_MOIST_COLORS[0];
      return RH_MOIST_COLORS[1];
    }
    return null;
  }

  function scalarFillColorForDeltaSlp24h(v: number): string | null {
    if (!(v > 4 || v < -4)) return null;
    return divergingColorForDelta(
      v,
      DELTA_SLP_NEG_CUTS,
      DELTA_SLP_POS_CUTS,
      DELTA_SLP_NEG_COLORS,
      DELTA_SLP_POS_COLORS
    );
  }

  function scalarFillColorForDeltaTemp24h(v: number): string | null {
    const warmCut = tempUnit === "F" ? 4 : 2;
    const coolCut = tempUnit === "F" ? -4 : -2;
    if (!(v > warmCut || v < coolCut)) return null;
    const cuts = tempUnit === "F" ? DELTA_TEMP_CUTS_F : DELTA_TEMP_CUTS_C;
    return divergingColorForDelta(
      v,
      cuts.neg,
      cuts.pos,
      DELTA_TEMP_NEG_COLORS,
      DELTA_TEMP_POS_COLORS
    );
  }

  function scalarFillColorForDeltaDewpoint24h(v: number): string | null {
    const warmCut = tempUnit === "F" ? 4 : 2;
    const coolCut = tempUnit === "F" ? -4 : -2;
    if (!(v > warmCut || v < coolCut)) return null;
    const cuts = tempUnit === "F" ? DELTA_TEMP_CUTS_F : DELTA_TEMP_CUTS_C;
    return divergingColorForDelta(
      v,
      cuts.neg,
      cuts.pos,
      DELTA_DEWPOINT_NEG_COLORS,
      DELTA_DEWPOINT_POS_COLORS
    );
  }

  function scalarFillColorForDeltaThetaE24h(v: number): string | null {
    if (!(v > 2 || v < -2)) return null;
    return divergingColorForDelta(
      v,
      DELTA_THETAE_NEG_CUTS,
      DELTA_THETAE_POS_CUTS,
      DELTA_THETAE_NEG_COLORS,
      DELTA_THETAE_POS_COLORS
    );
  }

  function drawScalarFill(
    pts: Array<{ x: number; y: number; val: number }>,
    colorFn: (value: number) => string | null,
    alpha = 0.44,
    radiusPx = 120,
    minNeighbors = 4,
  ): ScalarGrid | null {
    if (pts.length < 3) return null;

    const fillStep = 6;
    const nx = Math.floor(width / fillStep) + 1;
    const ny = Math.floor(height / fillStep) + 1;
    const gridVals = new Float32Array(nx * ny);
    gridVals.fill(Number.NaN);
    const localMaxRadius2 = radiusPx * radiusPx;

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const gx = i * fillStep;
        const gy = j * fillStep;

        const neighbors: Array<{ d2: number; val: number }> = [];
        for (const p of pts) {
          const dx = p.x - gx;
          const dy = p.y - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > localMaxRadius2) continue;

          let inserted = false;
          for (let k = 0; k < neighbors.length; k++) {
            if (d2 < neighbors[k].d2) {
              neighbors.splice(k, 0, { d2, val: p.val });
              inserted = true;
              break;
            }
          }
          if (!inserted) neighbors.push({ d2, val: p.val });
          if (neighbors.length > kMax) neighbors.pop();
        }

        if (neighbors.length < minNeighbors) continue;

        let wSum = 0;
        let vSum = 0;
        for (const n of neighbors) {
          const w = 1 / Math.pow(Math.max(n.d2, 9), power / 2);
          wSum += w;
          vSum += w * n.val;
        }
        if (wSum <= 0) continue;

        gridVals[j * nx + i] = vSum / wSum;
      }
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setLineDash([]);

    const offscreen = document.createElement("canvas");
    offscreen.width = nx;
    offscreen.height = ny;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) {
      ctx.restore();
      return null;
    }

    const image = offCtx.createImageData(nx, ny);
    const data = image.data;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        const v = gridVals[idx];
        const p = idx * 4;
        if (!Number.isFinite(v)) {
          data[p + 3] = 0;
          continue;
        }
        const color = colorFn(v);
        if (!color) {
          data[p + 3] = 0;
          continue;
        }

        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
      }
    }

    offCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(offscreen, 0, 0, nx, ny, 0, 0, width, height);
    ctx.restore();
    return { values: gridVals, nx, ny, step: fillStep };
  }

  function drawCeilingFill() {
    const pts: Array<{ x: number; y: number; val: number }> = [];
    for (const s of declutteredObs) {
      if (isExcludedFromAnalysis(s, "ceiling")) continue;
      // Use high fallback for "no reported ceiling" so low-ceiling pockets stay localized.
      const ceilingHundreds = s.ceilingFt == null ? 100 : s.ceilingFt / 100;
      const p = map.project([s.lon, s.lat]);
      pts.push({ x: p.x, y: p.y, val: ceilingHundreds });
    }
    const grid = drawScalarFill(pts, scalarFillColorForCeilingHundreds, 0.44, 110, 4);
    if (grid) computedGrids.ceiling = grid;
  }

  function drawVisibilityFill() {
    const pts: Array<{ x: number; y: number; val: number }> = [];
    for (const s of declutteredObs) {
      if (isExcludedFromAnalysis(s, "visibility")) continue;
      if (s.visibilityMi == null) continue;
      const p = map.project([s.lon, s.lat]);
      pts.push({ x: p.x, y: p.y, val: s.visibilityMi });
    }
    const grid = drawScalarFill(pts, scalarFillColorForVisibilityMi, 0.44, 110, 4);
    if (grid) computedGrids.visibility = grid;
  }

  function drawRelativeHumidityFill() {
    const pts: Array<{ x: number; y: number; val: number }> = [];
    for (const s of declutteredObs) {
      if (isExcludedFromAnalysis(s, "humidity") || isExcludedFromAnalysis(s, "relativeHumidity")) continue;
      if (s.relativeHumidity == null) continue;
      const p = map.project([s.lon, s.lat]);
      pts.push({ x: p.x, y: p.y, val: s.relativeHumidity });
    }
    const grid = drawScalarFill(pts, scalarFillColorForRelativeHumidity, 0.44, 110, 4);
    if (grid) computedGrids.relativeHumidity = grid;
  }

  function collectDeltaStationPoints(
    compute: (current: SurfaceObs, baseline: SurfaceObs) => number | null
  ): Array<{ x: number; y: number; val: number }> {
    const pts: Array<{ x: number; y: number; val: number }> = [];
    for (const current of declutteredObs) {
      const baseline = changeBaselineById.get(current.id);
      if (!baseline) continue;
      const val = compute(current, baseline);
      if (!Number.isFinite(val)) continue;
      const p = map.project([current.lon, current.lat]);
      pts.push({ x: p.x, y: p.y, val });
    }
    return pts;
  }

  function drawDeltaSlp24hFill() {
    const pts = collectDeltaStationPoints((current, baseline) => {
      if (isExcludedFromAnalysis(current, "slp") || isExcludedFromAnalysis(baseline, "slp")) return null;
      if (current.pressureMb == null || baseline.pressureMb == null) return null;
      return current.pressureMb - baseline.pressureMb;
    });
    const grid = drawScalarFill(pts, scalarFillColorForDeltaSlp24h, 0.48, 130, 4);
    if (grid) computedGrids.deltaSlp24h = grid;
  }

  function drawDeltaTemp24hFill() {
    const pts = collectDeltaStationPoints((current, baseline) => {
      if (isExcludedFromAnalysis(current, "temp") || isExcludedFromAnalysis(baseline, "temp")) return null;
      if (current.tempC == null || baseline.tempC == null) return null;
      const deltaC = current.tempC - baseline.tempC;
      return tempUnit === "F" ? deltaC * (9 / 5) : deltaC;
    });
    const grid = drawScalarFill(pts, scalarFillColorForDeltaTemp24h, 0.48, 130, 4);
    if (grid) computedGrids.deltaTemp24h = grid;
  }

  function drawDeltaDewpoint24hFill() {
    const pts = collectDeltaStationPoints((current, baseline) => {
      if (isExcludedFromAnalysis(current, "dewpoint") || isExcludedFromAnalysis(baseline, "dewpoint")) return null;
      if (current.dewpointC == null || baseline.dewpointC == null) return null;
      const deltaC = current.dewpointC - baseline.dewpointC;
      return tempUnit === "F" ? deltaC * (9 / 5) : deltaC;
    });
    const grid = drawScalarFill(pts, scalarFillColorForDeltaDewpoint24h, 0.48, 130, 4);
    if (grid) computedGrids.deltaDewpoint24h = grid;
  }

  function drawDeltaThetaE24hFill() {
    const pts = collectDeltaStationPoints((current, baseline) => {
      if (
        isExcludedFromAnalysis(current, "temp")
        || isExcludedFromAnalysis(current, "dewpoint")
        || isExcludedFromAnalysis(current, "slp")
        || isExcludedFromAnalysis(baseline, "temp")
        || isExcludedFromAnalysis(baseline, "dewpoint")
        || isExcludedFromAnalysis(baseline, "slp")
      ) return null;
      if (current.tempC == null || current.dewpointC == null || current.pressureMb == null) return null;
      if (baseline.tempC == null || baseline.dewpointC == null || baseline.pressureMb == null) return null;
      const currentThetaE = equivalentPotentialTemperatureK(current.tempC, current.dewpointC, current.pressureMb);
      const baselineThetaE = equivalentPotentialTemperatureK(baseline.tempC, baseline.dewpointC, baseline.pressureMb);
      if (currentThetaE == null || baselineThetaE == null) return null;
      return currentThetaE - baselineThetaE;
    });
    const grid = drawScalarFill(pts, scalarFillColorForDeltaThetaE24h, 0.48, 130, 4);
    if (grid) computedGrids.deltaThetaE24h = grid;
  }

  function drawMoistureConvergenceContours() {
    const pts: Array<{ x: number; y: number; u: number; v: number; q: number }> = [];
    for (const s of declutteredObs) {
      if (isExcludedFromAnalysis(s, "wind")) continue;
      if (isExcludedFromAnalysis(s, "dewpoint") || isExcludedFromAnalysis(s, "slp")) continue;
      if (s.windDirDeg == null || s.windSpeedKt == null) continue;
      if (s.dewpointC == null || s.pressureMb == null) continue;

      const wGkg = mixingRatioGkgFromDewpointPressure(s.dewpointC, s.pressureMb);
      if (wGkg == null) continue;
      const r = wGkg / 1000; // kg/kg
      const q = r / (1 + r); // specific humidity (kg/kg)
      if (!Number.isFinite(q) || q <= 0) continue;

      const p = map.project([s.lon, s.lat]);
      const uvKt = windToUV(s.windDirDeg, s.windSpeedKt);
      const u = uvKt.u * 0.514444;
      const v = uvKt.v * 0.514444;
      pts.push({ x: p.x, y: p.y, u, v, q });
    }
    if (pts.length < 6) return;

    const convStep = 12;
    const nx = Math.floor(width / convStep) + 1;
    const ny = Math.floor(height / convStep) + 1;
    // Stronger pre-smoothing for moisture convergence inputs (u/v/q).
    const radiusPx = 190;
    const minNeighbors = 7;
    const kMaxMoist = 16;
    const interpPower = 1.35;
    const localMaxRadius2 = radiusPx * radiusPx;

    const gridU = new Float32Array(nx * ny);
    const gridV = new Float32Array(nx * ny);
    const gridQ = new Float32Array(nx * ny);
    gridU.fill(Number.NaN);
    gridV.fill(Number.NaN);
    gridQ.fill(Number.NaN);

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const gx = i * convStep;
        const gy = j * convStep;
        const neighbors: Array<{ d2: number; u: number; v: number; q: number }> = [];

        for (const p of pts) {
          const dx = p.x - gx;
          const dy = p.y - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > localMaxRadius2) continue;

          let inserted = false;
          for (let k = 0; k < neighbors.length; k++) {
            if (d2 < neighbors[k].d2) {
              neighbors.splice(k, 0, { d2, u: p.u, v: p.v, q: p.q });
              inserted = true;
              break;
            }
          }
          if (!inserted) neighbors.push({ d2, u: p.u, v: p.v, q: p.q });
          if (neighbors.length > kMaxMoist) neighbors.pop();
        }

        if (neighbors.length < minNeighbors) continue;

        let wSum = 0;
        let uSum = 0;
        let vSum = 0;
        let qSum = 0;
        for (const n of neighbors) {
          const w = 1 / Math.pow(Math.max(n.d2, 9), interpPower / 2);
          wSum += w;
          uSum += w * n.u;
          vSum += w * n.v;
          qSum += w * n.q;
        }
        if (wSum <= 0) continue;

        const idx = j * nx + i;
        gridU[idx] = uSum / wSum;
        gridV[idx] = vSum / wSum;
        gridQ[idx] = qSum / wSum;
      }
    }

    const center = map.unproject([width / 2, height / 2]);
    const east = map.unproject([width / 2 + 1, height / 2]);
    const north = map.unproject([width / 2, height / 2 - 1]);
    const metersPerPixelX = Math.max(1, haversineMeters(center.lat, center.lng, center.lat, east.lng));
    const metersPerPixelY = Math.max(1, haversineMeters(center.lat, center.lng, north.lat, center.lng));
    const dxM = convStep * metersPerPixelX;
    const dyM = convStep * metersPerPixelY;

    const fullVals = new Float32Array(nx * ny);
    const displayVals = new Float32Array(nx * ny);
    fullVals.fill(Number.NaN);
    displayVals.fill(Number.NaN);

    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const idx = j * nx + i;
        const idxL = j * nx + (i - 1);
        const idxR = j * nx + (i + 1);
        const idxN = (j - 1) * nx + i;
        const idxS = (j + 1) * nx + i;

        const uL = gridU[idxL];
        const uR = gridU[idxR];
        const vN = gridV[idxN];
        const vS = gridV[idxS];
        const q = gridQ[idx];
        if (!Number.isFinite(uL) || !Number.isFinite(uR) || !Number.isFinite(vN) || !Number.isFinite(vS) || !Number.isFinite(q)) {
          continue;
        }

        const duDx = (uR - uL) / (2 * dxM);
        const dvDy = (vN - vS) / (2 * dyM);
        const convergence = -(duDx + dvDy); // positive in convergent flow
        if (!Number.isFinite(convergence)) continue;

        const moistureConvergence = q * convergence; // s^-1
        const displayValue = moistureConvergence * 1e7;
        fullVals[idx] = displayValue;
        if (displayValue > 0) displayVals[idx] = displayValue;
      }
    }
    // Post-filter moisture convergence to emphasize mesoscale signal.
    const fullValsSmoothed = gaussianBlurNaN(fullVals, nx, ny, 2);
    computedGrids.moistureConvergence = { values: fullValsSmoothed, nx, ny, step: convStep };

    const displayValsSmoothed = new Float32Array(nx * ny);
    displayValsSmoothed.fill(Number.NaN);
    for (let idx = 0; idx < displayValsSmoothed.length; idx++) {
      const v = fullValsSmoothed[idx];
      if (Number.isFinite(v) && v > 0) displayValsSmoothed[idx] = v;
    }

    let minV = Infinity;
    let maxV = -Infinity;
    for (let idx = 0; idx < displayValsSmoothed.length; idx++) {
      const v = displayValsSmoothed[idx];
      if (!Number.isFinite(v)) continue;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return;

    const levels = MOISTURE_CONV_LEVELS_X1E7
      .slice(1, -1)
      .filter((v) => v >= minV && v <= maxV);
    for (const level of levels) {
      const segments = contoursForLevel(displayValsSmoothed, nx, ny, convStep, level);
      if (segments.length === 0) continue;
      strokeMoistureConvergenceContours(ctx, segments);
    }
  }

  function drawWind() {
    const pts: Array<{ x: number; y: number; u: number; v: number }> = [];
  
    for (const s of declutteredObs) {
      if (isExcludedFromAnalysis(s, "wind")) continue;
      if (s.windDirDeg == null || s.windSpeedKt == null) continue;
      const p = map.project([s.lon, s.lat]);
      const { u, v } = windToUV(s.windDirDeg, s.windSpeedKt);
      pts.push({ x: p.x, y: p.y, u, v });
    }
    if (pts.length < 3) return;
  
    const nx = Math.floor(width / windStep) + 1;
    const ny = Math.floor(height / windStep) + 1;
  
    const gridU = new Float32Array(nx * ny);
    const gridV = new Float32Array(nx * ny);
    gridU.fill(Number.NaN);
    gridV.fill(Number.NaN);
  
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const gx = i * windStep;
        const gy = j * windStep;
  
        const neighbors: Array<{ d2: number; u: number; v: number }> = [];
        for (const p of pts) {
          const dx = p.x - gx;
          const dy = p.y - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxRadius2) continue;
  
          let inserted = false;
          for (let k = 0; k < neighbors.length; k++) {
            if (d2 < neighbors[k].d2) {
              neighbors.splice(k, 0, { d2, u: p.u, v: p.v });
              inserted = true;
              break;
            }
          }
          if (!inserted) neighbors.push({ d2, u: p.u, v: p.v });
          if (neighbors.length > kMax) neighbors.pop();
        }
  
        if (neighbors.length < 3) continue;
  
        let wSum = 0;
        let uSum = 0;
        let vSum = 0;
  
        for (const n of neighbors) {
          const w = 1 / Math.pow(Math.max(n.d2, 9), power / 2);
          wSum += w;
          uSum += w * n.u;
          vSum += w * n.v;
        }
        if (wSum <= 0) continue;
  
        const idx = j * nx + i;
        gridU[idx] = uSum / wSum;
        gridV[idx] = vSum / wSum;
      }
    }
    computedGrids.windVector = { u: gridU, v: gridV, nx, ny, step: windStep };
  
    // Draw barbs at each valid grid point
    ctx.save();
    ctx.globalAlpha = 0.9;           // wind a bit more visible
    ctx.strokeStyle = "#111827";
    ctx.fillStyle = "#111827";
    ctx.lineWidth = 1.4;
  
    const zoom = map.getZoom();
    const attachRadius = 0;          // detached barbs for analysis field
    const barbRadius = zoom < 6 ? 0 : 0; // keep detached either way
  
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        const u = gridU[idx];
        const v = gridV[idx];
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
  
        const { dir, spd } = uvToDirSpd(u, v);
        // Skip near-calm so the field isn’t noisy
        if (spd < 2) continue;
  
        const x = i * windStep;
        const y = j * windStep;
  
        // Use your existing barb renderer (dir is "from")
        if (windRenderMode === "barbs") {
          drawWindBarb(ctx, x, y, 0, dir, spd);
        } else {
          drawWindVector(ctx, x, y, dir, spd);
        }
      }
    }
  
    ctx.restore();
  }

  function drawOne(mode: "temp" | "dewpoint" | "slp" | "mixingRatio" | "thetaE") {
    // Build pts for THIS field
    const pts: Array<{ x: number; y: number; val: number }> = [];
    for (const s of declutteredObs) {
      const p = map.project([s.lon, s.lat]);
  
      if (mode === "temp") {
        if (isExcludedFromAnalysis(s, "temp")) continue;
        if (s.tempC == null) continue;
        const val = tempUnit === "F" ? celsiusToFahrenheit(s.tempC) : s.tempC;
        pts.push({ x: p.x, y: p.y, val });
      } else if (mode === "dewpoint") {
        if (isExcludedFromAnalysis(s, "dewpoint")) continue;
        if (s.dewpointC == null) continue;
        const val = tempUnit === "F" ? celsiusToFahrenheit(s.dewpointC) : s.dewpointC;
        pts.push({ x: p.x, y: p.y, val });
      } else if (mode === "slp") {
        if (isExcludedFromAnalysis(s, "slp")) continue;
        if (s.pressureMb == null) continue;
        pts.push({ x: p.x, y: p.y, val: s.pressureMb });
      } else if (mode === "mixingRatio") {
        if (isExcludedFromAnalysis(s, "dewpoint") || isExcludedFromAnalysis(s, "slp")) continue;
        if (s.dewpointC == null || s.pressureMb == null) continue;
        const mixingRatio = mixingRatioGkgFromDewpointPressure(s.dewpointC, s.pressureMb);
        if (mixingRatio == null) continue;
        pts.push({ x: p.x, y: p.y, val: mixingRatio });
      } else {
        if (
          isExcludedFromAnalysis(s, "temp")
          || isExcludedFromAnalysis(s, "dewpoint")
          || isExcludedFromAnalysis(s, "slp")
        ) continue;
        if (s.tempC == null || s.dewpointC == null || s.pressureMb == null) continue;
        const thetaE = equivalentPotentialTemperatureK(s.tempC, s.dewpointC, s.pressureMb);
        if (thetaE == null) continue;
        pts.push({ x: p.x, y: p.y, val: thetaE });
      }
    }
    if (pts.length < 3) return;
  
    // Build gridVals (same as your existing code, but using pts)
    const nx = Math.floor(width / step) + 1;
    const ny = Math.floor(height / step) + 1;
    const gridVals = new Float32Array(nx * ny);
    gridVals.fill(Number.NaN);
  
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const gx = i * step;
        const gy = j * step;
  
        const neighbors: Array<{ d2: number; val: number }> = [];
        for (const p of pts) {
          const dx = p.x - gx;
          const dy = p.y - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxRadius2) continue;
  
          let inserted = false;
          for (let k = 0; k < neighbors.length; k++) {
            if (d2 < neighbors[k].d2) {
              neighbors.splice(k, 0, { d2, val: p.val });
              inserted = true;
              break;
            }
          }
          if (!inserted) neighbors.push({ d2, val: p.val });
          if (neighbors.length > kMax) neighbors.pop();
        }
  
        if (neighbors.length < 3) continue;
  
        let wSum = 0;
        let vSum = 0;
        for (const n of neighbors) {
          const w = 1 / Math.pow(Math.max(n.d2, 9), power / 2);
          wSum += w;
          vSum += w * n.val;
        }
        if (wSum <= 0) continue;
  
        gridVals[j * nx + i] = vSum / wSum;
      }
    }
    if (mode === "temp") computedGrids.temp = { values: gridVals, nx, ny, step };
    else if (mode === "dewpoint") computedGrids.dewpoint = { values: gridVals, nx, ny, step };
    else if (mode === "slp") computedGrids.slp = { values: gridVals, nx, ny, step };
    else if (mode === "mixingRatio") computedGrids.mixingRatio = { values: gridVals, nx, ny, step };
    else if (mode === "thetaE") computedGrids.thetaE = { values: gridVals, nx, ny, step };
  
    // min/max
    let minV = Infinity, maxV = -Infinity;
    for (let k = 0; k < gridVals.length; k++) {
      const v = gridVals[k];
      if (!Number.isFinite(v)) continue;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return;
  
    // build levels
    const levels: number[] = [];
    const freezingLevel = tempUnit === "F" ? 32 : 0;
  
    if (mode === "temp") {
      const interval = tempUnit === "F" ? 5 : 2;
      const start = Math.floor(minV / interval) * interval;
      const end = Math.ceil(maxV / interval) * interval;
      for (let v = start; v <= end; v += interval) levels.push(v);
    } else if (mode === "dewpoint") {
      const dpThreshold = tempUnit === "F" ? 45 : 8;
      const dpStep = tempUnit === "F" ? 5 : 2;
      const start = Math.floor(minV / dpStep) * dpStep;
      const end = Math.ceil(maxV / dpStep) * dpStep;
      for (let v = start; v <= end; v += dpStep) if (v >= dpThreshold) levels.push(v);
    } else if (mode === "slp") {
      const base = 1000;
      const stepMb = 4;
      const kStart = Math.floor((minV - base) / stepMb);
      const kEnd = Math.ceil((maxV - base) / stepMb);
      for (let k = kStart; k <= kEnd; k++) levels.push(base + k * stepMb);
    } else if (mode === "mixingRatio") {
      const stepGkg = 2;
      const start = Math.max(10, Math.floor(minV / stepGkg) * stepGkg);
      const end = Math.ceil(maxV / stepGkg) * stepGkg;
      for (let v = start; v <= end; v += stepGkg) levels.push(v);
    } else if (mode === "thetaE") {
      const stepK = 2;
      const start = Math.max(330, Math.floor(minV / stepK) * stepK);
      const end = Math.ceil(maxV / stepK) * stepK;
      for (let v = start; v <= end; v += stepK) levels.push(v);
    }
  
    // draw
    for (const level of levels) {
      const segments = contoursForLevel(gridVals, nx, ny, step, level);
      if (segments.length === 0) continue;
  
      if (mode === "temp") {
        strokeIsotherms(ctx, segments, level, freezingLevel);
        labelContours(ctx, segments, level, "temp", { tempUnit, freezingLevel });
      } else if (mode === "dewpoint") {
        strokeIsodrosotherms(ctx, segments, level);
        labelContours(ctx, segments, level, "dewpoint", { tempUnit });
      } else if (mode === "slp") {
        strokeIsobars(ctx, segments, level);
        labelContours(ctx, segments, level, "slp", { tempUnit });
      } else if (mode === "mixingRatio") {
        strokeMixingRatioContours(ctx, segments);
        labelContours(ctx, segments, level, "mixingRatio", { tempUnit });
      } else {
        strokeThetaEContours(ctx, segments);
        labelContours(ctx, segments, level, "thetaE", { tempUnit });
      }
    }
  
    // emphasize freezing line
    if (mode === "temp") {
      const freezeSegs = contoursForLevel(gridVals, nx, ny, step, freezingLevel);
      if (freezeSegs.length) {
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = Math.min(1, ANALYSIS_ALPHA + 0.2);
        strokeIsotherms(ctx, freezeSegs, freezingLevel, freezingLevel);
        ctx.globalAlpha = prev;
      }
    }
  };

    if (analysisOverlays.windSpeedFill) drawWindSpeedFill();
    if (analysisOverlays.ceilingFill) drawCeilingFill();
    if (analysisOverlays.visibilityFill) drawVisibilityFill();
    if (analysisOverlays.relativeHumidityFill) drawRelativeHumidityFill();
    if (derivedOverlays.deltaSlp24h) drawDeltaSlp24hFill();
    if (derivedOverlays.deltaTemp24h) drawDeltaTemp24hFill();
    if (derivedOverlays.deltaDewpoint24h) drawDeltaDewpoint24hFill();
    if (derivedOverlays.deltaThetaE24h) drawDeltaThetaE24hFill();
    if (derivedOverlays.moistureConvergence) drawMoistureConvergenceContours();
    // draw order: pressure under, dewpoint, then temp on top
    if (analysisOverlays.slp) drawOne("slp");
    if (analysisOverlays.dewpoint) drawOne("dewpoint");
    if (analysisOverlays.temp) drawOne("temp");
    if (derivedOverlays.mixingRatio) drawOne("mixingRatio");
    if (derivedOverlays.thetaE) drawOne("thetaE");
    if (analysisOverlays.wind) drawWind();
  
    analysisGridRef.current = computedGrids;
    ctx.globalAlpha = 1;
  }, [analysisOverlays, derivedOverlays, declutteredObs, tempUnit, anyAnalysisLikeOverlayOn, windRenderMode, windUnit, changeBaselineById]);

function windToUV(dirDeg: number, spdKt: number) {
  // METAR direction is "from" direction.
  const rad = (dirDeg * Math.PI) / 180;
  const u = -spdKt * Math.sin(rad); // +u east
  const v = -spdKt * Math.cos(rad); // +v north
  return { u, v };
}

function uvToDirSpd(u: number, v: number) {
  const spd = Math.sqrt(u * u + v * v);
  if (spd < 1e-6) return { dir: 0, spd: 0 };
  // Convert to "from" direction
  const dirRad = Math.atan2(-u, -v);
  const dir = ((dirRad * 180) / Math.PI + 360) % 360;
  return { dir, spd };
}

const exportPng = useCallback(() => {
  const map = mapRef.current?.getMap();
  if (!map) return;

  // MapLibre canvas (base map + any MapLibre-rendered layers)
  const mapCanvas = map.getCanvas();

  // Overlay canvases (only draw if they exist / are mounted)
  const overlayCanvases: HTMLCanvasElement[] = [];
  if (nwsProduct === "wpcSurface" && frontRenderStyle === "classic" && wpcFrontCanvasRef.current) {
    overlayCanvases.push(wpcFrontCanvasRef.current);
  }
  if (analysisCanvasRef.current) overlayCanvases.push(analysisCanvasRef.current);
  if (showStations && displayMode === "plots" && canvasRef.current) overlayCanvases.push(canvasRef.current);
  if (analysisLabelCanvasRef.current) overlayCanvases.push(analysisLabelCanvasRef.current);

  const width = mapCanvas.width;   // device pixels
  const height = mapCanvas.height;

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;

  const ctx = out.getContext("2d");
  if (!ctx) return;

  // 1) base map
  ctx.drawImage(mapCanvas, 0, 0);

  // 2) overlays
  for (const c of overlayCanvases) {
    // Your overlay canvases are also sized in device pixels (you set canvas.width = cssW*dpr)
    // so they should align with mapCanvas.
    ctx.drawImage(c, 0, 0);
  }

  // 3) valid-time label (always included in export)
  {
    const dpr = window.devicePixelRatio || 1;
    const scale = dpr;
    const padX = 10 * scale;
    const padY = 5 * scale;
    const fontSize = 12 * scale;
    const radius = 8 * scale;
    const bottomMargin = 10 * scale;

    const drawRoundRect = (x: number, y: number, w: number, h: number, r: number) => {
      const rr = Math.min(r, w * 0.5, h * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    };

    ctx.font = `600 ${fontSize}px sans-serif`;
    const text = validTimeLabel;
    const textWidth = Math.ceil(ctx.measureText(text).width);
    const boxW = textWidth + padX * 2;
    const boxH = Math.ceil(fontSize * 1.25) + padY * 2;
    const x = Math.round((width - boxW) / 2);
    const y = Math.round(height - bottomMargin - boxH);

    drawRoundRect(x, y, boxW, boxH, radius);
    ctx.fillStyle = "rgba(2, 6, 23, 0.82)";
    ctx.fill();
    ctx.strokeStyle = "rgba(148, 163, 184, 0.45)";
    ctx.lineWidth = 1 * scale;
    ctx.stroke();

    ctx.fillStyle = "#e5e7eb";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, x + padX, y + boxH - padY - 2 * scale);
  }

  // 4) optional legend cards
  if (includeLegendInExport && !legendsCollapsed) {
    const dpr = window.devicePixelRatio || 1;
    const scale = dpr;
    const margin = 14 * scale;
    const rowGap = 8 * scale;
    const padX = 10 * scale;
    const padY = 8 * scale;
    const swatch = 14 * scale;
    const swatchGap = 7 * scale;
    const lineH = 18 * scale;
    const titleH = 16 * scale;
    const titleGap = 6 * scale;
    const fontSize = 12 * scale;
    const titleFontSize = 11 * scale;
    const borderRadius = 8 * scale;

    const drawRoundRect = (x: number, y: number, w: number, h: number, r: number) => {
      const rr = Math.min(r, w * 0.5, h * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    };

    ctx.textBaseline = "alphabetic";
    if (activeFillLegendCards.length > 0) {
      let yBottom = height - margin;
      for (let cardIdx = activeFillLegendCards.length - 1; cardIdx >= 0; cardIdx -= 1) {
        const card = activeFillLegendCards[cardIdx];
        ctx.font = `600 ${titleFontSize}px sans-serif`;
        let maxTextWidth = Math.ceil(ctx.measureText(card.title).width);
        ctx.font = `${fontSize}px sans-serif`;
        for (const item of card.items) {
          maxTextWidth = Math.max(maxTextWidth, Math.ceil(ctx.measureText(item.label).width));
        }

        const cardWidth = Math.max(142 * scale, padX * 2 + swatch + swatchGap + maxTextWidth);
        const cardHeight = padY * 2 + titleH + titleGap + card.items.length * lineH;
        const x = margin;
        const y = yBottom - cardHeight;

        drawRoundRect(x, y, cardWidth, cardHeight, borderRadius);
        ctx.fillStyle = "rgba(2, 6, 23, 0.84)";
        ctx.fill();
        ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
        ctx.lineWidth = 1 * scale;
        ctx.stroke();

        ctx.fillStyle = "#e5e7eb";
        ctx.font = `700 ${titleFontSize}px sans-serif`;
        ctx.fillText(card.title.toUpperCase(), x + padX, y + padY + titleH - 2 * scale);

        ctx.font = `${fontSize}px sans-serif`;
        for (let i = 0; i < card.items.length; i++) {
          const item = card.items[i];
          const rowY = y + padY + titleH + titleGap + i * lineH;
          const swX = x + padX;
          const swY = rowY + (lineH - swatch) / 2;
          drawRoundRect(swX, swY, swatch, swatch, 3 * scale);
          ctx.fillStyle = item.color;
          ctx.fill();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.32)";
          ctx.lineWidth = 1 * scale;
          ctx.stroke();

          ctx.fillStyle = "#e5e7eb";
          ctx.fillText(item.label, swX + swatch + swatchGap, rowY + lineH * 0.78);
        }
        yBottom = y - rowGap;
      }
    }

    if (mrmsGradientLegend) {
      const cardWidth = 172 * scale;
      const cardHeight = 240 * scale;
      const x = margin;
      const y = height - margin - cardHeight - (activeFillLegendCards.length > 0 ? ((activeFillLegendCards.length + 0.2) * rowGap) : 0);

      drawRoundRect(x, y, cardWidth, cardHeight, borderRadius);
      ctx.fillStyle = "rgba(2, 6, 23, 0.84)";
      ctx.fill();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
      ctx.lineWidth = 1 * scale;
      ctx.stroke();

      ctx.fillStyle = "#e5e7eb";
      ctx.font = `700 ${titleFontSize}px sans-serif`;
      ctx.fillText(mrmsGradientLegend.title.toUpperCase(), x + padX, y + padY + titleH - 2 * scale);

      const barX = x + padX;
      const barY = y + padY + titleH + titleGap;
      const barW = 18 * scale;
      const barH = cardHeight - (padY * 2 + titleH + titleGap + 8 * scale);
      const grad = ctx.createLinearGradient(0, barY + barH, 0, barY);
      grad.addColorStop(0.0, "#ffffff");
      grad.addColorStop((0 - (-35)) / 120, "#1e1e1e");
      grad.addColorStop((0 - (-35)) / 120, "#004b82");
      grad.addColorStop((20 - (-35)) / 120, "#8282fa");
      grad.addColorStop((20 - (-35)) / 120, "#6eff6e");
      grad.addColorStop((40 - (-35)) / 120, "#003c00");
      grad.addColorStop((40 - (-35)) / 120, "#ffff6e");
      grad.addColorStop((50 - (-35)) / 120, "#ff6e00");
      grad.addColorStop((50 - (-35)) / 120, "#ff0000");
      grad.addColorStop((65 - (-35)) / 120, "#5a0000");
      grad.addColorStop((65 - (-35)) / 120, "#ffc8ff");
      grad.addColorStop((75 - (-35)) / 120, "#5a005a");
      grad.addColorStop((75 - (-35)) / 120, "#ffffff");
      grad.addColorStop(1.0, "#191919");
      ctx.fillStyle = grad;
      drawRoundRect(barX, barY, barW, barH, 3 * scale);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.stroke();

      const ticks = [85, 75, 65, 50, 40, 20, 0, -35];
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = "#e5e7eb";
      for (const t of ticks) {
        const p = (t - (-35)) / 120;
        const yy = barY + barH - p * barH;
        ctx.fillText(`${t}${t === 85 ? "+" : ""}`, barX + barW + 8 * scale, yy + 3 * scale);
      }
    }

    if (contourLegendItems.length > 0) {
      ctx.font = `600 ${titleFontSize}px sans-serif`;
      let maxTextWidth = Math.ceil(ctx.measureText("Contours").width);
      ctx.font = `${fontSize}px sans-serif`;
      for (const item of contourLegendItems) {
        maxTextWidth = Math.max(maxTextWidth, Math.ceil(ctx.measureText(item.label).width));
      }

      const lineSampleW = 22 * scale;
      const sampleGap = 7 * scale;
      const cardWidth = Math.max(168 * scale, padX * 2 + lineSampleW + sampleGap + maxTextWidth);
      const cardHeight = padY * 2 + titleH + titleGap + contourLegendItems.length * lineH;
      const x = width - margin - cardWidth;
      const y = height - margin - cardHeight;

      drawRoundRect(x, y, cardWidth, cardHeight, borderRadius);
      ctx.fillStyle = "rgba(2, 6, 23, 0.84)";
      ctx.fill();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
      ctx.lineWidth = 1 * scale;
      ctx.stroke();

      ctx.fillStyle = "#e5e7eb";
      ctx.font = `700 ${titleFontSize}px sans-serif`;
      ctx.fillText("CONTOURS", x + padX, y + padY + titleH - 2 * scale);

      ctx.font = `${fontSize}px sans-serif`;
      for (let i = 0; i < contourLegendItems.length; i++) {
        const item = contourLegendItems[i];
        const rowY = y + padY + titleH + titleGap + i * lineH;
        const lineY = rowY + lineH * 0.5;
        const x0 = x + padX;
        const x1 = x0 + lineSampleW;
        ctx.beginPath();
        ctx.moveTo(x0, lineY);
        ctx.lineTo(x1, lineY);
        ctx.strokeStyle = item.color;
        ctx.lineWidth = item.width * scale * 0.6;
        ctx.setLineDash(item.dash ? item.dash.map((d) => d * scale * 0.6) : []);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = "#e5e7eb";
        ctx.fillText(item.label, x1 + sampleGap, rowY + lineH * 0.78);
      }
    }
  }

  // Download
  const dataUrl = out.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `wx-mesoanalysis_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  a.click();
}, [showStations, displayMode, includeLegendInExport, activeFillLegendCards, contourLegendItems, validTimeLabel, nwsProduct, frontRenderStyle, legendsCollapsed, mrmsGradientLegend]);

useEffect(() => {
  localStorage.setItem("showStations", String(showStations));
}, [showStations]);

useEffect(() => {
  localStorage.setItem("selectedViewId", selectedViewId);
}, [selectedViewId]);

useEffect(() => {
  if (!mapLoaded) return;
  if (!anyAnalysisLikeOverlayOn) return;
  drawAnalysisOverlay();
}, [mapLoaded, anyAnalysisLikeOverlayOn, drawAnalysisOverlay]);

useEffect(() => {
  localStorage.setItem("analysisOverlays", JSON.stringify(analysisOverlays));
}, [analysisOverlays]);

useEffect(() => {
  localStorage.setItem("derivedOverlays", JSON.stringify(derivedOverlays));
}, [derivedOverlays]);

useEffect(() => {
  localStorage.setItem("windUnit", windUnit);
}, [windUnit]);

useEffect(() => {
  localStorage.setItem("includeLegendInExport", String(includeLegendInExport));
}, [includeLegendInExport]);

useEffect(() => {
  localStorage.setItem("legendsCollapsed", String(legendsCollapsed));
}, [legendsCollapsed]);

useEffect(() => {
  localStorage.setItem("cursorReadoutDiagnostics", String(showCursorDiagnostics));
}, [showCursorDiagnostics]);

useEffect(() => {
  localStorage.setItem("displayTimeZone", displayTimeZone);
}, [displayTimeZone]);

useEffect(() => {
  localStorage.setItem("mrmsField", mrmsField);
}, [mrmsField]);

useEffect(() => {
  localStorage.setItem("nwsProduct", nwsProduct);
}, [nwsProduct]);

useEffect(() => {
  localStorage.setItem("frontRenderStyle", frontRenderStyle);
}, [frontRenderStyle]);

useEffect(() => {
  if (!showCursorDiagnostics) setCursorProbe(null);
}, [showCursorDiagnostics]);

useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== "l") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
    setLegendsCollapsed((v) => !v);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);

useEffect(() => {
  localStorage.setItem("geographyOverlays", JSON.stringify(geographyOverlays));
}, [geographyOverlays]);

useEffect(() => {
  if (!mapLoaded) return;
  if (!showStations) return;
  if (displayMode !== "plots" && displayMode !== "weather") return;

  // Canvas is mounted only when showStations && plots,
  // so schedule draw after React commits the DOM.
  const raf1 = requestAnimationFrame(() => {
    const raf2 = requestAnimationFrame(() => {
      drawStationPlots();
    });
    // cleanup inner RAF if needed
    return () => cancelAnimationFrame(raf2);
  });

  return () => cancelAnimationFrame(raf1);
}, [mapLoaded, showStations, displayMode, drawStationPlots]);

useEffect(() => {
  if (!mapLoaded) return;

  const raf = requestAnimationFrame(() => {
    // analysis overlay
    if (anyAnalysisLikeOverlayOn) drawAnalysisOverlay();

    // station plots / weather glyphs
    if (showStations && (displayMode === "plots" || displayMode === "weather")) drawStationPlots();

    // helps when toggling layers / mode quickly
    mapRef.current?.getMap()?.triggerRepaint?.();
  });

  return () => cancelAnimationFrame(raf);
}, [
  mapLoaded,
  obs,                 // redraw when the frame changes
  anyAnalysisLikeOverlayOn,
  drawAnalysisOverlay,
  showStations,
  displayMode,
  drawStationPlots,
]);

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-content">
          <div>
            <h1>Wx Mesoanalysis</h1>
            <p>Prototype mesoanalysis dashboard (surface obs layer)</p>
          </div>
          </div>
          </header>
          <div className="header-controls">
            <div className="header-row header-row-top">
            <div className="analysis-control">
              <div className="analysis-title">Objective Analysis</div>
              <details className="analysis-dropdown">
                <summary>Analysis Layers</summary>
                <div className="analysis-menu">
                  <label>
                    <input
                      type="checkbox"
                      checked={analysisOverlays.temp}
                      onChange={(e) => setAnalysisOverlays(s => ({ ...s, temp: e.target.checked }))}
                    />
                    Isotherms (Temp)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={analysisOverlays.dewpoint}
                      onChange={(e) => setAnalysisOverlays(s => ({ ...s, dewpoint: e.target.checked }))}
                    />
                    Isodrosotherms (Dewpoint)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={analysisOverlays.slp}
                      onChange={(e) => setAnalysisOverlays(s => ({ ...s, slp: e.target.checked }))}
                    />
                    Isobars (SLP)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={analysisOverlays.wind}
                      onChange={(e) =>
                        setAnalysisOverlays((s) => ({ ...s, wind: e.target.checked }))
                      }
                    />
                    Wind (Objective)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={analysisOverlays.windSpeedFill}
                      onChange={(e) =>
                        setAnalysisOverlays((s) => ({ ...s, windSpeedFill: e.target.checked }))
                      }
                    />
                    Wind Speed (Fill)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={analysisOverlays.ceilingFill}
                      onChange={(e) =>
                        setAnalysisOverlays((s) => ({ ...s, ceilingFill: e.target.checked }))
                      }
                    />
                    Ceiling (Fill, &le;050)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={analysisOverlays.visibilityFill}
                      onChange={(e) =>
                        setAnalysisOverlays((s) => ({ ...s, visibilityFill: e.target.checked }))
                      }
                    />
                    Visibility (Fill, &le;6SM)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={analysisOverlays.relativeHumidityFill}
                      onChange={(e) =>
                        setAnalysisOverlays((s) => ({ ...s, relativeHumidityFill: e.target.checked }))
                      }
                    />
                    Relative Humidity (Critical Fill)
                  </label>
                </div>
              </details>
            </div>
            <div className="analysis-control">
              <div className="analysis-title">Derived Fields</div>
              <details className="analysis-dropdown">
                <summary>Derived Fields</summary>
                <div className="analysis-menu">
                  <div className="analysis-subsection-title">Moisture</div>
                  <label>
                    <input
                      type="checkbox"
                      checked={derivedOverlays.mixingRatio}
                      onChange={(e) =>
                        setDerivedOverlays((s) => ({ ...s, mixingRatio: e.target.checked }))
                      }
                    />
                    Mixing Ratio (≥10 g/kg)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={derivedOverlays.thetaE}
                      onChange={(e) =>
                        setDerivedOverlays((s) => ({ ...s, thetaE: e.target.checked }))
                      }
                    />
                    Theta-e (Contours)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={derivedOverlays.moistureConvergence}
                      onChange={(e) =>
                        setDerivedOverlays((s) => ({ ...s, moistureConvergence: e.target.checked }))
                      }
                    />
                    Moisture Convergence (Contours)
                  </label>
                  <div className="analysis-subsection-title">24-hour change</div>
                  <label>
                    <input
                      type="checkbox"
                      checked={derivedOverlays.deltaSlp24h}
                      onChange={(e) =>
                        setDerivedOverlays((s) => ({ ...s, deltaSlp24h: e.target.checked }))
                      }
                    />
                    SLP Change (24h)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={derivedOverlays.deltaTemp24h}
                      onChange={(e) =>
                        setDerivedOverlays((s) => ({ ...s, deltaTemp24h: e.target.checked }))
                      }
                    />
                    Temperature Change (24h)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={derivedOverlays.deltaDewpoint24h}
                      onChange={(e) =>
                        setDerivedOverlays((s) => ({ ...s, deltaDewpoint24h: e.target.checked }))
                      }
                    />
                    Dewpoint Change (24h)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={derivedOverlays.deltaThetaE24h}
                      onChange={(e) =>
                        setDerivedOverlays((s) => ({ ...s, deltaThetaE24h: e.target.checked }))
                      }
                    />
                    Theta-e Change (24h)
                  </label>
                </div>
              </details>
            </div>
            <div className="analysis-control">
              <div className="analysis-title">MRMS</div>
              <details className="analysis-dropdown">
                <summary>MRMS Fields</summary>
                <div className="analysis-menu">
                  <label>
                    <input
                      type="radio"
                      name="mrms-field"
                      checked={mrmsField === "none"}
                      onChange={() => setMrmsField("none")}
                    />
                    Off
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mrms-field"
                      checked={mrmsField === "rala"}
                      onChange={() => setMrmsField("rala")}
                    />
                    RALA Reflectivity (dBZ)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mrms-field"
                      checked={mrmsField === "composite"}
                      onChange={() => setMrmsField("composite")}
                    />
                    Composite Reflectivity (dBZ)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mrms-field"
                      checked={mrmsField === "etop18"}
                      onChange={() => setMrmsField("etop18")}
                    />
                    18 dBZ Echo Tops (kft)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mrms-field"
                      checked={mrmsField === "rotation240"}
                      onChange={() => setMrmsField("rotation240")}
                    />
                    4-hour Rotation Tracks (1/s)
                  </label>
                </div>
              </details>
            </div>
            <div className="analysis-control">
              <div className="analysis-title">NWS Products</div>
              <details className="analysis-dropdown">
                <summary>NWS Products</summary>
                <div className="analysis-menu">
                  <label>
                    <input
                      type="radio"
                      name="nws-product"
                      checked={nwsProduct === "none"}
                      onChange={() => setNwsProduct("none")}
                    />
                    Off
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="nws-product"
                      checked={nwsProduct === "wpcSurface"}
                      onChange={() => setNwsProduct("wpcSurface")}
                    />
                    WPC Surface Analysis (Latest)
                  </label>
                </div>
              </details>
            </div>
            <div className="geography-control">
              <div className="geography-title">Geographies</div>
              <details className="geography-dropdown">
                <summary>Geographic Layers</summary>
                <div className="geography-menu">
                  <label>
                    <input
                      type="checkbox"
                      checked={geographyOverlays.adm0}
                      onChange={(e) => setGeographyOverlays((s) => ({ ...s, adm0: e.target.checked }))}
                    />
                    National Boundaries (ADM0)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={geographyOverlays.adm1}
                      onChange={(e) => setGeographyOverlays((s) => ({ ...s, adm1: e.target.checked }))}
                    />
                    State/Province Boundaries (ADM1)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={geographyOverlays.adm2}
                      onChange={(e) => setGeographyOverlays((s) => ({ ...s, adm2: e.target.checked }))}
                    />
                    County/District Boundaries (US Counties)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={geographyOverlays.artcc}
                      onChange={(e) => setGeographyOverlays((s) => ({ ...s, artcc: e.target.checked }))}
                    />
                    U.S. ARTCC Boundaries
                  </label>
                  <details className="view-submenu">
                    <summary>Views</summary>
                    <div className="view-submenu-content">
                      <details className="view-submenu">
                        <summary>U.S. Regions</summary>
                        <div className="view-item-list">
                          {REGION_VIEWS.map((view) => (
                            <button
                              key={view.id}
                              type="button"
                              className={`view-item-btn ${selectedViewId === view.id ? "active" : ""}`}
                              onClick={() => applyPresetView(view)}
                            >
                              {view.label}
                            </button>
                          ))}
                        </div>
                      </details>
                      <details className="view-submenu">
                        <summary>U.S. States</summary>
                        <div className="view-item-grid">
                          {STATE_TERRITORY_VIEWS.map((view) => (
                            <button
                              key={view.id}
                              type="button"
                              className={`view-item-btn ${selectedViewId === view.id ? "active" : ""}`}
                              onClick={() => applyPresetView(view)}
                              title={view.id.replace("state-", "")}
                            >
                              {view.label}
                            </button>
                          ))}
                        </div>
                      </details>
                      <details className="view-submenu">
                        <summary>U.S. ARTCCs</summary>
                        <div className="view-item-grid">
                          {ARTCC_VIEWS.map((view) => (
                            <button
                              key={view.id}
                              type="button"
                              className={`view-item-btn ${selectedViewId === view.id ? "active" : ""}`}
                              onClick={() => applyPresetView(view)}
                            >
                              {view.label}
                            </button>
                          ))}
                        </div>
                      </details>
                    </div>
                  </details>
                </div>
              </details>
            </div>
            </div>
            <div className="header-row header-row-bottom">
            <div className="time-control">
              <div className="time-title">TIME</div>
              <div className="time-row">
                <button
                  type="button"
                  className="control-btn"
                  onClick={() => setTimeIndex((i) => Math.max(0, i - 1))}
                  disabled={availableTimes.length === 0 || timeIndex <= 0}
                >
                  ◀
                </button>

                <button
                  type="button"
                  className={`control-btn ${isPlaying ? "active" : ""}`}
                  onClick={() => setIsPlaying((p) => !p)}
                  disabled={availableTimes.length < 2}
                >
                  {isPlaying ? "Pause" : "Play"}
                </button>

                <button
                  type="button"
                  className="control-btn"
                  onClick={() => setTimeIndex((i) => Math.min(availableTimes.length - 1, i + 1))}
                  disabled={availableTimes.length === 0 || timeIndex >= availableTimes.length - 1}
                >
                  ▶
                </button>

                <select
                  className="density-select"
                  value={playSpeedMs}
                  onChange={(e) => setPlaySpeedMs(Number(e.target.value))}
                >
                  <option value={250}>0.25s</option>
                  <option value={500}>0.5s</option>
                  <option value={800}>0.8s</option>
                  <option value={1200}>1.2s</option>
                </select>
              </div>

              <input
                className="time-slider"
                type="range"
                min={0}
                max={Math.max(0, availableTimes.length - 1)}
                step={1}
                value={Math.max(0, timeIndex)}
                onChange={(e) => {
                  setIsPlaying(false);
                  setTimeIndex(Number(e.target.value));
                }}
                disabled={availableTimes.length === 0}
              />

              <div className="time-label">
                {availableTimes[timeIndex] ? formatZulu(availableTimes[timeIndex]) : "—"}{" "}
                {availableTimes[timeIndex] ? `(${formatAge(availableTimes[timeIndex])})` : ""}
              </div>
            </div>
            <div className="header-actions">
              <button
                type="button"
                className={`options-open-btn ${legendsCollapsed ? "active" : ""}`}
                onClick={() => setLegendsCollapsed((v) => !v)}
              >
                {legendsCollapsed ? "Show Legends" : "Hide Legends"}
              </button>
              <button type="button" className="options-open-btn" onClick={() => setIsOpsOpen(true)}>
                API Diagnostics
              </button>
              <button type="button" className="options-open-btn" onClick={() => setIsOptionsOpen(true)}>
                Open Options
              </button>
              <button type="button" onClick={exportPng} className="export-btn">
                Download View as PNG
              </button>
            </div>
            </div>
          </div>

      <main className="app-main">
        <section className="map-panel">
          <div className="map-container">
            {mrmsField !== "none" && mrmsMeta?.stale_warning && (
              <div className="mrms-warning-overlay">
                MRMS {getMrmsProductLabel(mrmsField)} warning: matched frame is {Math.round(mrmsMeta.age_minutes)} minutes old
                ({mrmsMeta.matched_time ? formatZulu(mrmsMeta.matched_time) : "—"}).
              </div>
            )}
            {mrmsField !== "none" && mrmsError && (
              <div className="mrms-warning-overlay mrms-warning-error">
                MRMS {getMrmsProductLabel(mrmsField)} unavailable: {mrmsError}
              </div>
            )}
            {nwsProduct === "wpcSurface" && wpcSurface?.stale_warning && (
              <div className="mrms-warning-overlay">
                WPC surface analysis warning: latest parsed valid time is {wpcSurface.valid_time ? formatZulu(wpcSurface.valid_time) : "unknown"}
                {typeof wpcSurface.age_minutes === "number" ? ` (${Math.round(wpcSurface.age_minutes)} min old)` : ""}.
              </div>
            )}
            {nwsProduct === "wpcSurface" && wpcError && (
              <div className="mrms-warning-overlay mrms-warning-error">
                WPC surface analysis unavailable: {wpcError}
              </div>
            )}
            {nwsProduct === "wpcSurface" && frontRenderStyle === "classic" && (
              <canvas
                ref={wpcFrontCanvasRef}
                className="wpc-front-canvas"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                  zIndex: 14,
                }}
              />
            )}
            {anyAnalysisLikeOverlayOn && (
              <canvas
                ref={analysisCanvasRef}
                className="analysis-canvas"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                  zIndex: 15, // below station plots (10), above map
                }}
              />
            )}

            {showStations && (displayMode === "plots" || displayMode === "weather") && (
              <canvas
                ref={canvasRef}
                className="station-plot-canvas"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                  zIndex: 10,
                }}
              />
            )}

            {anyAnalysisLikeOverlayOn && (
              <canvas
                ref={analysisLabelCanvasRef}
                className="analysis-label-canvas"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                  zIndex: 30, // ABOVE station plots
                }}
              />
            )}

            {!legendsCollapsed && (activeFillLegendCards.length > 0 || Boolean(mrmsGradientLegend)) && (
              <div className="analysis-legends">
                {activeFillLegendCards.map((card) => (
                  <div className="analysis-legend" key={`fill-legend-${card.title}`}>
                    <div className="wind-fill-legend-title">{card.title}</div>
                    <ul className="wind-fill-legend-list">
                      {card.items.map((item, idx) => (
                        <li key={`${card.title}-${idx}`}>
                          <span className="wind-fill-swatch" style={{ backgroundColor: item.color }} />
                          <span>{item.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {mrmsGradientLegend && (
                <div className="analysis-legend">
                  <div className="wind-fill-legend-title">{mrmsGradientLegend.title}</div>
                  <div className="mrms-gradient-legend-body">
                    <div className="mrms-gradient-bar" style={{ background: mrmsGradientLegend.gradientCss }} />
                    <div className="mrms-gradient-labels">
                      {mrmsGradientLegend.labels.map((lbl) => (
                        <span key={`mrms-grad-${lbl}`}>{lbl}</span>
                      ))}
                    </div>
                  </div>
                </div>
                )}
              </div>
            )}

            {legendsCollapsed && (
              <div className="legends-hidden-chip">Legends Hidden</div>
            )}

            <div className="valid-time-overlay">{validTimeLabel}</div>

            {!legendsCollapsed && contourLegendItems.length > 0 && (
              <div className="contour-legends">
                <div className="analysis-legend">
                  <div className="wind-fill-legend-title">Contours</div>
                  <ul className="wind-fill-legend-list">
                    {contourLegendItems.map((item) => (
                      <li key={`contour-legend-${item.key}`}>
                        <span
                          className="contour-line-swatch"
                          style={{
                            borderTopColor: item.color,
                            borderTopWidth: `${item.width}px`,
                            borderTopStyle: item.dash ? "dashed" : "solid",
                          }}
                        />
                        <span>{item.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <MapGL
              preserveDrawingBuffer={true}
              onLoad={() => setMapLoaded(true)}
              ref={mapRef}
              reuseMaps
              mapLib={maplibregl}
              {...viewState}
              onMove={(evt) => setViewState(evt.viewState)}
              minZoom={2}
              maxZoom={12}
              mapStyle={mapStyle}
              attributionControl={true}
                  interactiveLayerIds={
                    showStations
                  ? (displayMode === "plots" || displayMode === "weather" ? ["hit-targets"] : ["unclustered"])
                  : []
                  }
              onMouseMove={(e) => {
                if (!showCursorDiagnostics) return;
                setCursorProbe({
                  x: e.point.x,
                  y: e.point.y,
                  lng: e.lngLat.lng,
                  lat: e.lngLat.lat,
                });
              }}
              onMouseLeave={() => {
                if (!showCursorDiagnostics) return;
                setCursorProbe(null);
              }}
              onClick={(e) => {
                if (!showStations) return;
                const map = mapRef.current?.getMap();
                if (!map) return;

                const layers = displayMode === "plots" || displayMode === "weather" ? ["hit-targets"] : ["unclustered"];
                const features = map.queryRenderedFeatures(e.point, { layers });

                const f = features?.[0];
                if (!f) return;

                const id = (f.properties as any)?.id as string | undefined;
                if (!id) return;

                const station = obsById.get(id);
                if (!station) return;

                // This should trigger your existing details panel / popup
                setSelectedStation(station);

                console.log("clicked station", id);
                console.log("clicked obsTimeUtc:", station?.obsTimeUtc);
                console.log("drawing plots", declutteredObs.length);
              }}
            >
              <NavigationControl position="top-left" />
              {mrmsField !== "none" && mrmsTileTemplate && (
                <Source
                  id="mrms-raster-tiles"
                  key={mrmsTileTemplate}
                  type="raster"
                  tiles={[mrmsTileTemplate]}
                  tileSize={256}
                >
                  <Layer {...mrmsRasterLayer} />
                </Source>
              )}
              {nwsProduct === "wpcSurface" && wpcSurface && frontRenderStyle === "simple" && (
                <>
                  <Source id="wpc-fronts" type="geojson" data={wpcSurface.fronts}>
                    <Layer {...wpcFrontColdLayer} />
                    <Layer {...wpcFrontWarmLayer} />
                    <Layer {...wpcFrontOccludedLayer} />
                    <Layer {...wpcFrontStationaryLayer} />
                    <Layer {...wpcFrontDrylineLayer} />
                    <Layer {...wpcFrontTroughLayer} />
                  </Source>
                </>
              )}
              {nwsProduct === "wpcSurface" && wpcSurface && (
                <Source id="wpc-centers" type="geojson" data={wpcSurface.centers}>
                  <Layer {...wpcCenterLayer} />
                  <Layer {...wpcCenterPressureLayer} />
                </Source>
              )}
              {geographyOverlays.adm0 && (
                <Source id="adm0-boundaries" type="geojson" data={ADM0_BOUNDARIES_URL}>
                  <Layer {...adm0BoundaryLayer} />
                </Source>
              )}
              {geographyOverlays.adm1 && (
                <Source id="adm1-boundaries" type="geojson" data={ADM1_BOUNDARIES_URL}>
                  <Layer {...adm1BoundaryLayer} />
                </Source>
              )}
              {geographyOverlays.adm2 && (
                <Source id="adm2-boundaries" type="geojson" data={ADM2_BOUNDARIES_URL}>
                  <Layer {...adm2BoundaryLayer} />
                </Source>
              )}
              {geographyOverlays.artcc && (
                <Source id="artcc-boundaries" type="geojson" data={ARTCC_BOUNDARIES_URL}>
                  <Layer {...artccBoundaryLayer} />
                </Source>
              )}
              <Source id="stations" type="geojson" data={stationsGeoJson}>
                {displayMode === "dots" && <Layer {...unclusteredLayer} key="dots-layer" />}
                {(displayMode === "plots" || displayMode === "weather") && <Layer {...hitTargetsLayer} key="hit-layer" />}
              </Source>
            </MapGL>
          </div>
        </section>

        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Surface Observations</h2>
            {lastUpdate && (
              <p className="update-time">
                Updated: {new Date(lastUpdate).toLocaleTimeString()}
              </p>
            )}
            {isLoading ? (
              <p>Loading observations...</p>
            ) : obs.length === 0 ? (
              <p>No data available.</p>
            ) : (
              <p className="station-count">
                {visibleObs.length} of {obs.length} stations visible
              </p>
            )}
            {displayMode === "weather" && (
              <p className="station-count">
                Unknown weather symbols: {unknownWxSymbolCount}
              </p>
            )}
          </div>
          {showCursorDiagnostics && (
            <div className="diagnostics-panel">
              <div className="diagnostics-title">Cursor Diagnostics</div>
              {!cursorProbe ? (
                <div className="diagnostics-empty">Move cursor over map to inspect enabled fields.</div>
              ) : (
                <>
                  <div className="diagnostics-meta">
                    <span>{cursorProbe.lat.toFixed(3)}°, {cursorProbe.lng.toFixed(3)}°</span>
                    <span>{lastUpdate ? formatZulu(lastUpdate) : "—"}</span>
                  </div>
                  {diagnosticsRows.length === 0 ? (
                    <div className="diagnostics-empty">No enabled analysis/derived fields.</div>
                  ) : (
                    <div className="diagnostics-table">
                      {diagnosticsRows.map((row) => (
                        <div key={`diag-${row.label}`} className="diagnostics-row">
                          <span className="diagnostics-label">{row.label}</span>
                          <span className="diagnostics-value">{row.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {!isLoading && obs.length > 0 && (
            <div className="sidebar-content">
              <ul className="obs-list">
                {visibleObs.map((s) => {
                  const isExpanded = expandedStations.has(s.id);
                  return (
                    <li key={s.id} id={`obs-${s.id}`} className={isExpanded ? "expanded" : ""}>
                      <div
                        className="obs-item-header"
                        onClick={() => toggleExpanded(s.id)}
                      >
                        <div className="obs-item-main">
                          <strong>{s.id}</strong> - {s.name} – {formatTempDetailed(s.tempC)}
                          {s.dewpointC !== null && formatDewpoint(s.dewpointC)}
                          {hasQcFlags(s) && <span className="qc-badge-inline">QC</span>}
                          {s.windSpeedKt !== null && (
                            <span className="wind-info">
                              {" "}
                              {s.windDirDeg !== null
                                ? `${Math.round(s.windDirDeg)}°`
                                : ""}{" "}
                              {formatWindSpeedCompact(s.windSpeedKt)}
                            </span>
                          )}
                        </div>
                        <button
                          className="expand-btn"
                          aria-label={isExpanded ? "Collapse" : "Expand"}
                        >
                          {isExpanded ? "−" : "+"}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="obs-item-details">
                          <div className="detail-row">
                            <span className="detail-label">Location:</span>
                            <span>{s.name} ({s.id})</span>
                          </div>
                          {s.obsTimeUtc && (
                            <div className="detail-row">
                              <span className="detail-label">Observation Time:</span>
                              <span className={obsAgeClass(s.obsTimeUtc)}>
                                {new Date(s.obsTimeUtc).toLocaleString()} ({formatAge(s.obsTimeUtc)})
                              </span>
                            </div>
                          )}

                          {hasQcFlags(s) && (
                            <div className="detail-section">
                              <div className="detail-section-title">Data Quality</div>
                              <div className="qc-summary">
                                Potentially bad data flagged.
                              </div>
                              <ul className="qc-list">
                                {(s.qcFlags ?? []).map((flag, idx) => (
                                  <li key={`${s.id}-qc-${idx}`}>{flag}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          
                          <div className="detail-section">
                            <div className="detail-section-title">Flight Conditions</div>
                            <div className="detail-row">
                              <span className="detail-label">Flight Rule:</span>
                              <span className={`flight-rule flight-rule-${s.flightRule.toLowerCase()}`}>
                                {s.flightRule}
                              </span>
                            </div>
                            {s.visibilityMi !== null && (
                              <div className="detail-row">
                                <span className="detail-label">Visibility:</span>
                                <span>{s.visibilityMi.toFixed(2)} SM</span>
                              </div>
                            )}
                            {s.ceilingFt !== null ? (
                              <div className="detail-row">
                                <span className="detail-label">Ceiling:</span>
                                <span>{s.ceilingFt.toFixed(0)} ft</span>
                              </div>
                            ) : (
                              <div className="detail-row">
                                <span className="detail-label">Ceiling:</span>
                                <span>Unlimited</span>
                              </div>
                            )}
                            {s.skyConditions.length > 0 && (
                              <div className="detail-row">
                                <span className="detail-label">Sky Conditions:</span>
                                <span className="sky-conditions">
                                  {s.skyConditions.map((sc, idx) => (
                                    <span key={idx} className="sky-condition">
                                      {sc.cover}
                                      {sc.level_ft !== null && ` ${Math.round(sc.level_ft)}`}
                                      {idx < s.skyConditions.length - 1 && ", "}
                                    </span>
                                  ))}
                                </span>
                              </div>
                            )}
                          </div>

                          <div className="detail-section">
                            <div className="detail-section-title">Temperature & Humidity</div>
                            <div className="detail-row">
                              <span className="detail-label">Temperature:</span>
                              <span>{formatTempDetailed(s.tempC)}</span>
                            </div>
                            {s.dewpointC !== null && (
                              <div className="detail-row">
                                <span className="detail-label">Dewpoint:</span>
                                <span>{formatTempDetailed(s.dewpointC)}</span>
                              </div>
                            )}
                            {s.relativeHumidity !== null && (
                              <div className="detail-row">
                                <span className="detail-label">Relative Humidity:</span>
                                <span>{s.relativeHumidity.toFixed(1)}%</span>
                              </div>
                            )}
                          </div>

                          <div className="detail-section">
                            <div className="detail-section-title">Wind</div>
                            {s.windSpeedKt !== null ? (
                              <>
                                <div className="detail-row">
                                  <span className="detail-label">Wind Speed:</span>
                                  <span>{formatWindSpeed(s.windSpeedKt)}</span>
                                </div>
                                {s.windGustKt !== null && (
                                  <div className="detail-row">
                                    <span className="detail-label">Wind Gust:</span>
                                    <span>{formatWindSpeed(s.windGustKt)}</span>
                                  </div>
                                )}
                                {s.windDirDeg !== null && (
                                  <div className="detail-row">
                                    <span className="detail-label">Wind Direction:</span>
                                    <span>
                                      {Math.round(s.windDirDeg)}° ({formatWindDirection(s.windDirDeg)})
                                    </span>
                                  </div>
                                )}
                              </>
                            ) : (
                              <div className="detail-row">
                                <span className="detail-label">Wind:</span>
                                <span>Calm</span>
                              </div>
                            )}
                          </div>

                          <div className="detail-section">
                            <div className="detail-section-title">Pressure</div>

                            {s.altimeterInhg !== null && (
                              <div className="detail-row">
                                <span className="detail-label">Altimeter:</span>
                                <span>{s.altimeterInhg.toFixed(2)} inHg</span>
                              </div>
                            )}

                            {s.pressureMb !== null && (
                              <div className="detail-row">
                                <span className="detail-label">Pressure (MSL):</span>
                                <span>
                                  {s.pressureMb.toFixed(1)} mb
                                  {s.pressureIsEstimated ? (
                                    <span
                                      style={{
                                        marginLeft: 8,
                                        padding: "2px 6px",
                                        borderRadius: 6,
                                        fontSize: 12,
                                        fontWeight: 600,
                                        border: "1px solid #f59e0b",
                                        color: "#92400e",
                                        background: "rgba(245, 158, 11, 0.12)",
                                      }}
                                      title="Sea-level pressure was computed from altimeter + elevation + temperature"
                                    >
                                      EST
                                    </span>
                                  ) : null}
                                </span>
                              </div>
                            )}

                            {s.pressureIsEstimated && s.pressureMb === null && (
                              <div className="detail-row">
                                <span className="detail-label">Pressure (MSL):</span>
                                <span>Estimated</span>
                              </div>
                            )}
                          </div>

                          {s.weatherCodes && (
                            <div className="detail-section">
                              <div className="detail-section-title">Weather</div>
                              <div className="detail-row">
                                <span className="detail-label">Weather Codes:</span>
                                <span>{s.weatherCodes}</span>
                              </div>
                            </div>
                          )}

                          {s.rawMetar && (
                            <div className="detail-section">
                              <div className="detail-section-title">Raw METAR</div>
                              <div className="raw-metar">
                                {s.rawMetar}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </aside>
      </main>

      {isOpsOpen && (
        <div className="options-overlay" onClick={() => setIsOpsOpen(false)}>
          <div className="options-content ops-content" onClick={(e) => e.stopPropagation()}>
            <div className="options-header">
              <h3>API Diagnostics Dashboard</h3>
              <div className="ops-actions">
                <button className="control-btn" type="button" onClick={refreshOpsSummary}>
                  Refresh
                </button>
                <button
                  className="control-btn"
                  type="button"
                  onClick={() => {
                    if (!opsSummary) return;
                    navigator.clipboard?.writeText(JSON.stringify(opsSummary, null, 2)).catch(() => {});
                  }}
                >
                  Copy JSON
                </button>
                <button
                  className="options-close"
                  onClick={() => setIsOpsOpen(false)}
                  aria-label="Close diagnostics"
                  type="button"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="options-body ops-body">
              {opsLoading && <div className="ops-muted">Loading diagnostics...</div>}
              {opsError && <div className="mrms-warning-overlay mrms-warning-error ops-inline-error">Diagnostics error: {opsError}</div>}
              {!opsSummary ? (
                <div className="ops-muted">No diagnostics data loaded yet.</div>
              ) : (
                <>
                  <div className="ops-meta">
                    <div>Generated (UTC): {formatLocalDateTime(opsSummary.generated_at)} / {formatZulu(opsSummary.generated_at)}</div>
                    <div>Service start: {formatLocalDateTime(opsSummary.health.started_at)} / {formatZulu(opsSummary.health.started_at)}</div>
                  </div>

                  <div className="ops-cards">
                    <div className="ops-card">
                      <div className="ops-card-title">Status</div>
                      <div className={`ops-status-pill ${opsSummary.health.status}`}>{opsSummary.health.status.toUpperCase()}</div>
                    </div>
                    <div className="ops-card">
                      <div className="ops-card-title">Uptime</div>
                      <div className="ops-card-value">{formatUptime(opsSummary.health.uptime_seconds)}</div>
                    </div>
                    <div className="ops-card">
                      <div className="ops-card-title">Data Disk Usage</div>
                      <div className="ops-card-value">{formatBytes(opsSummary.health.storage_total_bytes)}</div>
                    </div>
                    <div className="ops-card">
                      <div className="ops-card-title">METAR Latest Age</div>
                      <div className="ops-card-value">
                        {opsSummary.freshness.metar.latest_age_minutes == null ? "—" : `${opsSummary.freshness.metar.latest_age_minutes} min`}
                      </div>
                    </div>
                  </div>

                  <div className="ops-section">
                    <div className="ops-section-title">Freshness</div>
                    <div className="ops-table-wrap">
                      <table className="ops-table">
                        <thead>
                          <tr>
                            <th>Source</th>
                            <th>Latest Time (UTC)</th>
                            <th>Age</th>
                            <th>Status</th>
                            <th>Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>METAR</td>
                            <td>{opsSummary.freshness.metar.latest_update ? formatZulu(opsSummary.freshness.metar.latest_update) : "—"}</td>
                            <td>{opsSummary.freshness.metar.latest_age_minutes == null ? "—" : `${opsSummary.freshness.metar.latest_age_minutes} min`}</td>
                            <td>OK</td>
                            <td>{opsSummary.freshness.metar.latest_station_count} stations, {opsSummary.freshness.metar.snapshot_count} snapshots</td>
                          </tr>
                          <tr>
                            <td>MRMS RALA</td>
                            <td>{opsSummary.freshness.mrms.rala.latest_time ? formatZulu(opsSummary.freshness.mrms.rala.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.rala.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.rala.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.rala.status.toUpperCase()}</td>
                            <td>{opsSummary.freshness.mrms.rala.available_count} times</td>
                          </tr>
                          <tr>
                            <td>MRMS Composite</td>
                            <td>{opsSummary.freshness.mrms.composite.latest_time ? formatZulu(opsSummary.freshness.mrms.composite.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.composite.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.composite.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.composite.status.toUpperCase()}</td>
                            <td>{opsSummary.freshness.mrms.composite.available_count} times</td>
                          </tr>
                          <tr>
                            <td>MRMS EchoTop 18</td>
                            <td>{opsSummary.freshness.mrms.etop18.latest_time ? formatZulu(opsSummary.freshness.mrms.etop18.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.etop18.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.etop18.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.etop18.status.toUpperCase()}</td>
                            <td>{opsSummary.freshness.mrms.etop18.available_count} times</td>
                          </tr>
                          <tr>
                            <td>MRMS RotationTrack 240</td>
                            <td>{opsSummary.freshness.mrms.rotation240.latest_time ? formatZulu(opsSummary.freshness.mrms.rotation240.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.rotation240.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.rotation240.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.rotation240.status.toUpperCase()}</td>
                            <td>{opsSummary.freshness.mrms.rotation240.available_count} times</td>
                          </tr>
                          <tr>
                            <td>WPC Surface</td>
                            <td>{opsSummary.freshness.wpc.valid_time ? formatZulu(opsSummary.freshness.wpc.valid_time) : "—"}</td>
                            <td>{opsSummary.freshness.wpc.valid_age_minutes == null ? "—" : `${opsSummary.freshness.wpc.valid_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.wpc.status.toUpperCase()}</td>
                            <td>
                              {opsSummary.freshness.wpc.stale_warning ? `Overdue by ${opsSummary.freshness.wpc.overdue_by_minutes ?? "?"} min` : "On schedule"}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="ops-section">
                    <div className="ops-section-title">Storage</div>
                    <div className="ops-table-wrap">
                      <table className="ops-table">
                        <thead>
                          <tr>
                            <th>Component</th>
                            <th>Size</th>
                            <th>Files</th>
                            <th>Newest</th>
                            <th>Oldest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(opsSummary.storage.components).map(([key, stats]) => (
                            <tr key={`storage-${key}`}>
                              <td>{key}</td>
                              <td>{formatBytes(stats.bytes)}</td>
                              <td>{stats.files}</td>
                              <td>{stats.newest_mtime ? formatZulu(stats.newest_mtime) : "—"}</td>
                              <td>{stats.oldest_mtime ? formatZulu(stats.oldest_mtime) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="ops-section">
                    <div className="ops-section-title">Source Errors & Counters</div>
                    <div className="ops-table-wrap">
                      <table className="ops-table">
                        <thead>
                          <tr>
                            <th>Source</th>
                            <th>Success</th>
                            <th>Failure</th>
                            <th>Last Success</th>
                            <th>Last Failure</th>
                            <th>Last Error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(opsSummary.errors.sources).map(([source, s]) => (
                            <tr key={`err-${source}`}>
                              <td>{source}</td>
                              <td>{s.success}</td>
                              <td>{s.failure}</td>
                              <td>{s.last_success ? formatZulu(s.last_success) : "—"}</td>
                              <td>{s.last_failure ? formatZulu(s.last_failure) : "—"}</td>
                              <td className="ops-error-cell">{s.last_error ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {isOptionsOpen && (
        <div className="options-overlay" onClick={() => setIsOptionsOpen(false)}>
          <div className="options-content" onClick={(e) => e.stopPropagation()}>
            <div className="options-header">
              <h3>Options</h3>
              <button
                className="options-close"
                onClick={() => setIsOptionsOpen(false)}
                aria-label="Close options"
                type="button"
              >
                ×
              </button>
            </div>
            <div className="options-body">
              <div className="options-section">
                <div className="options-section-title">Display</div>
                <label className="options-check">
                  <input
                    type="checkbox"
                    checked={showStations}
                    onChange={(e) => setShowStations(e.target.checked)}
                  />
                  Show stations
                </label>
                <label className="options-check">
                  <input
                    type="checkbox"
                    checked={legendsCollapsed}
                    onChange={(e) => setLegendsCollapsed(e.target.checked)}
                  />
                  Collapse legends and colorbars
                </label>
                <label className="options-label">Obs Density</label>
                <select
                  className="density-select"
                  value={densityMode}
                  onChange={(e) => setDensityMode(e.target.value as DensityMode)}
                >
                  <option value="sparse">Sparse</option>
                  <option value="medium">Medium</option>
                  <option value="dense">Dense</option>
                </select>
                <label className="options-label">Surface Observation Mode</label>
                <select
                  className="surface-obs-select"
                  value={displayMode}
                  onChange={(e) => setSurfaceObsMode(e.target.value as DisplayMode)}
                  disabled={!showStations}
                >
                  <option value="plots">Station Plots</option>
                  <option value="dots">Colored Flight Rule</option>
                  <option value="weather">Weather Symbols Only</option>
                </select>
              </div>

              <div className="options-section">
                <div className="options-section-title">Timeline</div>
                <label className="options-label">Display Time Zone</label>
                <div className="wind-unit-row">
                  <button
                    type="button"
                    className={`control-btn ${displayTimeZone === "UTC" ? "active" : ""}`}
                    onClick={() => setDisplayTimeZone("UTC")}
                  >
                    UTC
                  </button>
                  <button
                    type="button"
                    className={`control-btn ${displayTimeZone === "LOCAL" ? "active" : ""}`}
                    onClick={() => setDisplayTimeZone("LOCAL")}
                  >
                    Local
                  </button>
                </div>
              </div>

              <div className="options-section">
                <div className="options-section-title">Wind</div>
                <label className="options-label">Objective Wind Render</label>
                <div className="wind-unit-row">
                  <button
                    type="button"
                    className={`control-btn ${windRenderMode === "barbs" ? "active" : ""}`}
                    onClick={() => setWindRenderMode("barbs")}
                  >
                    Barbs
                  </button>
                  <button
                    type="button"
                    className={`control-btn ${windRenderMode === "vectors" ? "active" : ""}`}
                    onClick={() => setWindRenderMode("vectors")}
                  >
                    Vectors
                  </button>
                </div>
                <label className="options-label">Wind Units</label>
                <div className="wind-unit-row">
                  <button
                    type="button"
                    className={`control-btn ${windUnit === "KT" ? "active" : ""}`}
                    onClick={() => setWindUnit("KT")}
                  >
                    KT
                  </button>
                  <button
                    type="button"
                    className={`control-btn ${windUnit === "MPH" ? "active" : ""}`}
                    onClick={() => setWindUnit("MPH")}
                  >
                    MPH
                  </button>
                  <button
                    type="button"
                    className={`control-btn ${windUnit === "KPH" ? "active" : ""}`}
                    onClick={() => setWindUnit("KPH")}
                  >
                    KPH
                  </button>
                </div>
              </div>

              <div className="options-section">
                <div className="options-section-title">NWS Products</div>
                <label className="options-label">WPC Front Render Style</label>
                <div className="wind-unit-row">
                  <button
                    type="button"
                    className={`control-btn ${frontRenderStyle === "simple" ? "active" : ""}`}
                    onClick={() => setFrontRenderStyle("simple")}
                  >
                    Simple Lines
                  </button>
                  <button
                    type="button"
                    className={`control-btn ${frontRenderStyle === "classic" ? "active" : ""}`}
                    onClick={() => setFrontRenderStyle("classic")}
                  >
                    Classic Front Symbols
                  </button>
                </div>
              </div>

              <div className="options-section">
                <div className="options-section-title">Units</div>
                <button
                  className={`temp-toggle-btn ${tempUnit === "F" ? "active" : ""}`}
                  onClick={toggleTempUnit}
                  type="button"
                  aria-label="Toggle temperature unit"
                >
                  <span>°F</span>
                  <span className="toggle-separator">/</span>
                  <span>°C</span>
                </button>
              </div>

              <div className="options-section">
                <div className="options-section-title">Export</div>
                <label className="options-check">
                  <input
                    type="checkbox"
                    checked={showCursorDiagnostics}
                    onChange={(e) => setShowCursorDiagnostics(e.target.checked)}
                  />
                  Cursor Readout Diagnostics
                </label>
                <label className="options-check">
                  <input
                    type="checkbox"
                    checked={includeLegendInExport}
                    onChange={(e) => setIncludeLegendInExport(e.target.checked)}
                  />
                  Include active legends in PNG download
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Station Details Popup */}
      {selectedStation && (
        <div className="popup-overlay" onClick={closePopup}>
          <div className="popup-content" onClick={(e) => e.stopPropagation()}>
            <div className="popup-header">
              <div>
                  <h3>{selectedStation.name} ({selectedStation.id})</h3>
                  {selectedStation.obsTimeUtc && (
                    <p className={obsAgeClass(selectedStation.obsTimeUtc)}>
                      {new Date(selectedStation.obsTimeUtc).toLocaleString()} ({formatAge(selectedStation.obsTimeUtc)})
                    </p>
                  )}
                  {hasQcFlags(selectedStation) && (
                    <div className="qc-banner">
                      Potentially bad data flagged for analysis.
                    </div>
                  )}
              </div>
              <button className="popup-close" onClick={closePopup} aria-label="Close">
                ×
              </button>
            </div>
            <div className="popup-body">
              {hasQcFlags(selectedStation) && (
                <div className="detail-section">
                  <div className="detail-section-title">Data Quality</div>
                  <ul className="qc-list">
                    {(selectedStation.qcFlags ?? []).map((flag, idx) => (
                      <li key={`${selectedStation.id}-popup-qc-${idx}`}>{flag}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="detail-section">
                <div className="detail-section-title">Flight Conditions</div>
                <div className="detail-row">
                  <span className="detail-label">Flight Rule:</span>
                  <span className={`flight-rule flight-rule-${selectedStation.flightRule.toLowerCase()}`}>
                    {selectedStation.flightRule}
                  </span>
                </div>
                {selectedStation.visibilityMi !== null && (
                  <div className="detail-row">
                    <span className="detail-label">Visibility:</span>
                    <span>{selectedStation.visibilityMi.toFixed(2)} SM</span>
                  </div>
                )}
                {selectedStation.ceilingFt !== null ? (
                  <div className="detail-row">
                    <span className="detail-label">Ceiling:</span>
                    <span>{selectedStation.ceilingFt.toFixed(0)} ft</span>
                  </div>
                ) : (
                  <div className="detail-row">
                    <span className="detail-label">Ceiling:</span>
                    <span>Unlimited</span>
                  </div>
                )}
                {selectedStation.skyConditions.length > 0 && (
                  <div className="detail-row">
                    <span className="detail-label">Sky Conditions:</span>
                    <span className="sky-conditions">
                      {selectedStation.skyConditions.map((sc, idx) => (
                        <span key={idx} className="sky-condition">
                          {sc.cover}
                          {sc.level_ft !== null && ` ${Math.round(sc.level_ft)}`}
                          {idx < selectedStation.skyConditions.length - 1 && ", "}
                        </span>
                      ))}
                    </span>
                  </div>
                )}
              </div>

              <div className="detail-section">
                <div className="detail-section-title">Temperature & Humidity</div>
                <div className="detail-row">
                  <span className="detail-label">Temperature:</span>
                  <span>{formatTempDetailed(selectedStation.tempC)}</span>
                </div>
                {selectedStation.dewpointC !== null && (
                  <div className="detail-row">
                    <span className="detail-label">Dewpoint:</span>
                    <span>{formatTempDetailed(selectedStation.dewpointC)}</span>
                  </div>
                )}
                {selectedStation.relativeHumidity !== null && (
                  <div className="detail-row">
                    <span className="detail-label">Relative Humidity:</span>
                    <span>{selectedStation.relativeHumidity.toFixed(1)}%</span>
                  </div>
                )}
              </div>

              <div className="detail-section">
                <div className="detail-section-title">Wind</div>
                {selectedStation.windSpeedKt !== null ? (
                  <>
                    <div className="detail-row">
                      <span className="detail-label">Wind Speed:</span>
                      <span>{formatWindSpeed(selectedStation.windSpeedKt)}</span>
                    </div>
                    {selectedStation.windGustKt !== null && (
                      <div className="detail-row">
                        <span className="detail-label">Wind Gust:</span>
                        <span>{formatWindSpeed(selectedStation.windGustKt)}</span>
                      </div>
                    )}
                    {selectedStation.windDirDeg !== null && (
                      <div className="detail-row">
                        <span className="detail-label">Wind Direction:</span>
                        <span>
                          {Math.round(selectedStation.windDirDeg)}° ({formatWindDirection(selectedStation.windDirDeg)})
                        </span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="detail-row">
                    <span className="detail-label">Wind:</span>
                    <span>Calm</span>
                  </div>
                )}
              </div>

              <div className="detail-section">
                <div className="detail-section-title">Pressure</div>

                {selectedStation.altimeterInhg !== null && (
                  <div className="detail-row">
                    <span className="detail-label">Altimeter:</span>
                    <span>{selectedStation.altimeterInhg.toFixed(2)} inHg</span>
                  </div>
                )}

                {selectedStation.pressureMb !== null && (
                  <div className="detail-row">
                    <span className="detail-label">Pressure (MSL):</span>
                    <span>
                      {selectedStation.pressureMb.toFixed(1)} mb
                      {selectedStation.pressureIsEstimated ? (
                        <span
                          style={{
                            marginLeft: 8,
                            padding: "2px 6px",
                            borderRadius: 6,
                            fontSize: 12,
                            fontWeight: 600,
                            border: "1px solid #f59e0b",
                            color: "#92400e",
                            background: "rgba(245, 158, 11, 0.12)",
                          }}
                          title="Sea-level pressure was computed from altimeter + elevation + temperature"
                        >
                          EST
                        </span>
                      ) : null}
                    </span>
                  </div>
                )}

                {selectedStation.pressureIsEstimated && selectedStation.pressureMb === null && (
                  <div className="detail-row">
                    <span className="detail-label">Pressure (MSL):</span>
                    <span>Estimated</span>
                  </div>
                )}
              </div>

              {selectedStation.weatherCodes && (
                <div className="detail-section">
                  <div className="detail-section-title">Weather</div>
                  <div className="detail-row">
                    <span className="detail-label">Weather Codes:</span>
                    <span>{selectedStation.weatherCodes}</span>
                  </div>
                </div>
              )}

              {selectedStation.rawMetar && (
                <div className="detail-section">
                  <div className="detail-section-title">Raw METAR</div>
                  <div className="raw-metar">
                    {selectedStation.rawMetar}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
