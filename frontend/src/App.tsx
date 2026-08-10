import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import MapGL, { Marker, NavigationControl, ViewState, Source, Layer, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
const APP_PROFILE = (import.meta.env.VITE_APP_PROFILE ?? "").trim().toLowerCase() || "default";
const LIVE_ONLY_PROFILE = ["railway", "railway_live", "live", "live_only"].includes(APP_PROFILE);
const RASTER_PRODUCTS_ENABLED = true;

function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${normalizedPath}` : normalizedPath;
}

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
type TimeBucketId =
  | "minus_360m"
  | "minus_300m"
  | "minus_240m"
  | "minus_180m"
  | "minus_120m"
  | "minus_60m"
  | "minus_45m"
  | "minus_30m"
  | "minus_15m"
  | "latest";
type MrmsField = "none" | "rala" | "composite" | "etop18" | "rotationll240" | "rotationml240" | "posh" | "mesh240";
type GoesProduct = "none" | `${string}-${"02" | "09" | "13"}`;
type GlmProduct = "none" | "east-conus-fed" | "west-conus-fed";
type GoesRenderStyle = "grayscale" | "enhanced";
type AnalysisFill = "none" | "windSpeed" | "ceiling" | "visibility" | "relativeHumidity";
type RrfsChartId = "none" | "925mb" | "850mb" | "700mb" | "500mb" | "300mb";
type FrontRenderStyle = "simple" | "classic";
type HazardMenuGroup =
  | "convectiveWatches"
  | "convectiveWarnings"
  | "floodWarnings"
  | "spcMesoscaleDiscussions"
  | "wpcMesoscaleDiscussions";
type HazardSectionId = "convectiveWarnings" | "spcConvectiveWatches" | "spcMesoscaleDiscussions" | "wpcMesoscaleDiscussions";
type NwsOverlayState = {
  wpcSurface: boolean;
  convectiveWatches: boolean;
  convectiveWarnings: boolean;
  floodWarnings: boolean;
  spcMesoscaleDiscussions: boolean;
  wpcMesoscaleDiscussions: boolean;
};

type TimeMatchMeta = {
  requested_time: string | null;
  matched_time: string;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
};

type MrmsMetaResponse = {
  product: "rala" | "composite" | "etop18" | "rotationll240" | "rotationml240" | "posh" | "mesh240";
  requested_time: string | null;
  matched_time: string;
  latest_time: string;
  matched_source?: string;
  latest_source?: string;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
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
  product: "rala" | "composite" | "etop18" | "rotationll240" | "rotationml240" | "posh" | "mesh240";
  requested_time: string | null;
  matched_time: string;
  latest_time: string;
  matched_source?: string;
  latest_source?: string;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
  age_minutes: number;
  stale_warning: boolean;
  lat: number;
  lon: number;
  unit?: string;
  value?: number | null;
  value_dbz: number | null;
};

type GoesMetaResponse = {
  product: string;
  satellite: "east" | "west";
  sector: string;
  band: "02" | "09" | "13";
  label: string;
  unit: string;
  render_style?: GoesRenderStyle;
  requested_time: string | null;
  matched_time: string;
  latest_time: string;
  matched_source?: string;
  latest_source?: string;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
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

type GoesValueResponse = {
  product: string;
  satellite: "east" | "west";
  sector: string;
  band: "02" | "09" | "13";
  label: string;
  requested_time: string | null;
  matched_time: string;
  latest_time: string;
  matched_source?: string;
  latest_source?: string;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
  age_minutes: number;
  stale_warning: boolean;
  lat: number;
  lon: number;
  unit: string;
  value?: number | null;
  raw_value?: number | null;
};

type GlmMetaResponse = {
  product: GlmProduct;
  satellite: "east" | "west";
  sector: string;
  label: string;
  unit: string;
  accumulation_minutes: number;
  requested_time: string | null;
  matched_time: string;
  latest_time: string;
  matched_source?: string;
  latest_source?: string;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
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

type GlmValueResponse = {
  product: GlmProduct;
  satellite: "east" | "west";
  sector: string;
  label: string;
  requested_time: string | null;
  matched_time: string;
  latest_time: string;
  matched_source?: string;
  latest_source?: string;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
  age_minutes: number;
  stale_warning: boolean;
  lat: number;
  lon: number;
  unit: string;
  value?: number | null;
  raw_value?: number | null;
};

type RrfsChartMetaResponse = {
  chart: Exclude<RrfsChartId, "none">;
  label: string;
  requested_time: string;
  matched_time: string;
  latest_time: string;
  valid_time: string;
  init_time: string;
  forecast_hour: number;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
  rounded_valid_time?: string;
  age_minutes: number;
  stale_warning: boolean;
  grid_spacing_km: number;
  source_key: string;
};

type RrfsChartResponse = RrfsChartMetaResponse & {
  contours: GeoJsonFeatureCollection;
  winds: GeoJsonFeatureCollection;
  wind_fill?: GeoJsonFeatureCollection;
  rh_fill?: GeoJsonFeatureCollection;
  vort_fill?: GeoJsonFeatureCollection;
};

type RrfsChartValueResponse = RrfsChartMetaResponse & {
  lat: number;
  lon: number;
  height_m?: number | null;
  temperature_c?: number | null;
  dewpoint_c?: number | null;
  relative_humidity_pct?: number | null;
  absolute_vorticity_s1?: number | null;
  divergence_s1?: number | null;
  wind_dir_deg?: number | null;
  wind_speed_kt?: number | null;
};

type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: any[];
};

type HazardListItem = {
  id: string;
  kind: string;
  group: "warnings" | "watches" | "discussions";
  menu_group: HazardMenuGroup;
  label: string;
  product_number: string | null;
  title: string;
  issued_at: string | null;
  ends_at: string | null;
  states: string[];
  coverage_counties?: string[];
  text_url: string | null;
  discussion_text: string | null;
  summary: string | null;
  bbox: [number, number, number, number] | null;
};

type HazardSummaryResponse = {
  requested_time: string | null;
  matched_time: string | null;
  match_status: string;
  match_delta_minutes: number;
  history_retention_hours: number;
  fetched_at: string | null;
  last_error: string | null;
  current: {
    warnings: HazardListItem[];
    watches: HazardListItem[];
    discussions: HazardListItem[];
  };
  matched: GeoJsonFeatureCollection;
};

type WpcSurfaceResponse = {
  product: "wpc_surface";
  source_url: string;
  fetched_at: string;
  requested_time?: string | null;
  matched_time?: string | null;
  match_status?: string;
  match_delta_minutes?: number;
  match_tolerance_minutes?: number | null;
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

type ObsSnapshotResponse = {
  generated_at: string;
  stations: SurfaceObs[];
  requested_time: string;
  snapshot_time: string;
  match_status: string;
  match_delta_minutes: number;
  match_tolerance_minutes: number;
};

type DataLayerStatus = {
  key: string;
  label: string;
  state: "matched" | "dropped";
  detail: string;
};

type LoadStageState = "idle" | "loading" | "ready" | "error";

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
        latest_source?: string | null;
        listing_latest_time?: string | null;
        alias_latest_time?: string | null;
        available_count: number;
        last_error?: string | null;
      };
      composite: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        latest_source?: string | null;
        listing_latest_time?: string | null;
        alias_latest_time?: string | null;
        available_count: number;
        last_error?: string | null;
      };
      etop18: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        latest_source?: string | null;
        listing_latest_time?: string | null;
        alias_latest_time?: string | null;
        available_count: number;
        last_error?: string | null;
      };
      rotationll240: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        latest_source?: string | null;
        listing_latest_time?: string | null;
        alias_latest_time?: string | null;
        available_count: number;
        last_error?: string | null;
      };
      rotationml240: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        latest_source?: string | null;
        listing_latest_time?: string | null;
        alias_latest_time?: string | null;
        available_count: number;
        last_error?: string | null;
      };
      posh: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        latest_source?: string | null;
        listing_latest_time?: string | null;
        alias_latest_time?: string | null;
        available_count: number;
        last_error?: string | null;
      };
      mesh240: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        latest_source?: string | null;
        listing_latest_time?: string | null;
        alias_latest_time?: string | null;
        available_count: number;
        last_error?: string | null;
      };
    };
    glm: {
      east_conus_fed: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        latest_source?: string | null;
        available_count: number;
        last_error?: string | null;
      };
      west_conus_fed: {
        status: string;
        latest_time: string | null;
        latest_age_minutes: number | null;
        latest_source?: string | null;
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
const POSH_LEGEND_ITEMS = [
  { color: "#dc0000", label: "90-100%" },
  { color: "#c83c00", label: "80-90%" },
  { color: "#e68200", label: "70-80%" },
  { color: "#e6e600", label: "60-70%" },
  { color: "#006e00", label: "50-60%" },
  { color: "#00aa00", label: "40-50%" },
  { color: "#00e600", label: "30-40%" },
  { color: "#0000c8", label: "20-30%" },
  { color: "#00b4c8", label: "10-20%" },
  { color: "#00e6e6", label: "1-10%" },
];
const MESH240_LEGEND_ITEMS = [
  { color: "#ffb4ff", label: ">4.00 in" },
  { color: "#a000a0", label: "3.00–4.00 in" },
  { color: "#c80000", label: "2.50–3.00 in" },
  { color: "#dc5000", label: "2.00–2.50 in" },
  { color: "#f09600", label: "1.75–2.00 in" },
  { color: "#f0dc00", label: "1.50–1.75 in" },
  { color: "#c8dc32", label: "1.25–1.50 in" },
  { color: "#32aa32", label: "1.00–1.25 in" },
  { color: "#64c864", label: "0.75–1.00 in" },
  { color: "#b4dcb4", label: "0.50–0.75 in" },
];
const GOES_MENU_GROUPS = [
  { id: "east-conus", title: "GOES-E CONUS" },
  { id: "west-conus", title: "GOES-W CONUS" },
] as const;
const GOES_BAND_OPTIONS = [
  { band: "02", label: "Band 2 Visible" },
  { band: "13", label: "Band 13 Clean IR" },
  { band: "09", label: "Band 9 Water Vapor" },
] as const;
const GLM_OPTIONS = [
  { product: "east-conus-fed", label: "GOES-E CONUS 5-min FED" },
  { product: "west-conus-fed", label: "GOES-W CONUS 5-min FED" },
] as const;
const GLM_LEGEND_ITEMS = [
  { color: "#dc2626", label: "20+" },
  { color: "#ff8c00", label: "10-19" },
  { color: "#ffd700", label: "5-9" },
  { color: "#4682b4", label: "2-4" },
  { color: "#add8e6", label: "1" },
];
const RRFS_850_WIND_FILL_BINS_KT = [30, 35, 40, 45, 50, 55, 60, 65, 70, Number.POSITIVE_INFINITY];
const RRFS_850_WIND_FILL_COLORS = [
  "#0d0887",
  "#5b02a3",
  "#8b0aa5",
  "#b12a90",
  "#cc4778",
  "#e16462",
  "#f1834b",
  "#fca636",
  "#f0f921",
];
const RRFS_300_WIND_FILL_BINS_KT = [60, 90, 120, 150, 180, 210, Number.POSITIVE_INFINITY];
const RRFS_300_WIND_FILL_COLORS = [
  "#0d0887",
  "#8b0aa5",
  "#cc4778",
  "#f1834b",
  "#fca636",
  "#f0f921",
];
const RRFS_700_RH_FILL_BINS_PCT = [75, 80, 85, 90, 95, 100, Number.POSITIVE_INFINITY];
const RRFS_700_RH_FILL_COLORS = [
  "#dcfce7",
  "#bbf7d0",
  "#86efac",
  "#4ade80",
  "#22c55e",
  "#166534",
];
const RRFS_500_VORT_MASK_MIN = 15;
const RRFS_500_VORT_MIN = 5;
const RRFS_500_VORT_MAX = 45;
const RRFS_500_VORT_STRETCH_EXPONENT = 0.65;
const RRFS_500_VORT_GRADIENT = "linear-gradient(to top, #000004 0%, #180f3d 18%, #440f76 36%, #721f81 52%, #9e2f7f 66%, #cd4071 79%, #f1605d 90%, #fd9668 96%, #feca8d 100%)";
const GOES_VISIBLE_GRADIENT = "linear-gradient(to top, #000000 0%, #3a3a3a 20%, #7a7a7a 45%, #bdbdbd 70%, #ffffff 100%)";
const GOES_IR_GRAYSCALE_GRADIENT = "linear-gradient(to top, #f5f5f5 0%, #d7d7d7 18%, #b0b0b0 34%, #7f7f7f 52%, #4f4f4f 72%, #1a1a1a 100%)";
const GOES_IR_GRADIENT = "linear-gradient(to top, #f5f5f5 0%, #c8c8c8 12%, #969696 28%, #646464 40%, #00e6ff 48%, #0046ff 58%, #5ae600 68%, #fff500 78%, #dc0000 88%, #400060 96%, #121212 100%)";
const GOES_WV_GRADIENT = "linear-gradient(to top, #f0dc00 0%, #ff7878 8%, #dc0000 14%, #5a0000 20%, #ff9100 29%, #783714 36%, #505050 45%, #6e6e6e 52%, #969696 59%, #cdcdcd 66%, #fafafa 72%, #2828dc 80%, #00dc00 87%, #ffb900 93%, #dc2d00 97%, #fff5aa 100%)";
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
  if (product === "rotationll240") return "4-Hour Low-Level Rotation Tracks";
  if (product === "rotationml240") return "4-Hour Mid-Level Rotation Tracks";
  if (product === "posh") return "Probability of Severe Hail (POSH)";
  if (product === "mesh240") return "4-Hour Maximum Estimated Hail Size (MESH)";
  return "MRMS";
}

function getMrmsProductUnit(product: MrmsField): string {
  if (product === "etop18") return "kft";
  if (product === "rotationll240" || product === "rotationml240") return "1/s";
  if (product === "posh") return "%";
  if (product === "mesh240") return "in";
  return "dBZ";
}

function isValidGoesProduct(value: string | null): value is GoesProduct {
  if (value == null) return false;
  if (value === "none") return true;
  return GOES_MENU_GROUPS.some((group) =>
    GOES_BAND_OPTIONS.some((band) => value === `${group.id}-${band.band}`)
  );
}

function getGoesMenuTitle(product: GoesProduct): string {
  if (product === "none") return "GOES Satellite";
  const groupId = product.slice(0, -3);
  return GOES_MENU_GROUPS.find((group) => group.id === groupId)?.title ?? "GOES Satellite";
}

function getGoesProductLabel(product: GoesProduct): string {
  if (product === "none") return "GOES Satellite";
  const groupId = product.slice(0, -3);
  const band = product.slice(-2) as "02" | "09" | "13";
  const group = GOES_MENU_GROUPS.find((item) => item.id === groupId);
  const bandLabel = GOES_BAND_OPTIONS.find((item) => item.band === band)?.label ?? `Band ${band}`;
  return `${group?.title ?? "GOES"} ${bandLabel}`;
}

function getGoesProductUnit(product: GoesProduct): string {
  if (product.endsWith("-02")) return "%";
  if (product.endsWith("-09") || product.endsWith("-13")) return "°C";
  return "";
}

function formatGoesCursorValue(product: GoesProduct, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (product.endsWith("-02")) return `${value.toFixed(1)}%`;
  return `${value.toFixed(1)}°C`;
}

function isValidGlmProduct(value: string | null): value is GlmProduct {
  if (value == null) return false;
  if (value === "none") return true;
  return GLM_OPTIONS.some((option) => option.product === value);
}

function getGlmProductLabel(product: GlmProduct): string {
  if (product === "none") return "GLM Lightning";
  return GLM_OPTIONS.find((option) => option.product === product)?.label ?? "GLM Lightning";
}

function formatGlmCursorValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(1);
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
const ARTCC_BOUNDARIES_URL = apiUrl("/api/geography/artcc");
const TIME_BUCKETS: Array<{ id: TimeBucketId; label: string; minutesAgo: number | null }> = [
  { id: "minus_360m", label: "6h", minutesAgo: 360 },
  { id: "minus_300m", label: "5h", minutesAgo: 300 },
  { id: "minus_240m", label: "4h", minutesAgo: 240 },
  { id: "minus_180m", label: "3h", minutesAgo: 180 },
  { id: "minus_120m", label: "2h", minutesAgo: 120 },
  { id: "minus_60m", label: "1h", minutesAgo: 60 },
  { id: "minus_45m", label: "45m", minutesAgo: 45 },
  { id: "minus_30m", label: "30m", minutesAgo: 30 },
  { id: "minus_15m", label: "15m", minutesAgo: 15 },
  { id: "latest", label: "Latest", minutesAgo: null },
];
const LIVE_ONLY_TIME_BUCKETS = TIME_BUCKETS.filter((bucket) => bucket.id === "latest");
const HAZARD_STYLE_BY_KIND: Record<string, { color: string; width: number; label: string; menuGroup: HazardMenuGroup }> = {
  tornado_watch: { color: "#dc2626", width: 2, label: "Tornado Watch", menuGroup: "convectiveWatches" },
  severe_thunderstorm_watch: { color: "#ca8a04", width: 2, label: "Severe Thunderstorm Watch", menuGroup: "convectiveWatches" },
  tornado_warning: { color: "#dc2626", width: 4, label: "Tornado Warning", menuGroup: "convectiveWarnings" },
  severe_thunderstorm_warning: { color: "#ca8a04", width: 4, label: "Severe Thunderstorm Warning", menuGroup: "convectiveWarnings" },
  flash_flood_warning: { color: "#16a34a", width: 4, label: "Flash Flood Warning", menuGroup: "floodWarnings" },
  spc_md: { color: "#2563eb", width: 4, label: "SPC Mesoscale Discussion", menuGroup: "spcMesoscaleDiscussions" },
  wpc_mpd: { color: "#166534", width: 4, label: "WPC Mesoscale Discussion", menuGroup: "wpcMesoscaleDiscussions" },
};
const HAZARD_LAYER_IDS = Object.keys(HAZARD_STYLE_BY_KIND).map((kind) => `hazard-${kind}`);

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

function formatTimestampWithSeconds(iso: string | null, zone: DisplayTimeZone): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  if (zone === "UTC") return d.toISOString().slice(11, 19) + "Z";
  const timePart = d.toLocaleTimeString([], { hour12: false });
  const tzPart = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  return tzPart ? `${timePart} ${tzPart}` : timePart;
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

function formatMrmsFreshnessNotes(source: {
  latest_source?: string | null;
  listing_latest_time?: string | null;
  alias_latest_time?: string | null;
  available_count: number;
}): string {
  const parts = [`${source.available_count} times`];
  if (source.latest_source) parts.push(`selected: ${source.latest_source}`);
  if (source.listing_latest_time) parts.push(`listing: ${formatZulu(source.listing_latest_time)}`);
  if (source.alias_latest_time) parts.push(`alias: ${formatZulu(source.alias_latest_time)}`);
  return parts.join(" | ");
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

function getTimeBucketById(
  id: TimeBucketId,
  buckets: Array<{ id: TimeBucketId; label: string; minutesAgo: number | null }> = TIME_BUCKETS
) {
  return buckets.find((bucket) => bucket.id === id) ?? buckets[buckets.length - 1];
}

function describeMatchDetail(
  meta: TimeMatchMeta,
  zone: DisplayTimeZone,
  latestLabel = "Showing latest available data"
): string {
  if (!meta.requested_time || meta.match_status === "latest") {
    return `${latestLabel} (product time: ${formatTimestampWithSeconds(meta.matched_time, zone)}).`;
  }
  const delta = meta.match_delta_minutes;
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return `Showing matched frame (product time: ${formatTimestampWithSeconds(meta.matched_time, zone)}).`;
  }
  if (Math.abs(delta) < 0.05) {
    return `Matched target exactly (product time: ${formatTimestampWithSeconds(meta.matched_time, zone)}).`;
  }
  const rounded = Math.abs(Math.round(delta));
  const tense = delta > 0 ? "late" : "early";
  const minuteLabel = rounded === 1 ? "minute" : "minutes";
  return `Matched ${rounded} ${minuteLabel} ${tense} (product time: ${formatTimestampWithSeconds(meta.matched_time, zone)}).`;
}

function formatDateTimeShort(iso: string | null, zone: DisplayTimeZone): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  if (zone === "UTC") return d.toISOString().slice(5, 16).replace("T", " ") + "Z";
  return d.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatStatesCompact(states: string[] | null | undefined): string {
  if (!states || states.length === 0) return "—";
  return states.join(", ");
}

function formatCoverageCounties(counties: string[] | null | undefined): string {
  if (!counties || counties.length === 0) return "—";
  return counties.join("...");
}

function formatCoverageCountiesCompact(counties: string[] | null | undefined): string {
  if (!counties || counties.length === 0) return "—";
  const limited = counties.slice(0, 10);
  let text = limited.join("...");
  if (counties.length > 10) text += "...";
  return text;
}

function getRrfsChartLabel(chart: RrfsChartId | null | undefined): string {
  if (chart === "925mb") return "RRFS 925 MB Analysis";
  if (chart === "850mb") return "RRFS 850 MB Analysis";
  if (chart === "700mb") return "RRFS 700 MB Analysis";
  if (chart === "500mb") return "RRFS 500 MB Analysis";
  if (chart === "300mb") return "RRFS 300 MB Analysis";
  return "RRFS Analysis";
}

function getRrfsLevelLabel(chart: Exclude<RrfsChartId, "none">): string {
  if (chart === "925mb") return "925";
  if (chart === "850mb") return "850";
  if (chart === "700mb") return "700";
  if (chart === "500mb") return "500";
  return "300";
}

function getRrfsHeightInterval(chart: Exclude<RrfsChartId, "none">): number {
  if (chart === "500mb") return 60;
  if (chart === "300mb") return 120;
  return 30;
}

function rrfs850WindFillColor(speedKt: number): string | null {
  if (!Number.isFinite(speedKt) || speedKt < 30) return null;
  const upperBounds = RRFS_850_WIND_FILL_BINS_KT.slice(1);
  for (let i = 0; i < upperBounds.length; i++) {
    if (speedKt < upperBounds[i]) return RRFS_850_WIND_FILL_COLORS[i];
  }
  return RRFS_850_WIND_FILL_COLORS[RRFS_850_WIND_FILL_COLORS.length - 1] ?? null;
}

function rrfs300WindFillColor(speedKt: number): string | null {
  if (!Number.isFinite(speedKt) || speedKt < 60) return null;
  const upperBounds = RRFS_300_WIND_FILL_BINS_KT.slice(1);
  for (let i = 0; i < upperBounds.length; i++) {
    if (speedKt < upperBounds[i]) return RRFS_300_WIND_FILL_COLORS[i];
  }
  return RRFS_300_WIND_FILL_COLORS[RRFS_300_WIND_FILL_COLORS.length - 1] ?? null;
}

function rrfs700RhFillColor(relativeHumidityPct: number): string | null {
  if (!Number.isFinite(relativeHumidityPct) || relativeHumidityPct < 75) return null;
  const upperBounds = RRFS_700_RH_FILL_BINS_PCT.slice(1);
  for (let i = 0; i < upperBounds.length; i++) {
    if (relativeHumidityPct < upperBounds[i]) return RRFS_700_RH_FILL_COLORS[i];
  }
  return RRFS_700_RH_FILL_COLORS[RRFS_700_RH_FILL_COLORS.length - 1] ?? null;
}

function rrfs500VortFillColor(vorticityS1: number): string | null {
  if (!Number.isFinite(vorticityS1)) return null;
  const scaled = vorticityS1 * 1e5;
  if (scaled < RRFS_500_VORT_MASK_MIN) return null;
  const normalized = Math.max(0, Math.min(1, (scaled - RRFS_500_VORT_MIN) / (RRFS_500_VORT_MAX - RRFS_500_VORT_MIN)));
  const t = Math.pow(normalized, RRFS_500_VORT_STRETCH_EXPONENT);
  const stops = [
    { t: 0.0, c: [0, 0, 4] },
    { t: 0.18, c: [24, 15, 61] },
    { t: 0.36, c: [68, 15, 118] },
    { t: 0.52, c: [114, 31, 129] },
    { t: 0.66, c: [158, 47, 127] },
    { t: 0.79, c: [205, 64, 113] },
    { t: 0.9, c: [241, 96, 93] },
    { t: 0.96, c: [253, 150, 104] },
    { t: 1.0, c: [254, 202, 141] },
  ];
  let i = 0;
  while (i < stops.length - 1 && t > stops[i + 1].t) i++;
  const a = stops[i];
  const b = stops[Math.min(i + 1, stops.length - 1)];
  const localT = (t - a.t) / Math.max(1e-9, b.t - a.t);
  const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * localT);
  const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * localT);
  const bl = Math.round(a.c[2] + (b.c[2] - a.c[2]) * localT);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
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
  // Rounded warm-front pip whose endpoints are anchored on the front line.
  // Fill the dome, but only stroke the curved edge so the diameter does not
  // read as a clipped flat cut through the symbol.
  const r = size * 0.72;
  const ex1 = x - tx * r;
  const ey1 = y - ty * r;
  const ex2 = x + tx * r;
  const ey2 = y + ty * r;
  const cx = x + nx * r * 1.2;
  const cy = y + ny * r * 1.2;

  ctx.beginPath();
  ctx.moveTo(ex1, ey1);
  ctx.quadraticCurveTo(cx, cy, ex2, ey2);
  ctx.lineTo(ex1, ey1);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(ex1, ey1);
  ctx.quadraticCurveTo(cx, cy, ex2, ey2);
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawAlternatingStationaryFrontLine(
  ctx: CanvasRenderingContext2D,
  points: ScreenPoint[],
  lineWidth: number,
  zoom: number
) {
  // Solid red/blue alternating chunks along the same line.
  const chunk = zoom < 5 ? 16 : zoom < 7 ? 20 : 24;

  const drawPass = (color: string, offset: number) => {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([chunk, chunk]);
    ctx.lineDashOffset = offset;
    ctx.stroke();
  };

  drawPass("#dc2626", 0);
  drawPass("#2563eb", chunk);
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
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
  const activeTimeBuckets = LIVE_ONLY_PROFILE ? LIVE_ONLY_TIME_BUCKETS : TIME_BUCKETS;
  const [obs, setObs] = useState<SurfaceObs[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewState, setViewState] = useState<ViewState>({
    longitude: -97.5,
    latitude: 38.5,
    zoom: 3.35,
    bearing: 0,
    pitch: 0,
    padding: { top: 0, left: 0, bottom: 0, right: 0 },
  });
  const [selectedTimeBucket, setSelectedTimeBucket] = useState<TimeBucketId>(() => {
    if (LIVE_ONLY_PROFILE) return "latest";
    const saved = localStorage.getItem("selectedTimeBucket");
    return TIME_BUCKETS.some((bucket) => bucket.id === saved) ? (saved as TimeBucketId) : "latest";
  });
  const [currentTimeTick, setCurrentTimeTick] = useState<number>(() => Date.now());
  const [obsMatchMeta, setObsMatchMeta] = useState<TimeMatchMeta | null>(null);

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
  const rrfsFillCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rrfsContourCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rrfsWindCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analysisGridRef = useRef<AnalysisGridStore>({});
  const animationFrameRef = useRef<number | null>(null);
  const analysisAnimationFrameRef = useRef<number | null>(null);
  const analysisThrottleTimeoutRef = useRef<number | null>(null);
  const analysisLastDrawRef = useRef<number>(0);
  const wpcFrontAnimationFrameRef = useRef<number | null>(null);
  const rrfsAnimationFrameRef = useRef<number | null>(null);
  const rrfsThrottleTimeoutRef = useRef<number | null>(null);
  const rrfsLastDrawRef = useRef<number>(0);
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
  const [hazardBootstrapReady, setHazardBootstrapReady] = useState(false);
  
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
          src: url("${apiUrl("/api/metpy/wx_font")}") format("truetype");
          font-display: swap;
        }
      `;
      document.head.appendChild(styleEl);
    }

    const loadGlyphMap = async () => {
      try {
        const res = await fetch(apiUrl("/api/metpy/wx_symbol_map"));
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

    const glyphLoad =
      "requestIdleCallback" in window
        ? window.requestIdleCallback(() => {
            loadGlyphMap();
          }, { timeout: 1500 })
        : window.setTimeout(() => {
            loadGlyphMap();
          }, 250);
    loadFont();

    return () => {
      cancelled = true;
      if ("cancelIdleCallback" in window) {
        window.cancelIdleCallback(glyphLoad as number);
      } else {
        window.clearTimeout(glyphLoad as number);
      }
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

  const selectedBucket = useMemo(
    () => getTimeBucketById(selectedTimeBucket, activeTimeBuckets),
    [activeTimeBuckets, selectedTimeBucket]
  );
  const requestedTimeIso = useMemo(() => {
    if (selectedBucket.minutesAgo == null) return null;
    return new Date(currentTimeTick - selectedBucket.minutesAgo * 60_000).toISOString();
  }, [currentTimeTick, selectedBucket]);

  const fetchObservations = useCallback(async (requestedIso: string | null) => {
    inflightRef.current?.abort();
    const ac = new AbortController();
    inflightRef.current = ac;
    setObsLoadState("loading");

    try {
      if (requestedIso === null) {
        const res = await fetch(apiUrl("/api/obs/latest"), { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const stations: SurfaceObs[] = data.stations ?? [];
        const generatedAt = data.generated_at ?? null;
        if (generatedAt) obsCacheRef.current.set(generatedAt, stations);
        setObs(stations);
        setLastUpdate(generatedAt);
        setObsMatchMeta(
          generatedAt
            ? {
                requested_time: null,
                matched_time: generatedAt,
                match_status: "latest",
                match_delta_minutes: 0,
                match_tolerance_minutes: null,
              }
            : null
        );
        setIsLoading(false);
        setObsLoadState("ready");
        return;
      }

      const res = await fetch(apiUrl(`/api/obs/at?time=${encodeURIComponent(requestedIso)}`), {
        signal: ac.signal,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ObsSnapshotResponse;
      const stations: SurfaceObs[] = data.stations ?? [];
      obsCacheRef.current.set(data.snapshot_time ?? requestedIso, stations);
      setObs(stations);
      setLastUpdate(data.snapshot_time ?? data.generated_at ?? requestedIso);
      setObsMatchMeta({
        requested_time: data.requested_time,
        matched_time: data.snapshot_time,
        match_status: data.match_status,
        match_delta_minutes: data.match_delta_minutes,
        match_tolerance_minutes: data.match_tolerance_minutes,
      });
      setIsLoading(false);
      setObsLoadState("ready");
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      console.error("Failed to fetch observations:", e);
      setObs([]);
      setObsMatchMeta(null);
      setIsLoading(false);
      setObsLoadState("error");
    }
  }, []);

  const [showStations, setShowStations] = useState<boolean>(() => {
    const saved = localStorage.getItem("showStations");
    return saved === null ? true : saved === "true";
  });

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
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        setOpenHeaderMenu(null);
        return;
      }
      if (target.closest(".analysis-control, .geography-control")) return;
      setOpenHeaderMenu(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const [displayTimeZone, setDisplayTimeZone] = useState<DisplayTimeZone>(() => {
    const saved = localStorage.getItem("displayTimeZone");
    return saved === "LOCAL" || saved === "UTC" ? (saved as DisplayTimeZone) : "UTC";
  });

  const [mrmsField, setMrmsField] = useState<MrmsField>(() => {
    if (!RASTER_PRODUCTS_ENABLED) return "none";
    const saved = localStorage.getItem("mrmsField");
    if (saved === "rotation240") return "rotationll240";
    return saved === "rala"
      || saved === "composite"
      || saved === "etop18"
      || saved === "rotationll240"
      || saved === "rotationml240"
      || saved === "posh"
      || saved === "mesh240"
      ? (saved as MrmsField)
      : "none";
  });
  const [goesProduct, setGoesProduct] = useState<GoesProduct>(() => {
    if (!RASTER_PRODUCTS_ENABLED) return "none";
    const saved = localStorage.getItem("goesProduct");
    return isValidGoesProduct(saved) ? saved : "none";
  });
  const [glmProduct, setGlmProduct] = useState<GlmProduct>(() => {
    if (!RASTER_PRODUCTS_ENABLED) return "none";
    const saved = localStorage.getItem("glmProduct");
    return isValidGlmProduct(saved) ? saved : "none";
  });
  const [rrfsChart] = useState<RrfsChartId>("none");
  const [goesRenderStyle, setGoesRenderStyle] = useState<GoesRenderStyle>(() => {
    const saved = localStorage.getItem("goesRenderStyle");
    return saved === "grayscale" || saved === "enhanced" ? saved : "enhanced";
  });
  const [mrmsMeta, setMrmsMeta] = useState<MrmsMetaResponse | null>(null);
  const [mrmsError, setMrmsError] = useState<string | null>(null);
  const [mrmsCursorValue, setMrmsCursorValue] = useState<number | null>(null);
  const [goesMeta, setGoesMeta] = useState<GoesMetaResponse | null>(null);
  const [goesError, setGoesError] = useState<string | null>(null);
  const [goesCursorValue, setGoesCursorValue] = useState<number | null>(null);
  const [glmMeta, setGlmMeta] = useState<GlmMetaResponse | null>(null);
  const [glmError, setGlmError] = useState<string | null>(null);
  const [glmCursorValue, setGlmCursorValue] = useState<number | null>(null);
  const [rrfsMeta, setRrfsMeta] = useState<RrfsChartMetaResponse | null>(null);
  const [rrfsContoursGeoJson, setRrfsContoursGeoJson] = useState<GeoJsonFeatureCollection | null>(null);
  const [rrfsWindsGeoJson, setRrfsWindsGeoJson] = useState<GeoJsonFeatureCollection | null>(null);
  const [rrfsFillGeoJson, setRrfsFillGeoJson] = useState<GeoJsonFeatureCollection | null>(null);
  const [rrfsError, setRrfsError] = useState<string | null>(null);
  const [rrfsCursorValue, setRrfsCursorValue] = useState<RrfsChartValueResponse | null>(null);
  const [obsLoadState, setObsLoadState] = useState<LoadStageState>("loading");
  const [analysisLoadState, setAnalysisLoadState] = useState<LoadStageState>("idle");
  const [mrmsLoadState, setMrmsLoadState] = useState<LoadStageState>("idle");
  const [goesLoadState, setGoesLoadState] = useState<LoadStageState>("idle");
  const [glmLoadState, setGlmLoadState] = useState<LoadStageState>("idle");
  const [rrfsLoadState, setRrfsLoadState] = useState<LoadStageState>("idle");
  const [hazardLoadState, setHazardLoadState] = useState<LoadStageState>("loading");
  const [wpcLoadState, setWpcLoadState] = useState<LoadStageState>("idle");
  const [nwsOverlays, setNwsOverlays] = useState<NwsOverlayState>(() => {
    const raw = localStorage.getItem("nwsOverlays");
    if (!raw) {
      return {
        wpcSurface: false,
        convectiveWatches: true,
        convectiveWarnings: true,
        floodWarnings: true,
        spcMesoscaleDiscussions: true,
        wpcMesoscaleDiscussions: true,
      };
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        wpcSurface: parsed?.wpcSurface === true,
        convectiveWatches: parsed?.convectiveWatches !== false,
        convectiveWarnings: parsed?.convectiveWarnings !== false,
        floodWarnings: parsed?.floodWarnings !== false,
        spcMesoscaleDiscussions: parsed?.spcMesoscaleDiscussions !== false,
        wpcMesoscaleDiscussions: parsed?.wpcMesoscaleDiscussions !== false,
      };
    } catch {
      return {
        wpcSurface: false,
        convectiveWatches: true,
        convectiveWarnings: true,
        floodWarnings: true,
        spcMesoscaleDiscussions: true,
        wpcMesoscaleDiscussions: true,
      };
    }
  });
  const [hazardSummary, setHazardSummary] = useState<HazardSummaryResponse | null>(null);
  const [hazardError, setHazardError] = useState<string | null>(null);
  const [selectedHazard, setSelectedHazard] = useState<HazardListItem | null>(null);
  const [hazardSectionOpen, setHazardSectionOpen] = useState<Record<HazardSectionId, boolean>>(() => {
    const raw = localStorage.getItem("hazardSectionOpen");
    const defaults = {
      convectiveWarnings: false,
      spcConvectiveWatches: false,
      spcMesoscaleDiscussions: false,
      wpcMesoscaleDiscussions: false,
    };
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw);
      return {
        convectiveWarnings: parsed?.convectiveWarnings === true,
        spcConvectiveWatches: parsed?.spcConvectiveWatches === true,
        spcMesoscaleDiscussions: parsed?.spcMesoscaleDiscussions === true,
        wpcMesoscaleDiscussions: parsed?.wpcMesoscaleDiscussions === true,
      };
    } catch {
      return defaults;
    }
  });
  const [wpcSurface, setWpcSurface] = useState<WpcSurfaceResponse | null>(null);
  const [wpcError, setWpcError] = useState<string | null>(null);
  const [isOpsOpen, setIsOpsOpen] = useState(false);

  useEffect(() => {
    localStorage.removeItem("rrfsContours");
  }, []);
  const [opsSummary, setOpsSummary] = useState<OpsSummaryResponse | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsLoading, setOpsLoading] = useState(false);
  const [frontRenderStyle, setFrontRenderStyle] = useState<FrontRenderStyle>(() => {
    const saved = localStorage.getItem("frontRenderStyle");
    return saved === "simple" || saved === "classic" ? saved : "classic";
  });
  const [openHeaderMenu, setOpenHeaderMenu] = useState<string | null>(null);

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

  const zoomToHazard = useCallback((item: HazardListItem) => {
    if (!item.bbox) return;
    const [minLon, minLat, maxLon, maxLat] = item.bbox;
    const map = mapRef.current?.getMap();
    if (!map) return;
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 48, duration: 650, maxZoom: 8.5 }
    );
  }, []);

  useEffect(() => {
    if (requestedTimeIso === null) return;
    fetchObservations(requestedTimeIso);
  }, [fetchObservations, requestedTimeIso]);

  useEffect(() => {
    if (requestedTimeIso !== null) return;
    fetchObservations(null);
  }, [fetchObservations, requestedTimeIso, currentTimeTick]);

  useEffect(() => {
    const id = window.setTimeout(() => setHazardBootstrapReady(true), 1500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setCurrentTimeTick(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (LIVE_ONLY_PROFILE) return;
    if (!isPlaying) return;
    const currentIndex = activeTimeBuckets.findIndex((bucket) => bucket.id === selectedTimeBucket);
    if (currentIndex < 0) return;
    const isLatestBucket = currentIndex >= activeTimeBuckets.length - 1;
    const delay = isLatestBucket ? playSpeedMs * 2 : playSpeedMs;

    const id = window.setTimeout(() => {
      setSelectedTimeBucket((prev) => {
        const prevIndex = activeTimeBuckets.findIndex((bucket) => bucket.id === prev);
        if (prevIndex < 0 || prevIndex >= activeTimeBuckets.length - 1) return activeTimeBuckets[0].id;
        return activeTimeBuckets[prevIndex + 1].id;
      });
    }, delay);

    return () => window.clearTimeout(id);
  }, [activeTimeBuckets, isPlaying, playSpeedMs, selectedTimeBucket]);

  useEffect(() => {
    if (!LIVE_ONLY_PROFILE) return;
    if (selectedTimeBucket !== "latest") setSelectedTimeBucket("latest");
    if (isPlaying) setIsPlaying(false);
  }, [isPlaying, selectedTimeBucket]);

  useEffect(() => {
    if (!RASTER_PRODUCTS_ENABLED) {
      if (mrmsField !== "none") setMrmsField("none");
      if (goesProduct !== "none") setGoesProduct("none");
      if (glmProduct !== "none") setGlmProduct("none");
    }
  }, [glmProduct, goesProduct, mrmsField]);

  // Handle ESC key to close popup
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectedHazard) setSelectedHazard(null);
      if (selectedStation) closePopup();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [selectedHazard, selectedStation]);

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
        const flightRuleColor = colorCodeByFlightRule ? getFlightRuleColor(station.flightRule) : "#ffffff";

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

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = flightRuleColor;
        ctx.fill();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1.5;
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
  }, [declutteredObs, tempUnit, viewState, displayMode, showStations, metpyWxGlyphMap, metpyWxFontReady, colorCodeByFlightRule]);

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

    if (!nwsOverlays.wpcSurface || frontRenderStyle !== "classic" || !wpcSurface) return;

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
            lineColor = "#dc2626";
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

        if (frontType === "STNRY") {
          drawAlternatingStationaryFrontLine(ctx, points, lineWidth, zoom);
        } else {
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
          ctx.strokeStyle = lineColor;
          ctx.lineWidth = lineWidth;
          ctx.setLineDash(dashed ? [7, 5] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        if (frontType === "TROF") continue;
        const symbolSpacing = frontType === "STNRY" ? spacing * 1.25 : spacing;
        const length = polylineLength(points);
        if (length < symbolSpacing) continue;
        let idx = 0;
        for (let d = symbolSpacing * 0.5; d < length - symbolSpacing * 0.35; d += symbolSpacing, idx++) {
          const sample = samplePolylineAtDistance(points, d);
          if (!sample) continue;
          const nx = sample.ty;
          const ny = -sample.tx;
          if (frontType === "COLD") {
            drawFrontTriangle(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#2563eb");
          } else if (frontType === "WARM") {
            drawFrontSemicircle(
              ctx,
              sample.x,
              sample.y,
              sample.tx,
              sample.ty,
              -nx,
              -ny,
              symbolSize * 1.5,
              "#dc2626"
            );
          } else if (frontType === "OCFNT") {
            if (idx % 2 === 0) {
              drawFrontSemicircle(ctx, sample.x, sample.y, sample.tx, sample.ty, -nx, -ny, symbolSize, "#7c3aed");
            } else {
              drawFrontTriangle(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#7c3aed");
            }
          } else if (frontType === "STNRY") {
            if (idx % 2 === 0) {
              drawFrontSemicircle(
                ctx,
                sample.x,
                sample.y,
                sample.tx,
                sample.ty,
                -nx,
                -ny,
                symbolSize * 1.25,
                "#dc2626"
              );
            } else {
              drawFrontTriangle(
                ctx,
                sample.x,
                sample.y,
                sample.tx,
                sample.ty,
                nx,
                ny,
                symbolSize * 0.95,
                "#2563eb"
              );
            }
          } else if (frontType === "DRYLINE") {
            drawDrylineScallop(ctx, sample.x, sample.y, sample.tx, sample.ty, nx, ny, symbolSize, "#b45309");
          }
        }
      }
    }
  }, [nwsOverlays.wpcSurface, frontRenderStyle, wpcSurface]);

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

  const rrfs850WindFillLegend = useMemo(
    () => RRFS_850_WIND_FILL_COLORS.map((color, idx) => {
      const start = RRFS_850_WIND_FILL_BINS_KT[idx];
      const end = RRFS_850_WIND_FILL_BINS_KT[idx + 1];
      return {
        color,
        label: !Number.isFinite(end) ? `${start}+ kt` : `${start}-${end} kt`,
      };
    }),
    []
  );
  const rrfs300WindFillLegend = useMemo(
    () => RRFS_300_WIND_FILL_COLORS.map((color, idx) => {
      const start = RRFS_300_WIND_FILL_BINS_KT[idx];
      const end = RRFS_300_WIND_FILL_BINS_KT[idx + 1];
      return {
        color,
        label: !Number.isFinite(end) ? `${start}+ kt` : `${start}-${end} kt`,
      };
    }),
    []
  );
  const rrfs700RhFillLegend = useMemo(
    () => RRFS_700_RH_FILL_COLORS.map((color, idx) => {
      const start = RRFS_700_RH_FILL_BINS_PCT[idx];
      const end = RRFS_700_RH_FILL_BINS_PCT[idx + 1];
      return {
        color,
        label: !Number.isFinite(end) ? `${start}+%` : `${start}-${end}%`,
      };
    }),
    []
  );

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

  type AnalysisOverlay =
    | "temp"
    | "dewpoint"
    | "slp"
    | "wind";
  type AnalysisOverlaySet = Record<AnalysisOverlay, boolean>;
  type DerivedOverlay =
    | "mixingRatio"
    | "moistureConvergence"
    | "thetaE";
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
        };
      } catch {}
    }
    return {
      temp: true,
      dewpoint: false,
      slp: false,
      wind: false,
    };
  });

  const [analysisFill, setAnalysisFill] = useState<AnalysisFill>(() => {
    const saved = localStorage.getItem("analysisFill");
    if (
      saved === "none"
      || saved === "windSpeed"
      || saved === "ceiling"
      || saved === "visibility"
      || saved === "relativeHumidity"
    ) {
      return saved;
    }
    const legacy = localStorage.getItem("analysisOverlays");
    if (legacy) {
      try {
        const obj = JSON.parse(legacy) as Partial<Record<"windSpeedFill" | "ceilingFill" | "visibilityFill" | "relativeHumidityFill", boolean>>;
        if (obj.windSpeedFill) return "windSpeed";
        if (obj.ceilingFill) return "ceiling";
        if (obj.visibilityFill) return "visibility";
        if (obj.relativeHumidityFill) return "relativeHumidity";
      } catch {}
    }
    return "none";
  });
  
  const anyOverlayOn =
  analysisOverlays.temp
  || analysisOverlays.dewpoint
  || analysisOverlays.slp
  || analysisOverlays.wind
  || analysisFill !== "none";

  const [derivedOverlays, setDerivedOverlays] = useState<DerivedOverlaySet>(() => {
    const saved = localStorage.getItem("derivedOverlays");
    if (saved) {
      try {
        const obj = JSON.parse(saved) as Partial<DerivedOverlaySet>;
        return {
          mixingRatio: !!obj.mixingRatio,
          moistureConvergence: !!obj.moistureConvergence,
          thetaE: !!obj.thetaE,
        };
      } catch {}
    }
    return {
      mixingRatio: false,
      moistureConvergence: false,
      thetaE: false,
    };
  });

  const anyAnalysisLikeOverlayOn =
    anyOverlayOn
    || derivedOverlays.mixingRatio
    || derivedOverlays.moistureConvergence
    || derivedOverlays.thetaE;

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
  const goesGradientLegend = useMemo(() => {
    if (!goesProduct || goesProduct === "none") return null;
    if (goesProduct.endsWith("-02")) {
      return {
        title: `${getGoesMenuTitle(goesProduct)} Visible (%)`,
        labels: ["100", "80", "60", "40", "20", "0"],
        gradientCss: GOES_VISIBLE_GRADIENT,
      };
    }
    if (goesRenderStyle === "grayscale") {
      return {
        title: `${getGoesMenuTitle(goesProduct)} ${goesProduct.endsWith("-09") ? "Band 9" : "Band 13"} Grayscale (°C)`,
        labels: ["-90", "-75", "-60", "-45", "-30", goesProduct.endsWith("-13") ? "15" : "-5"],
        gradientCss: GOES_IR_GRAYSCALE_GRADIENT,
      };
    }
    if (goesProduct.endsWith("-09")) {
      return {
        title: `${getGoesMenuTitle(goesProduct)} Band 9 Enhanced (°C)`,
        labels: ["0", "-10", "-20", "-30", "-40", "-50", "-60", "-70", "-80", "-90"],
        gradientCss: GOES_WV_GRADIENT,
      };
    }
    return {
      title: `${getGoesMenuTitle(goesProduct)} Band 13 Enhanced (°C)`,
      labels: ["-90", "-75", "-60", "-45", "-30", goesProduct.endsWith("-13") ? "15" : "-5"],
      gradientCss: GOES_IR_GRADIENT,
    };
  }, [goesProduct, goesRenderStyle]);
  const rrfsGradientLegend = useMemo(() => {
    if (rrfsChart !== "500mb") return null;
    return {
      title: "RRFS 500 mb Absolute Vorticity (x10^-5 s^-1)",
      labels: ["45", "35", "25", "15", "5"],
      gradientCss: RRFS_500_VORT_GRADIENT,
    };
  }, [rrfsChart]);
  const activeFillLegendCards = useMemo<LegendCard[]>(() => {
    const cards: LegendCard[] = [];
    if (analysisFill === "windSpeed") {
      cards.push({ title: `Wind Speed (${windUnit})`, items: windFillLegend });
    }
    if (analysisFill === "ceiling") {
      cards.push({ title: "Ceiling (hundreds ft)", items: ceilingFillLegend });
    }
    if (analysisFill === "visibility") {
      cards.push({ title: "Visibility (SM)", items: visibilityFillLegend });
    }
    if (analysisFill === "relativeHumidity") {
      cards.push({ title: "RH Critical (%)", items: relativeHumidityLegend });
    }
    if (mrmsField === "etop18") {
      cards.push({
        title: `MRMS ${getMrmsProductLabel(mrmsField)} (${getMrmsProductUnit(mrmsField)})`,
        items: ETOP18_LEGEND_ITEMS,
      });
    }
    if (mrmsField === "rotationll240" || mrmsField === "rotationml240") {
      cards.push({
        title: `MRMS ${getMrmsProductLabel(mrmsField)} (${getMrmsProductUnit(mrmsField)})`,
        items: ROT240_LEGEND_ITEMS,
      });
    }
    if (mrmsField === "posh") {
      cards.push({
        title: `MRMS ${getMrmsProductLabel(mrmsField)} (${getMrmsProductUnit(mrmsField)})`,
        items: POSH_LEGEND_ITEMS,
      });
    }
    if (mrmsField === "mesh240") {
      cards.push({
        title: `MRMS ${getMrmsProductLabel(mrmsField)} (${getMrmsProductUnit(mrmsField)})`,
        items: MESH240_LEGEND_ITEMS,
      });
    }
    if (nwsOverlays.wpcSurface) {
      cards.push({ title: "WPC Surface Analysis", items: WPC_LEGEND_ITEMS });
    }
    if (glmProduct !== "none") {
      cards.push({
        title: `${getGlmProductLabel(glmProduct)} (flashes / 5 min)`,
        items: GLM_LEGEND_ITEMS,
      });
    }
    if (rrfsChart === "850mb") {
      cards.push({
        title: "RRFS 850 mb Wind Speed (kt)",
        items: rrfs850WindFillLegend,
      });
    }
    if (rrfsChart === "300mb") {
      cards.push({
        title: "RRFS 300 mb Wind Speed (kt)",
        items: rrfs300WindFillLegend,
      });
    }
    if (rrfsChart === "700mb") {
      cards.push({
        title: "RRFS 700 mb Relative Humidity (%)",
        items: rrfs700RhFillLegend,
      });
    }
    return cards;
  }, [
    analysisFill,
    windUnit,
    windFillLegend,
    ceilingFillLegend,
    visibilityFillLegend,
    relativeHumidityLegend,
    mrmsField,
    glmProduct,
    nwsOverlays.wpcSurface,
    rrfsChart,
    rrfs850WindFillLegend,
    rrfs300WindFillLegend,
    rrfs700RhFillLegend,
  ]);

  type ContourLegendItem = {
    key: string;
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
    if (rrfsChart !== "none") {
      const levelLabel = getRrfsLevelLabel(rrfsChart);
      const heightInterval = getRrfsHeightInterval(rrfsChart);
      items.push({
        key: `rrfs-${rrfsChart}-height`,
        label: `RRFS ${levelLabel} mb Height (${heightInterval} m)`,
        color: "#111827",
        width: 2.2,
      });
      if (rrfsChart !== "300mb") {
        items.push({
          key: `rrfs-${rrfsChart}-temp`,
          label: `RRFS ${levelLabel} mb Temperature (2 C)`,
          color: "#dc2626",
          width: 2,
          dash: [6, 5],
        });
      }
      if (rrfsChart !== "700mb" && rrfsChart !== "500mb" && rrfsChart !== "300mb") {
        items.push({
          key: `rrfs-${rrfsChart}-dewpoint`,
          label: `RRFS ${levelLabel} mb Dewpoint (2 C, >=10 C)`,
          color: "#166534",
          width: 2,
          dash: [5, 6],
        });
      }
      if (rrfsChart === "300mb") {
        items.push({
          key: "rrfs-300mb-divergence",
          label: "RRFS 300 mb Divergence (x10^-5 s^-1)",
          color: "#1d4ed8",
          width: 2.2,
        });
      }
      items.push({
        key: `rrfs-${rrfsChart}-wind`,
        label: `RRFS ${levelLabel} mb Wind Barbs`,
        color: "#111827",
        width: 2,
      });
    }
    const seenHazards = new Set<string>();
    for (const feature of hazardSummary?.matched?.features ?? []) {
      const kind = String(feature?.properties?.kind ?? "");
      const style = HAZARD_STYLE_BY_KIND[kind];
      if (!style || seenHazards.has(kind) || !nwsOverlays[style.menuGroup]) continue;
      seenHazards.add(kind);
      items.push({
        key: `hazard-${kind}`,
        label: style.label,
        color: style.color,
        width: style.width,
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
    rrfsChart,
    hazardSummary,
    nwsOverlays,
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
    if (analysisFill === "windSpeed") {
      const v = sampleScalarGrid(g.windSpeed, x, y);
      rows.push({
        label: `Wind Speed Fill (${windUnit})`,
        value: v == null ? "—" : knotsToWindUnit(v, windUnit).toFixed(1),
      });
    }
    if (analysisFill === "ceiling") {
      const v = sampleScalarGrid(g.ceiling, x, y);
      const val = v == null ? "—" : String(Math.round(v)).padStart(3, "0");
      const suffix = v != null && v > 50 ? " (hidden on map)" : "";
      rows.push({ label: "Ceiling (hundreds ft)", value: `${val}${suffix}` });
    }
    if (analysisFill === "visibility") {
      const v = sampleScalarGrid(g.visibility, x, y);
      const suffix = v != null && v > 6 ? " (hidden on map)" : "";
      rows.push({ label: "Visibility (SM)", value: v == null ? "—" : `${v.toFixed(2)}${suffix}` });
    }
    if (analysisFill === "relativeHumidity") {
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
    if (derivedOverlays.moistureConvergence) {
      const v = sampleScalarGrid(g.moistureConvergence, x, y);
      const hidden = v != null && v < 1;
      rows.push({
        label: "Moisture Conv. (x10⁷ s⁻¹)",
        value: v == null ? "—" : `${v.toFixed(2)}${hidden ? " (hidden on map)" : ""}`,
      });
    }
    if (mrmsField !== "none") {
      const precision = (mrmsField === "rotationll240" || mrmsField === "rotationml240") ? 3 : 1;
      rows.push({
        label: `MRMS ${getMrmsProductLabel(mrmsField)} (${getMrmsProductUnit(mrmsField)})`,
        value: mrmsCursorValue == null ? "—" : mrmsCursorValue.toFixed(precision),
      });
    }
    if (goesProduct !== "none") {
      rows.push({
        label: `${getGoesProductLabel(goesProduct)} (${getGoesProductUnit(goesProduct)})`,
        value: formatGoesCursorValue(goesProduct, goesCursorValue),
      });
    }
    if (glmProduct !== "none") {
      rows.push({
        label: `${getGlmProductLabel(glmProduct)} (flashes / 5 min)`,
        value: formatGlmCursorValue(glmCursorValue),
      });
    }
    if (rrfsChart !== "none") {
      const levelLabel = getRrfsLevelLabel(rrfsChart);
      rows.push({
        label: `RRFS ${levelLabel} mb Height (m)`,
        value: rrfsCursorValue?.height_m == null ? "—" : rrfsCursorValue.height_m.toFixed(0),
      });
      if (rrfsChart !== "300mb") {
        rows.push({
          label: `RRFS ${levelLabel} mb Temperature (°C)`,
          value: rrfsCursorValue?.temperature_c == null ? "—" : rrfsCursorValue.temperature_c.toFixed(1),
        });
      }
      if (rrfsChart !== "700mb" && rrfsChart !== "500mb" && rrfsChart !== "300mb") {
        rows.push({
          label: `RRFS ${levelLabel} mb Dewpoint (°C)`,
          value: rrfsCursorValue?.dewpoint_c == null ? "—" : rrfsCursorValue.dewpoint_c.toFixed(1),
        });
      }
      rows.push({
        label: `RRFS ${levelLabel} mb Wind (kt)`,
        value: rrfsCursorValue?.wind_speed_kt == null
          ? "—"
          : `${rrfsCursorValue.wind_speed_kt.toFixed(0)} kt @ ${rrfsCursorValue.wind_dir_deg == null ? "—" : `${Math.round(rrfsCursorValue.wind_dir_deg)}°`}`,
      });
      if (rrfsChart === "300mb") {
        rows.push({
          label: "RRFS 300 mb Wind Speed (kt)",
          value: rrfsCursorValue?.wind_speed_kt == null ? "—" : rrfsCursorValue.wind_speed_kt.toFixed(1),
        });
        rows.push({
          label: "RRFS 300 mb Divergence (x10^-5 s^-1)",
          value: rrfsCursorValue?.divergence_s1 == null ? "—" : (rrfsCursorValue.divergence_s1 * 1e5).toFixed(1),
        });
      }
      if (rrfsChart === "850mb") {
        rows.push({
          label: "RRFS 850 mb Wind Speed (kt)",
          value: rrfsCursorValue?.wind_speed_kt == null ? "—" : rrfsCursorValue.wind_speed_kt.toFixed(1),
        });
      }
      if (rrfsChart === "700mb") {
        rows.push({
          label: "RRFS 700 mb Relative Humidity (%)",
          value: rrfsCursorValue?.relative_humidity_pct == null ? "—" : rrfsCursorValue.relative_humidity_pct.toFixed(1),
        });
      }
      if (rrfsChart === "500mb") {
        rows.push({
          label: "RRFS 500 mb Absolute Vorticity (x10^-5 s^-1)",
          value: rrfsCursorValue?.absolute_vorticity_s1 == null ? "—" : (rrfsCursorValue.absolute_vorticity_s1 * 1e5).toFixed(1),
        });
      }
    }

    return rows;
  }, [
    cursorProbe,
    showCursorDiagnostics,
    analysisOverlays,
    analysisFill,
    derivedOverlays,
    tempUnit,
    windUnit,
    mrmsField,
    mrmsCursorValue,
    goesProduct,
    goesCursorValue,
    glmProduct,
    glmCursorValue,
    rrfsChart,
    rrfsCursorValue,
  ]);

  const selectedTimeDisplayIso = useMemo(
    () => requestedTimeIso ?? obsMatchMeta?.matched_time ?? lastUpdate,
    [requestedTimeIso, obsMatchMeta, lastUpdate]
  );
  const rrfsRequestedTimeIso = useMemo(
    () => obsMatchMeta?.matched_time ?? lastUpdate,
    [obsMatchMeta, lastUpdate]
  );
  const anyRrfsContourOn = rrfsChart !== "none";

  const validTimeLabel = useMemo(
    () => formatValidTimeLabel(selectedTimeDisplayIso, displayTimeZone),
    [selectedTimeDisplayIso, displayTimeZone]
  );

  const refreshMrmsMeta = useCallback(async () => {
    if (mrmsField === "none") {
      setMrmsMeta(null);
      setMrmsError(null);
      setMrmsLoadState("idle");
      return;
    }
    setMrmsLoadState("loading");
    try {
      const params = new URLSearchParams({ product: mrmsField });
      if (requestedTimeIso) params.set("time", requestedTimeIso);
      const res = await fetch(apiUrl(`/api/mrms/meta?${params.toString()}`));
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as MrmsMetaResponse;
      setMrmsMeta(data);
      setMrmsError(null);
      setMrmsLoadState("ready");
    } catch (e: any) {
      setMrmsMeta(null);
      setMrmsError(e?.message ?? "Failed to load MRMS metadata");
      setMrmsLoadState("error");
    }
  }, [mrmsField, requestedTimeIso]);

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
        const res = await fetch(apiUrl(`/api/mrms/value?${params.toString()}`), { signal: controller.signal });
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

  const refreshGoesMeta = useCallback(async () => {
    if (goesProduct === "none") {
      setGoesMeta(null);
      setGoesError(null);
      setGoesLoadState("idle");
      return;
    }
    setGoesLoadState("loading");
    try {
      const params = new URLSearchParams({ product: goesProduct });
      if (!goesProduct.endsWith("-02")) params.set("style", goesRenderStyle);
      if (requestedTimeIso) params.set("time", requestedTimeIso);
      const res = await fetch(apiUrl(`/api/goes/meta?${params.toString()}`));
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as GoesMetaResponse;
      setGoesMeta(data);
      setGoesError(null);
      setGoesLoadState("ready");
    } catch (e: any) {
      setGoesMeta(null);
      setGoesError(e?.message ?? "Failed to load GOES metadata");
      setGoesLoadState("error");
    }
  }, [goesProduct, goesRenderStyle, requestedTimeIso]);

  useEffect(() => {
    refreshGoesMeta();
  }, [refreshGoesMeta]);

  useEffect(() => {
    if (!showCursorDiagnostics || goesProduct === "none" || !goesMeta || !cursorProbe) {
      setGoesCursorValue(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          product: goesProduct,
          time: goesMeta.matched_time,
          lat: cursorProbe.lat.toFixed(5),
          lon: cursorProbe.lng.toFixed(5),
        });
        const res = await fetch(apiUrl(`/api/goes/value?${params.toString()}`), { signal: controller.signal });
        if (!res.ok) {
          setGoesCursorValue(null);
          return;
        }
        const data = (await res.json()) as GoesValueResponse;
        const sampled = data.value;
        setGoesCursorValue(sampled == null || !Number.isFinite(sampled) ? null : sampled);
      } catch (e: any) {
        if (e?.name !== "AbortError") setGoesCursorValue(null);
      }
    }, 120);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    showCursorDiagnostics,
    goesProduct,
    goesMeta,
    cursorProbe?.lat,
    cursorProbe?.lng,
  ]);

  const refreshGlmMeta = useCallback(async () => {
    if (glmProduct === "none") {
      setGlmMeta(null);
      setGlmError(null);
      setGlmLoadState("idle");
      return;
    }
    setGlmLoadState("loading");
    try {
      const params = new URLSearchParams({ product: glmProduct });
      if (requestedTimeIso) params.set("time", requestedTimeIso);
      const res = await fetch(apiUrl(`/api/glm/meta?${params.toString()}`));
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as GlmMetaResponse;
      setGlmMeta(data);
      setGlmError(null);
      setGlmLoadState("ready");
    } catch (e: any) {
      setGlmMeta(null);
      setGlmError(e?.message ?? "Failed to load GLM metadata");
      setGlmLoadState("error");
    }
  }, [glmProduct, requestedTimeIso]);

  useEffect(() => {
    refreshGlmMeta();
  }, [refreshGlmMeta]);

  useEffect(() => {
    if (!showCursorDiagnostics || glmProduct === "none" || !glmMeta || !cursorProbe) {
      setGlmCursorValue(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          product: glmProduct,
          time: glmMeta.matched_time,
          lat: cursorProbe.lat.toFixed(5),
          lon: cursorProbe.lng.toFixed(5),
        });
        const res = await fetch(apiUrl(`/api/glm/value?${params.toString()}`), { signal: controller.signal });
        if (!res.ok) {
          setGlmCursorValue(null);
          return;
        }
        const data = (await res.json()) as GlmValueResponse;
        const sampled = data.value;
        setGlmCursorValue(sampled == null || !Number.isFinite(sampled) ? null : sampled);
      } catch (e: any) {
        if (e?.name !== "AbortError") setGlmCursorValue(null);
      }
    }, 120);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    showCursorDiagnostics,
    glmProduct,
    glmMeta,
    cursorProbe?.lat,
    cursorProbe?.lng,
  ]);

  const refreshRrfsContours = useCallback(async () => {
    if (rrfsChart === "none") {
      setRrfsMeta(null);
      setRrfsContoursGeoJson(null);
      setRrfsWindsGeoJson(null);
      setRrfsFillGeoJson(null);
      setRrfsError(null);
      setRrfsLoadState("idle");
      return;
    }
    if (!rrfsRequestedTimeIso) {
      setRrfsMeta(null);
      setRrfsContoursGeoJson(null);
      setRrfsWindsGeoJson(null);
      setRrfsFillGeoJson(null);
      setRrfsError(null);
      setRrfsLoadState("loading");
      return;
    }
    setRrfsLoadState("loading");
    try {
      const params = new URLSearchParams({
        chart: rrfsChart,
        time: rrfsRequestedTimeIso,
      });
      const res = await fetch(apiUrl(`/api/rrfs/chart?${params.toString()}`));
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as RrfsChartResponse;
      setRrfsMeta(data);
      setRrfsContoursGeoJson(data.contours ?? { type: "FeatureCollection", features: [] });
      setRrfsWindsGeoJson(data.winds ?? { type: "FeatureCollection", features: [] });
      setRrfsFillGeoJson(data.wind_fill ?? data.rh_fill ?? data.vort_fill ?? null);
      setRrfsError(null);
      setRrfsLoadState("ready");
    } catch (e: any) {
      setRrfsMeta(null);
      setRrfsContoursGeoJson(null);
      setRrfsWindsGeoJson(null);
      setRrfsFillGeoJson(null);
      setRrfsError(e?.message ?? "Failed to load RRFS contours");
      setRrfsLoadState("error");
    }
  }, [rrfsChart, rrfsRequestedTimeIso]);

  useEffect(() => {
    refreshRrfsContours();
  }, [refreshRrfsContours]);

  useEffect(() => {
    if (!showCursorDiagnostics || rrfsChart === "none" || !rrfsRequestedTimeIso || !cursorProbe) {
      setRrfsCursorValue(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          chart: rrfsChart,
          time: rrfsRequestedTimeIso,
          lat: cursorProbe.lat.toFixed(5),
          lon: cursorProbe.lng.toFixed(5),
        });
        const res = await fetch(apiUrl(`/api/rrfs/chart_value?${params.toString()}`), { signal: controller.signal });
        if (!res.ok) {
          setRrfsCursorValue(null);
          return;
        }
        const data = (await res.json()) as RrfsChartValueResponse;
        setRrfsCursorValue(data);
      } catch (e: any) {
        if (e?.name !== "AbortError") setRrfsCursorValue(null);
      }
    }, 120);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    showCursorDiagnostics,
    rrfsChart,
    rrfsRequestedTimeIso,
    cursorProbe?.lat,
    cursorProbe?.lng,
  ]);

  const refreshWpcSurface = useCallback(async () => {
    if (!nwsOverlays.wpcSurface) {
      setWpcSurface(null);
      setWpcError(null);
      setWpcLoadState("idle");
      return;
    }
    setWpcLoadState("loading");
    try {
      const params = new URLSearchParams();
      if (requestedTimeIso) params.set("time", requestedTimeIso);
      const url = params.size > 0 ? apiUrl(`/api/nws/wpc_surface?${params.toString()}`) : apiUrl("/api/nws/wpc_surface");
      const res = await fetch(url);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as WpcSurfaceResponse;
      setWpcSurface(data);
      setWpcError(null);
      setWpcLoadState("ready");
    } catch (e: any) {
      setWpcSurface(null);
      setWpcError(e?.message ?? "Failed to load WPC surface analysis");
      setWpcLoadState("error");
    }
  }, [nwsOverlays.wpcSurface, requestedTimeIso]);

  useEffect(() => {
    refreshWpcSurface();
    if (!nwsOverlays.wpcSurface) return;
    const id = window.setInterval(refreshWpcSurface, 10 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [nwsOverlays.wpcSurface, refreshWpcSurface]);

  const refreshHazardSummary = useCallback(async () => {
    if (!hazardBootstrapReady) return;
    setHazardLoadState("loading");
    try {
      const params = new URLSearchParams();
      if (requestedTimeIso) params.set("time", requestedTimeIso);
      const url = params.size > 0 ? apiUrl(`/api/hazards/summary?${params.toString()}`) : apiUrl("/api/hazards/summary");
      const res = await fetch(url);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.detail ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as HazardSummaryResponse;
      setHazardSummary(data);
      setHazardError(null);
      setHazardLoadState("ready");
    } catch (e: any) {
      setHazardSummary(null);
      setHazardError(e?.message ?? "Failed to load hazards summary");
      setHazardLoadState("error");
    }
  }, [hazardBootstrapReady, requestedTimeIso]);

  useEffect(() => {
    if (!hazardBootstrapReady) return;
    refreshHazardSummary();
    const id = window.setInterval(refreshHazardSummary, 2 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [hazardBootstrapReady, refreshHazardSummary]);

  const dataLayerStatuses = useMemo(() => {
    const statuses: DataLayerStatus[] = [];

    if (obsMatchMeta && lastUpdate) {
      statuses.push({
        key: "obs",
        label: "Surface Observations",
        state: "matched",
        detail: describeMatchDetail(
          {
            requested_time: obsMatchMeta.requested_time,
            matched_time: lastUpdate,
            match_status: obsMatchMeta.match_status,
            match_delta_minutes: obsMatchMeta.match_delta_minutes,
            match_tolerance_minutes: obsMatchMeta.match_tolerance_minutes,
          },
          displayTimeZone,
          "Showing latest observations"
        ),
      });
    }

    if (mrmsField !== "none") {
      const label = `MRMS ${getMrmsProductLabel(mrmsField)}`;
      if (mrmsMeta) {
        statuses.push({
          key: `mrms-${mrmsField}`,
          label,
          state: "matched",
          detail: describeMatchDetail(mrmsMeta, displayTimeZone),
        });
      } else if (mrmsError) {
        statuses.push({
          key: `mrms-${mrmsField}`,
          label,
          state: "dropped",
          detail: mrmsError,
        });
      }
    }

    if (goesProduct !== "none") {
      const label = getGoesProductLabel(goesProduct);
      if (goesMeta) {
        statuses.push({
          key: `goes-${goesProduct}`,
          label,
          state: "matched",
          detail: describeMatchDetail(goesMeta, displayTimeZone),
        });
      } else if (goesError) {
        statuses.push({
          key: `goes-${goesProduct}`,
          label,
          state: "dropped",
          detail: goesError,
        });
      }
    }

    if (glmProduct !== "none") {
      const label = getGlmProductLabel(glmProduct);
      if (glmMeta) {
        statuses.push({
          key: `glm-${glmProduct}`,
          label,
          state: "matched",
          detail: describeMatchDetail(glmMeta, displayTimeZone),
        });
      } else if (glmError) {
        statuses.push({
          key: `glm-${glmProduct}`,
          label,
          state: "dropped",
          detail: glmError,
        });
      }
    }

    if (rrfsChart !== "none") {
      const label = getRrfsChartLabel(rrfsChart);
      if (rrfsMeta) {
        const initLabel = rrfsMeta.init_time ? formatTimestampWithSeconds(rrfsMeta.init_time, displayTimeZone) : "—";
        const detail = `${describeMatchDetail(rrfsMeta, displayTimeZone)} Run ${initLabel} F${String(rrfsMeta.forecast_hour).padStart(2, "0")}.`;
        statuses.push({
          key: `rrfs-${rrfsChart}`,
          label,
          state: "matched",
          detail,
        });
      } else if (rrfsError) {
        statuses.push({
          key: `rrfs-${rrfsChart}`,
          label,
          state: "dropped",
          detail: rrfsError,
        });
      }
    }

    if (nwsOverlays.wpcSurface) {
      if (wpcSurface?.matched_time) {
        statuses.push({
          key: "wpc",
          label: "WPC Surface Analysis",
          state: "matched",
          detail: describeMatchDetail(
            {
              requested_time: wpcSurface.requested_time ?? null,
              matched_time: wpcSurface.matched_time,
              match_status: wpcSurface.match_status,
              match_delta_minutes: wpcSurface.match_delta_minutes,
              match_tolerance_minutes: wpcSurface.match_tolerance_minutes,
            },
            displayTimeZone
          ),
        });
      } else if (wpcError) {
        statuses.push({
          key: "wpc",
          label: "WPC Surface Analysis",
          state: "dropped",
          detail: wpcError,
        });
      }
    }

    if (hazardError) {
      statuses.push({
        key: "hazards",
        label: "Hazards",
        state: "dropped",
        detail: hazardError,
      });
    }

    return statuses;
  }, [displayTimeZone, glmError, glmMeta, glmProduct, goesError, goesMeta, goesProduct, hazardError, lastUpdate, mrmsError, mrmsField, mrmsMeta, nwsOverlays.wpcSurface, obsMatchMeta, rrfsChart, rrfsError, rrfsMeta, wpcError, wpcSurface]);

  const loadingStages = useMemo(() => {
    const stages: Array<{ key: string; label: string; state: LoadStageState }> = [
      { key: "obs", label: "Observation Data", state: obsLoadState },
      { key: "hazards", label: "Hazards", state: hazardLoadState },
      { key: "map", label: "Map", state: mapLoaded ? "ready" : "loading" },
    ];
    if (anyAnalysisLikeOverlayOn) {
      stages.push({ key: "analysis", label: "Objective Analysis", state: analysisLoadState });
    }
    if (mrmsField !== "none") {
      stages.push({ key: "mrms", label: `MRMS ${getMrmsProductLabel(mrmsField)}`, state: mrmsLoadState });
    }
    if (goesProduct !== "none") {
      stages.push({ key: "goes", label: getGoesProductLabel(goesProduct), state: goesLoadState });
    }
    if (glmProduct !== "none") {
      stages.push({ key: "glm", label: getGlmProductLabel(glmProduct), state: glmLoadState });
    }
    if (anyRrfsContourOn) {
      stages.push({ key: "rrfs", label: "RRFS", state: rrfsLoadState });
    }
    if (nwsOverlays.wpcSurface) {
      stages.push({ key: "wpc", label: "WPC Surface", state: wpcLoadState });
    }
    return stages;
  }, [obsLoadState, hazardLoadState, mapLoaded, anyAnalysisLikeOverlayOn, analysisLoadState, mrmsField, mrmsLoadState, goesProduct, goesLoadState, glmProduct, glmLoadState, anyRrfsContourOn, rrfsLoadState, nwsOverlays.wpcSurface, wpcLoadState]);

  const loadingProgress = useMemo(() => {
    const total = loadingStages.length;
    const completed = loadingStages.filter((stage) => stage.state === "ready" || stage.state === "error").length;
    const active = loadingStages.filter((stage) => stage.state === "loading").map((stage) => stage.label);
    const errors = loadingStages.filter((stage) => stage.state === "error").map((stage) => stage.label);
    const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
    const statusText =
      active.length > 0
        ? `Loading ${active.join(", ")}`
        : errors.length > 0
          ? `Completed with issues: ${errors.join(", ")}`
          : "All enabled layers ready";
    return {
      percent,
      active,
      errors,
      isBusy: active.length > 0,
      statusText,
    };
  }, [loadingStages]);

  const visibleHazardFeatures = useMemo(() => {
    const features = hazardSummary?.matched?.features ?? [];
    return features.filter((feature) => {
      const kind = String(feature?.properties?.kind ?? "");
      const style = HAZARD_STYLE_BY_KIND[kind];
      return style ? nwsOverlays[style.menuGroup] : false;
    });
  }, [hazardSummary, nwsOverlays]);

  const visibleHazardsGeoJson = useMemo<GeoJsonFeatureCollection>(
    () => ({ type: "FeatureCollection", features: visibleHazardFeatures }),
    [visibleHazardFeatures]
  );

  const refreshOpsSummary = useCallback(async () => {
    setOpsLoading(true);
    try {
      const res = await fetch(apiUrl("/api/ops/summary"));
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
    const base = apiUrl(
      mrmsMeta.tile_url_template ??
        `/api/mrms/tile/{z}/{x}/{y}.png?product=${encodeURIComponent(mrmsField)}&time=${encodeURIComponent(
          mrmsMeta.matched_time
        )}`
    );
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}cb=${encodeURIComponent(mrmsMeta.matched_time)}`;
  }, [mrmsField, mrmsMeta]);

  const goesTileTemplate = useMemo(() => {
    if (goesProduct === "none" || !goesMeta) return null;
    const base = apiUrl(
      goesMeta.tile_url_template ??
        `/api/goes/tile/{z}/{x}/{y}.png?product=${encodeURIComponent(goesProduct)}&time=${encodeURIComponent(
          goesMeta.matched_time
        )}${goesProduct.endsWith("-02") ? "" : `&style=${encodeURIComponent(goesRenderStyle)}`}`
    );
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}cb=${encodeURIComponent(goesMeta.matched_time)}`;
  }, [goesProduct, goesMeta, goesRenderStyle]);

  const glmTileTemplate = useMemo(() => {
    if (glmProduct === "none" || !glmMeta) return null;
    const base = apiUrl(
      glmMeta.tile_url_template ??
        `/api/glm/tile/{z}/{x}/{y}.png?product=${encodeURIComponent(glmProduct)}&time=${encodeURIComponent(
          glmMeta.matched_time
        )}`
    );
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}cb=${encodeURIComponent(glmMeta.matched_time)}`;
  }, [glmProduct, glmMeta]);

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

  const goesRasterLayer: any = useMemo(
    () => ({
      id: "goes-raster-layer",
      type: "raster",
      source: "goes-raster-tiles",
      maxzoom: 9,
      paint: {
        "raster-opacity": 0.82,
        "raster-resampling": "nearest",
      },
    }),
    []
  );

  const glmRasterLayer: any = useMemo(
    () => ({
      id: "glm-raster-layer",
      source: "glm-raster-tiles",
      type: "raster",
      maxzoom: 9,
      paint: {
        "raster-opacity": 0.82,
        "raster-resampling": "nearest",
      },
    }),
    []
  );

  const hazardLineLayers: any[] = useMemo(
    () =>
      Object.entries(HAZARD_STYLE_BY_KIND).map(([kind, style]) => ({
        id: `hazard-${kind}`,
        type: "line",
        source: "hazards-source",
        filter: ["==", ["get", "kind"], kind],
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": style.color,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            3, Math.max(1.5, style.width * 0.7),
            6, style.width,
            9, style.width + 0.6,
          ],
          "line-opacity": 0.9,
        },
      })),
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
        "line-color": "rgba(15, 23, 42, 0.9)",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 0.6,
          5, 0.95,
          8, 1.35,
        ],
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 0.55,
          4, 0.72,
          8, 0.9,
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
        "line-color": "rgba(30, 41, 59, 0.72)",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4, 0.32,
          7, 0.48,
          10, 0.78,
        ],
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4, 0.2,
          6, 0.34,
          8, 0.52,
          10, 0.68,
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
  freezingLevel: number,
  forceAllRed = false
) {
  if (forceAllRed) {
    ctx.save();
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 5]);
    for (const seg of segments) {
      ctx.beginPath();
      ctx.moveTo(seg[0].x, seg[0].y);
      for (let k = 1; k < seg.length; k++) ctx.lineTo(seg[k].x, seg[k].y);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

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

function strokeDivergenceContours(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][]
) {
  ctx.save();
  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = 2.2;
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

type LabelMode = "temp" | "dewpoint" | "slp" | "mixingRatio" | "thetaE" | "divergence";

function pointsClose(a: Pt, b: Pt, tol = 2.5): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

function stitchProjectedContourSegments(segments: Pt[][], tol = 2.5): Pt[][] {
  if (segments.length <= 1) return segments.filter((seg) => seg.length >= 2);

  const used = new Array(segments.length).fill(false);
  const stitched: Pt[][] = [];

  for (let i = 0; i < segments.length; i++) {
    const seed = segments[i];
    if (used[i] || seed.length < 2) continue;
    used[i] = true;
    const line = seed.slice();

    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < segments.length; j++) {
        const cand = segments[j];
        if (used[j] || cand.length < 2) continue;

        const lineStart = line[0];
        const lineEnd = line[line.length - 1];
        const candStart = cand[0];
        const candEnd = cand[cand.length - 1];

        if (pointsClose(lineEnd, candStart, tol)) {
          line.push(...cand.slice(1));
        } else if (pointsClose(lineEnd, candEnd, tol)) {
          line.push(...cand.slice(0, -1).reverse());
        } else if (pointsClose(lineStart, candEnd, tol)) {
          line.unshift(...cand.slice(0, -1));
        } else if (pointsClose(lineStart, candStart, tol)) {
          line.unshift(...cand.slice(1).reverse());
        } else {
          continue;
        }

        used[j] = true;
        extended = true;
      }
    }

    stitched.push(line);
  }

  return stitched;
}

function labelContours(
  ctx: CanvasRenderingContext2D,
  segments: Pt[][],
  level: number,
  mode: LabelMode,
  opts: {
    tempUnit: "F" | "C";
    freezingLevel?: number;
    labelColorOverride?: string;
    labelText?: string;
    fontPx?: number;
    maxLabels?: number;
    minLen?: number;
    repeatLongSegments?: boolean;
    labelSpacingPx?: number;
  }
) {
  const tempUnit = opts.tempUnit;
  const freezingLevel = opts.freezingLevel ?? (tempUnit === "F" ? 32 : 0);
  const labelColorOverride = opts.labelColorOverride;
  const labelText = opts.labelText;
  const fontPx = opts.fontPx ?? 14;
  const maxLabels = opts.maxLabels ?? 5;
  const minLen = opts.minLen ?? 30;
  const repeatLongSegments = opts.repeatLongSegments ?? false;
  const labelSpacingPx = opts.labelSpacingPx ?? Math.max(minLen * 1.35, 120);

  // Color/text by mode
  let labelColor = "#111827";
  let text = "";

  if (mode === "temp") {
    const belowFreezing = level < freezingLevel;
    const isFreezing = Math.abs(level - freezingLevel) < 1e-6;
    labelColor = isFreezing ? "#111827" : belowFreezing ? "#2563eb" : "#dc2626";
    text = labelText ?? `${Math.round(level)}°${tempUnit}`;
  } else if (mode === "dewpoint") {
    labelColor = "#14532d";
    text = labelText ?? `${Math.round(level)}°${tempUnit}`;
  } else if (mode === "mixingRatio") {
    labelColor = "#14532d";
    text = labelText ?? `${Math.round(level)} g/kg`;
  } else if (mode === "thetaE") {
    labelColor = "#15803d";
    text = labelText ?? `${Math.round(level)}K`;
  } else if (mode === "divergence") {
    labelColor = "#1d4ed8";
    text = labelText ?? `${Math.round(level * 1e5)}`;
  } else {
    // slp
    labelColor = "#111827";
    text = labelText ?? `${Math.round(level)}`; // mb
  }

  if (labelColorOverride) labelColor = labelColorOverride;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.setLineDash([]);
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const canvasW = ctx.canvas.width / (window.devicePixelRatio || 1);
  const canvasH = ctx.canvas.height / (window.devicePixelRatio || 1);
  const viewportMargin = 24;

  function pointAlongPolyline(seg: Pt[], targetDist: number): Pt {
    let walked = 0;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1];
      const b = seg[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (walked + segLen >= targetDist && segLen > 0) {
        const t = (targetDist - walked) / segLen;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      walked += segLen;
    }
    return seg[seg.length - 1];
  }

  function angleAtDistance(seg: Pt[], targetDist: number): number {
    let walked = 0;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1];
      const b = seg[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (walked + segLen >= targetDist && segLen > 0) {
        return Math.atan2(b.y - a.y, b.x - a.x);
      }
      walked += segLen;
    }
    const a = seg[Math.max(0, seg.length - 2)];
    const b = seg[seg.length - 1];
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  // Build candidates from contour geometry
  const candidates: Array<{ a: Pt; b: Pt; len: number }> = [];
  for (const seg of segments) {
    if (!seg || seg.length < 2) continue;
    let len = 0;
    for (let i = 1; i < seg.length; i++) len += Math.hypot(seg[i].x - seg[i - 1].x, seg[i].y - seg[i - 1].y);
    if (len < minLen) continue;

    if (!repeatLongSegments) {
      const a = seg[0];
      const b = seg[seg.length - 1];
      candidates.push({ a, b, len });
      continue;
    }

    const count = Math.max(1, Math.min(6, Math.floor(len / labelSpacingPx)));
    for (let idx = 0; idx < count; idx++) {
      const frac = (idx + 1) / (count + 1);
      const dist = len * frac;
      const center = pointAlongPolyline(seg, dist);
      const ang = angleAtDistance(seg, dist);
      const half = Math.min(24, Math.max(10, len / 12));
      const dx = Math.cos(ang) * half;
      const dy = Math.sin(ang) * half;
      candidates.push({
        a: { x: center.x - dx, y: center.y - dy },
        b: { x: center.x + dx, y: center.y + dy },
        len,
      });
    }
  }
  const visibleCandidates = candidates.filter(({ a, b }) => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return mx >= -viewportMargin && mx <= canvasW + viewportMargin && my >= -viewportMargin && my <= canvasH + viewportMargin;
  });

  if (visibleCandidates.length === 0) {
    ctx.restore();
    return;
  }

  visibleCandidates.sort((a, b) => b.len - a.len);

  for (let i = 0; i < visibleCandidates.length && i < maxLabels; i++) {
    const { a, b } = visibleCandidates[i];

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
    return false;
  }

  const canvas = analysisCanvasRef.current;
  const mapObj = mapRef.current?.getMap();
  if (!canvas || !mapObj) return false;

  const map = mapObj;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (width < 2 || height < 2) {
    analysisGridRef.current = {};
    return false;
  }

  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx0 = canvas.getContext("2d");
  if (!ctx0) return false;
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
    return false;
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

    if (analysisFill === "windSpeed") drawWindSpeedFill();
    if (analysisFill === "ceiling") drawCeilingFill();
    if (analysisFill === "visibility") drawVisibilityFill();
    if (analysisFill === "relativeHumidity") drawRelativeHumidityFill();
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
    return true;
  }, [analysisOverlays, analysisFill, derivedOverlays, declutteredObs, tempUnit, anyAnalysisLikeOverlayOn, windRenderMode, windUnit]);

const drawRrfsFillOverlay = useCallback(() => {
  const canvas = rrfsFillCanvasRef.current;
  const mapObj = mapRef.current?.getMap();
  if (!canvas || !mapObj) return false;

  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const dpr = window.devicePixelRatio || 1;
  if (width < 2 || height < 2) return false;

  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx0 = canvas.getContext("2d");
  if (!ctx0) return false;
  const ctx = ctx0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if ((rrfsChart !== "850mb" && rrfsChart !== "700mb" && rrfsChart !== "500mb" && rrfsChart !== "300mb") || !rrfsFillGeoJson?.features?.length) return true;

  let maxI = -1;
  let maxJ = -1;
  const nodes = new Map<string, { x: number; y: number; val: number }>();
  for (const feature of rrfsFillGeoJson.features) {
    const coords = feature?.geometry?.coordinates;
    const props = feature?.properties ?? {};
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const gridI = Number(props.grid_i);
    const gridJ = Number(props.grid_j);
      const value =
      rrfsChart === "850mb" || rrfsChart === "300mb"
        ? Number(props.wind_speed_kt)
        : rrfsChart === "700mb"
          ? Number(props.relative_humidity_pct)
          : Number(props.absolute_vorticity_s1);
    if (!Number.isFinite(value) || !Number.isFinite(gridI) || !Number.isFinite(gridJ)) continue;
    const p = mapObj.project([Number(coords[0]), Number(coords[1])]);
    const i = Math.round(gridI);
    const j = Math.round(gridJ);
    if (i < 0 || j < 0) continue;
    maxI = Math.max(maxI, i);
    maxJ = Math.max(maxJ, j);
    nodes.set(`${i}:${j}`, { x: p.x, y: p.y, val: value });
  }
  if (nodes.size < 4 || maxI < 1 || maxJ < 1) return true;

  ctx.save();
  ctx.globalAlpha = 0.4;
  for (let j = 0; j < maxJ; j++) {
    for (let i = 0; i < maxI; i++) {
      const p00 = nodes.get(`${i}:${j}`);
      const p10 = nodes.get(`${i + 1}:${j}`);
      const p11 = nodes.get(`${i + 1}:${j + 1}`);
      const p01 = nodes.get(`${i}:${j + 1}`);
      if (!p00 || !p10 || !p11 || !p01) continue;

      const meanValue = (p00.val + p10.val + p11.val + p01.val) / 4;
      const color =
        rrfsChart === "850mb"
          ? rrfs850WindFillColor(meanValue)
          : rrfsChart === "300mb"
            ? rrfs300WindFillColor(meanValue)
          : rrfsChart === "700mb"
            ? rrfs700RhFillColor(meanValue)
            : rrfs500VortFillColor(meanValue);
      if (!color) continue;

      const minX = Math.min(p00.x, p10.x, p11.x, p01.x);
      const maxX = Math.max(p00.x, p10.x, p11.x, p01.x);
      const minY = Math.min(p00.y, p10.y, p11.y, p01.y);
      const maxY = Math.max(p00.y, p10.y, p11.y, p01.y);
      if (maxX < -40 || minX > width + 40 || maxY < -40 || minY > height + 40) continue;

      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y);
      ctx.lineTo(p10.x, p10.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.lineTo(p01.x, p01.y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
  ctx.restore();
  return true;
}, [rrfsChart, rrfsFillGeoJson]);

const drawRrfsWindOverlay = useCallback(() => {
  const canvas = rrfsWindCanvasRef.current;
  const mapObj = mapRef.current?.getMap();
  if (!canvas || !mapObj) return false;

  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const dpr = window.devicePixelRatio || 1;
  if (width < 2 || height < 2) return false;

  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx0 = canvas.getContext("2d");
  if (!ctx0) return false;
  const ctx = ctx0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (rrfsChart === "none" || !rrfsWindsGeoJson?.features?.length) return true;

  const zoom = mapObj.getZoom();
  const stride = zoom < 4.5 ? 6 : zoom < 6 ? 4 : zoom < 7.5 ? 3 : zoom < 9 ? 2 : 1;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.strokeStyle = "#111827";
  ctx.fillStyle = "#111827";
  ctx.lineWidth = 1.3;

  for (const feature of rrfsWindsGeoJson.features) {
    const coords = feature?.geometry?.coordinates;
    const props = feature?.properties ?? {};
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const gridI = Number(props.grid_i);
    const gridJ = Number(props.grid_j);
    if (Number.isFinite(gridI) && Number.isFinite(gridJ) && ((gridI % stride !== 0) || (gridJ % stride !== 0))) continue;
    const dir = Number(props.wind_dir_deg);
    const spd = Number(props.wind_speed_kt);
    if (!Number.isFinite(dir) || !Number.isFinite(spd) || spd < 2) continue;
    const p = mapObj.project([Number(coords[0]), Number(coords[1])]);
    if (p.x < -24 || p.x > width + 24 || p.y < -24 || p.y > height + 24) continue;
    drawWindBarb(ctx, p.x, p.y, 0, dir, spd);
  }

  ctx.restore();
  return true;
}, [rrfsChart, rrfsWindsGeoJson]);

const drawRrfsContourOverlay = useCallback(() => {
  const canvas = rrfsContourCanvasRef.current;
  const mapObj = mapRef.current?.getMap();
  if (!canvas || !mapObj) return false;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (width < 2 || height < 2) return false;

  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx0 = canvas.getContext("2d");
  if (!ctx0) return false;
  const ctx = ctx0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (rrfsChart === "none" || !rrfsContoursGeoJson?.features?.length) return true;

  const grouped = new Map<string, { member: string; level: number; segments: Pt[][] }>();
  for (const feature of rrfsContoursGeoJson.features) {
    if (feature?.geometry?.type !== "LineString") continue;
    const props = feature?.properties ?? {};
    if (props.role !== "line") continue;
    const member = String(props.member ?? "");
    const level = Number(props.level);
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(level) || !member) continue;

    const seg: Pt[] = [];
    for (const pair of coords) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lon = Number(pair[0]);
      const lat = Number(pair[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const p = mapObj.project([lon, lat]);
      seg.push({ x: p.x, y: p.y });
    }
    if (seg.length < 2) continue;

    const key = `${member}:${level}`;
    const entry = grouped.get(key) ?? { member, level, segments: [] };
    entry.segments.push(seg);
    grouped.set(key, entry);
  }

  ctx.save();
  ctx.globalAlpha = 0.92;
  for (const entry of grouped.values()) {
    if (entry.member === "height") {
      strokeIsobars(ctx, stitchProjectedContourSegments(entry.segments), entry.level);
    } else if (entry.member === "temperature") {
      strokeIsotherms(ctx, entry.segments, entry.level, 0, rrfsChart === "500mb");
    } else if (entry.member === "dewpoint") {
      strokeIsodrosotherms(ctx, entry.segments, entry.level);
    } else if (entry.member === "divergence") {
      strokeDivergenceContours(ctx, entry.segments);
    }
  }
  ctx.restore();
  return true;
}, [rrfsChart, rrfsContoursGeoJson]);

const drawRrfsLabelOverlay = useCallback(() => {
  const canvas = analysisLabelCanvasRef.current;
  const mapObj = mapRef.current?.getMap();
  if (!canvas || !mapObj) return false;
  const zoom = typeof viewState.zoom === "number" ? viewState.zoom : mapObj.getZoom();

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (width < 2 || height < 2) return false;

  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx0 = canvas.getContext("2d");
  if (!ctx0) return false;
  const ctx = ctx0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (rrfsChart === "none" || !rrfsContoursGeoJson?.features?.length) return true;

  const grouped = new Map<string, { member: string; level: number; segments: Pt[][] }>();
  for (const feature of rrfsContoursGeoJson.features) {
    if (feature?.geometry?.type !== "LineString") continue;
    const props = feature?.properties ?? {};
    if (props.role !== "line") continue;
    const member = String(props.member ?? "");
    const level = Number(props.level);
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(level) || !member) continue;

    const seg: Pt[] = [];
    for (const pair of coords) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lon = Number(pair[0]);
      const lat = Number(pair[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const p = mapObj.project([lon, lat]);
      seg.push({ x: p.x, y: p.y });
    }
    if (seg.length < 2) continue;

    const key = `${member}:${level}`;
    const entry = grouped.get(key) ?? { member, level, segments: [] };
    entry.segments.push(seg);
    grouped.set(key, entry);
  }

  const rrfsLabelOptions =
    zoom < 5
      ? { fontPx: 13, maxLabels: 4, minLen: 95, repeatLongSegments: true, labelSpacingPx: 260 }
      : zoom < 6
        ? { fontPx: 14, maxLabels: 7, minLen: 65, repeatLongSegments: true, labelSpacingPx: 190 }
        : zoom < 7
          ? { fontPx: 15, maxLabels: 11, minLen: 42, repeatLongSegments: true, labelSpacingPx: 135 }
          : { fontPx: 16, maxLabels: 16, minLen: 24, repeatLongSegments: true, labelSpacingPx: 90 };

  for (const entry of grouped.values()) {
    if (entry.member === "height") {
      labelContours(ctx, stitchProjectedContourSegments(entry.segments), entry.level, "slp", {
        tempUnit: "C",
        labelText: `${Math.round(entry.level)}`,
        ...rrfsLabelOptions,
      });
    } else if (entry.member === "temperature") {
      labelContours(ctx, entry.segments, entry.level, "temp", {
        tempUnit: "C",
        freezingLevel: 0,
        labelColorOverride: rrfsChart === "500mb" ? "#dc2626" : undefined,
        labelText: `${Math.round(entry.level)}`,
        ...rrfsLabelOptions,
      });
    } else if (entry.member === "dewpoint") {
      labelContours(ctx, entry.segments, entry.level, "dewpoint", {
        tempUnit: "C",
        labelText: `${Math.round(entry.level)}`,
        ...rrfsLabelOptions,
      });
    } else if (entry.member === "divergence") {
      labelContours(ctx, entry.segments, entry.level, "divergence", {
        tempUnit: "C",
        labelText: `${Math.round(entry.level * 1e5)}`,
        ...rrfsLabelOptions,
      });
    }
  }

  return true;
}, [rrfsChart, rrfsContoursGeoJson, viewState.zoom]);

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
  if (nwsOverlays.wpcSurface && frontRenderStyle === "classic" && wpcFrontCanvasRef.current) {
    overlayCanvases.push(wpcFrontCanvasRef.current);
  }
  if (analysisCanvasRef.current) overlayCanvases.push(analysisCanvasRef.current);
  if (rrfsFillCanvasRef.current) overlayCanvases.push(rrfsFillCanvasRef.current);
  if (rrfsContourCanvasRef.current) overlayCanvases.push(rrfsContourCanvasRef.current);
  if (showStations && displayMode === "plots" && canvasRef.current) overlayCanvases.push(canvasRef.current);
  if (analysisLabelCanvasRef.current) overlayCanvases.push(analysisLabelCanvasRef.current);
  if (rrfsWindCanvasRef.current) overlayCanvases.push(rrfsWindCanvasRef.current);

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

    if (rrfsGradientLegend) {
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
      ctx.fillText(rrfsGradientLegend.title.toUpperCase(), x + padX, y + padY + titleH - 2 * scale);

      const barX = x + padX;
      const barY = y + padY + titleH + titleGap;
      const barW = 18 * scale;
      const barH = cardHeight - (padY * 2 + titleH + titleGap + 8 * scale);
      const grad = ctx.createLinearGradient(0, barY + barH, 0, barY);
      grad.addColorStop(0.0, "#000004");
      grad.addColorStop(0.18, "#180f3d");
      grad.addColorStop(0.36, "#440f76");
      grad.addColorStop(0.52, "#721f81");
      grad.addColorStop(0.66, "#9e2f7f");
      grad.addColorStop(0.79, "#cd4071");
      grad.addColorStop(0.90, "#f1605d");
      grad.addColorStop(0.96, "#fd9668");
      grad.addColorStop(1.0, "#feca8d");
      ctx.fillStyle = grad;
      drawRoundRect(barX, barY, barW, barH, 3 * scale);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.stroke();

      const ticks = [45, 35, 25, 15, 5];
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = "#e5e7eb";
      for (const t of ticks) {
        const p = (t - RRFS_500_VORT_MIN) / (RRFS_500_VORT_MAX - RRFS_500_VORT_MIN);
        const yy = barY + barH - p * barH;
        ctx.fillText(`${t}`, barX + barW + 8 * scale, yy + 3 * scale);
      }
    }

    if (contourLegendItems.length > 0) {
      ctx.font = `600 ${titleFontSize}px sans-serif`;
      let maxTextWidth = Math.ceil(ctx.measureText("Lines").width);
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
      ctx.fillText("LINES", x + padX, y + padY + titleH - 2 * scale);

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
}, [showStations, displayMode, includeLegendInExport, activeFillLegendCards, contourLegendItems, validTimeLabel, nwsOverlays.wpcSurface, frontRenderStyle, legendsCollapsed, mrmsGradientLegend, rrfsGradientLegend]);

useEffect(() => {
  localStorage.setItem("showStations", String(showStations));
}, [showStations]);

useEffect(() => {
  localStorage.setItem("selectedViewId", selectedViewId);
}, [selectedViewId]);

useEffect(() => {
  if (!anyAnalysisLikeOverlayOn) {
    setAnalysisLoadState("idle");
    return;
  }
  if (!mapLoaded) {
    setAnalysisLoadState("loading");
    return;
  }

  let cancelled = false;
  let frame2: number | null = null;
  setAnalysisLoadState("loading");
  const frameId = window.requestAnimationFrame(() => {
    frame2 = window.requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        drawAnalysisOverlay();
        if (!cancelled) setAnalysisLoadState("ready");
      } catch (error) {
        console.error("Failed to draw objective analysis overlay:", error);
        if (!cancelled) setAnalysisLoadState("error");
      }
    });
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frameId);
    if (frame2 != null) window.cancelAnimationFrame(frame2);
  };
}, [mapLoaded, anyAnalysisLikeOverlayOn, drawAnalysisOverlay]);

useEffect(() => {
  if (!mapLoaded || !anyRrfsContourOn) return;

  let cancelled = false;
  let frame2: number | null = null;
  const frameId = window.requestAnimationFrame(() => {
    frame2 = window.requestAnimationFrame(() => {
      if (cancelled) return;
      drawRrfsFillOverlay();
      drawRrfsContourOverlay();
      drawRrfsWindOverlay();
      drawRrfsLabelOverlay();
    });
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frameId);
    if (frame2 != null) window.cancelAnimationFrame(frame2);
  };
}, [mapLoaded, anyRrfsContourOn, drawRrfsFillOverlay, drawRrfsContourOverlay, drawRrfsWindOverlay, drawRrfsLabelOverlay]);

useEffect(() => {
  if (!mapLoaded || !anyAnalysisLikeOverlayOn) return;

  const map = mapRef.current?.getMap();
  if (!map) return;

  const runRedraw = () => {
    if (analysisAnimationFrameRef.current) {
      cancelAnimationFrame(analysisAnimationFrameRef.current);
    }
    analysisAnimationFrameRef.current = requestAnimationFrame(() => {
      analysisLastDrawRef.current = performance.now();
      drawAnalysisOverlay();
    });
  };

  const scheduleThrottledRedraw = () => {
    const now = performance.now();
    const elapsed = now - analysisLastDrawRef.current;
    const throttleMs = 120;
    if (elapsed >= throttleMs) {
      if (analysisThrottleTimeoutRef.current != null) {
        window.clearTimeout(analysisThrottleTimeoutRef.current);
        analysisThrottleTimeoutRef.current = null;
      }
      runRedraw();
      return;
    }
    if (analysisThrottleTimeoutRef.current != null) return;
    analysisThrottleTimeoutRef.current = window.setTimeout(() => {
      analysisThrottleTimeoutRef.current = null;
      runRedraw();
    }, throttleMs - elapsed);
  };

  const finalizeRedraw = () => {
    if (analysisThrottleTimeoutRef.current != null) {
      window.clearTimeout(analysisThrottleTimeoutRef.current);
      analysisThrottleTimeoutRef.current = null;
    }
    runRedraw();
  };

  map.on("move", scheduleThrottledRedraw);
  map.on("zoom", scheduleThrottledRedraw);
  map.on("moveend", finalizeRedraw);
  map.on("zoomend", finalizeRedraw);
  map.on("resize", finalizeRedraw);
  finalizeRedraw();

  return () => {
    map.off("move", scheduleThrottledRedraw);
    map.off("zoom", scheduleThrottledRedraw);
    map.off("moveend", finalizeRedraw);
    map.off("zoomend", finalizeRedraw);
    map.off("resize", finalizeRedraw);
    if (analysisAnimationFrameRef.current) {
      cancelAnimationFrame(analysisAnimationFrameRef.current);
      analysisAnimationFrameRef.current = null;
    }
    if (analysisThrottleTimeoutRef.current != null) {
      window.clearTimeout(analysisThrottleTimeoutRef.current);
      analysisThrottleTimeoutRef.current = null;
    }
  };
}, [mapLoaded, anyAnalysisLikeOverlayOn, drawAnalysisOverlay]);

useEffect(() => {
  if (!mapLoaded || !anyRrfsContourOn) return;

  const map = mapRef.current?.getMap();
  if (!map) return;

  const runRedraw = () => {
    if (rrfsAnimationFrameRef.current) {
      cancelAnimationFrame(rrfsAnimationFrameRef.current);
    }
    rrfsAnimationFrameRef.current = requestAnimationFrame(() => {
      rrfsLastDrawRef.current = performance.now();
      drawRrfsFillOverlay();
      drawRrfsContourOverlay();
      drawRrfsWindOverlay();
      drawRrfsLabelOverlay();
    });
  };

  const scheduleThrottledRedraw = () => {
    const now = performance.now();
    const elapsed = now - rrfsLastDrawRef.current;
    const throttleMs = 120;
    if (elapsed >= throttleMs) {
      if (rrfsThrottleTimeoutRef.current != null) {
        window.clearTimeout(rrfsThrottleTimeoutRef.current);
        rrfsThrottleTimeoutRef.current = null;
      }
      runRedraw();
      return;
    }
    if (rrfsThrottleTimeoutRef.current != null) return;
    rrfsThrottleTimeoutRef.current = window.setTimeout(() => {
      rrfsThrottleTimeoutRef.current = null;
      runRedraw();
    }, throttleMs - elapsed);
  };

  const finalizeRedraw = () => {
    if (rrfsThrottleTimeoutRef.current != null) {
      window.clearTimeout(rrfsThrottleTimeoutRef.current);
      rrfsThrottleTimeoutRef.current = null;
    }
    runRedraw();
  };

  map.on("move", scheduleThrottledRedraw);
  map.on("zoom", scheduleThrottledRedraw);
  map.on("moveend", finalizeRedraw);
  map.on("zoomend", finalizeRedraw);
  map.on("resize", finalizeRedraw);
  finalizeRedraw();

  return () => {
    map.off("move", scheduleThrottledRedraw);
    map.off("zoom", scheduleThrottledRedraw);
    map.off("moveend", finalizeRedraw);
    map.off("zoomend", finalizeRedraw);
    map.off("resize", finalizeRedraw);
    if (rrfsAnimationFrameRef.current) {
      cancelAnimationFrame(rrfsAnimationFrameRef.current);
      rrfsAnimationFrameRef.current = null;
    }
    if (rrfsThrottleTimeoutRef.current != null) {
      window.clearTimeout(rrfsThrottleTimeoutRef.current);
      rrfsThrottleTimeoutRef.current = null;
    }
  };
}, [mapLoaded, anyRrfsContourOn, drawRrfsFillOverlay, drawRrfsContourOverlay, drawRrfsWindOverlay, drawRrfsLabelOverlay]);

useEffect(() => {
  localStorage.setItem("analysisOverlays", JSON.stringify(analysisOverlays));
}, [analysisOverlays]);

useEffect(() => {
  localStorage.setItem("analysisFill", analysisFill);
}, [analysisFill]);

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
  localStorage.setItem("selectedTimeBucket", LIVE_ONLY_PROFILE ? "latest" : selectedTimeBucket);
}, [selectedTimeBucket]);

useEffect(() => {
  localStorage.setItem("mrmsField", RASTER_PRODUCTS_ENABLED ? mrmsField : "none");
}, [mrmsField]);

useEffect(() => {
  localStorage.setItem("goesProduct", RASTER_PRODUCTS_ENABLED ? goesProduct : "none");
}, [goesProduct]);

useEffect(() => {
  localStorage.setItem("glmProduct", RASTER_PRODUCTS_ENABLED ? glmProduct : "none");
}, [glmProduct]);

useEffect(() => {
  localStorage.setItem("rrfsContours", JSON.stringify(rrfsChart));
}, [rrfsChart]);

useEffect(() => {
  localStorage.setItem("goesRenderStyle", goesRenderStyle);
}, [goesRenderStyle]);

useEffect(() => {
  localStorage.setItem("nwsOverlays", JSON.stringify(nwsOverlays));
}, [nwsOverlays]);

useEffect(() => {
  localStorage.setItem("hazardSectionOpen", JSON.stringify(hazardSectionOpen));
}, [hazardSectionOpen]);

useEffect(() => {
  localStorage.setItem("frontRenderStyle", frontRenderStyle);
}, [frontRenderStyle]);

useEffect(() => {
  if (!showCursorDiagnostics) setCursorProbe(null);
}, [showCursorDiagnostics]);

useEffect(() => {
  if (!showCursorDiagnostics) return;
  if (!cursorProbe) return;
  const map = mapRef.current?.getMap();
  if (!map) return;

  const refreshProbeFromScreenPoint = () => {
    const ll = map.unproject([cursorProbe.x, cursorProbe.y]);
    setCursorProbe((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        lng: ll.lng,
        lat: ll.lat,
      };
    });
  };

  map.on("move", refreshProbeFromScreenPoint);
  map.on("zoom", refreshProbeFromScreenPoint);
  map.on("moveend", refreshProbeFromScreenPoint);
  map.on("zoomend", refreshProbeFromScreenPoint);

  return () => {
    map.off("move", refreshProbeFromScreenPoint);
    map.off("zoom", refreshProbeFromScreenPoint);
    map.off("moveend", refreshProbeFromScreenPoint);
    map.off("zoomend", refreshProbeFromScreenPoint);
  };
}, [showCursorDiagnostics, cursorProbe?.x, cursorProbe?.y]);

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
    if (anyRrfsContourOn) drawRrfsFillOverlay();
    if (anyRrfsContourOn) drawRrfsContourOverlay();
    if (anyRrfsContourOn) drawRrfsWindOverlay();
    if (anyRrfsContourOn) drawRrfsLabelOverlay();

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
  anyRrfsContourOn,
  drawRrfsFillOverlay,
  drawRrfsContourOverlay,
  drawRrfsWindOverlay,
  drawRrfsLabelOverlay,
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
            <div
              className={`analysis-control ${openHeaderMenu === "analysis" ? "menu-open" : ""}`}
            >
              <div className="analysis-title">Objective Analysis</div>
              <div className={`analysis-dropdown ${openHeaderMenu === "analysis" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className="analysis-dropdown-trigger"
                  onClick={() => setOpenHeaderMenu((current) => (current === "analysis" ? null : "analysis"))}
                >
                  Analysis Layers
                </button>
                {openHeaderMenu === "analysis" && (
                <div className="analysis-menu">
                  <div className="analysis-subsection-title">Surface Stations</div>
                  <label>
                    <input
                      type="checkbox"
                      checked={showStations}
                      onChange={(e) => setShowStations(e.target.checked)}
                    />
                    Show Surface Stations
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="surface-stations-mode"
                      checked={displayMode === "plots"}
                      onChange={() => setSurfaceObsMode("plots")}
                      disabled={!showStations}
                    />
                    Station Plots
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="surface-stations-mode"
                      checked={displayMode === "dots"}
                      onChange={() => setSurfaceObsMode("dots")}
                      disabled={!showStations}
                    />
                    Colored Flight Rule
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="surface-stations-mode"
                      checked={displayMode === "weather"}
                      onChange={() => setSurfaceObsMode("weather")}
                      disabled={!showStations}
                    />
                    Present Wx Symbols
                  </label>
                  <div className="analysis-subsection-title">Isopleths</div>
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
                  <div className="analysis-subsection-title">Filled Analysis</div>
                  <label>
                    <input
                      type="radio"
                      name="analysis-fill"
                      checked={analysisFill === "none"}
                      onChange={() => setAnalysisFill("none")}
                    />
                    Off
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="analysis-fill"
                      checked={analysisFill === "windSpeed"}
                      onChange={() => setAnalysisFill("windSpeed")}
                    />
                    Wind Speed
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="analysis-fill"
                      checked={analysisFill === "ceiling"}
                      onChange={() => setAnalysisFill("ceiling")}
                    />
                    Ceiling (&le;050)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="analysis-fill"
                      checked={analysisFill === "visibility"}
                      onChange={() => setAnalysisFill("visibility")}
                    />
                    Visibility (&le;6SM)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="analysis-fill"
                      checked={analysisFill === "relativeHumidity"}
                      onChange={() => setAnalysisFill("relativeHumidity")}
                    />
                    Relative Humidity
                  </label>
                </div>
                )}
              </div>
            </div>
            <div
              className={`analysis-control ${openHeaderMenu === "derived" ? "menu-open" : ""}`}
            >
              <div className="analysis-title">Derived Fields</div>
              <div className={`analysis-dropdown ${openHeaderMenu === "derived" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className="analysis-dropdown-trigger"
                  onClick={() => setOpenHeaderMenu((current) => (current === "derived" ? null : "derived"))}
                >
                  Derived Fields
                </button>
                {openHeaderMenu === "derived" && (
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
                </div>
                )}
              </div>
            </div>
            <div
              className={`analysis-control ${openHeaderMenu === "mrms" ? "menu-open" : ""}`}
            >
              <div className="analysis-title">MRMS</div>
              <div className={`analysis-dropdown ${openHeaderMenu === "mrms" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className="analysis-dropdown-trigger"
                  onClick={() => setOpenHeaderMenu((current) => (current === "mrms" ? null : "mrms"))}
                >
                  MRMS Fields
                </button>
                {openHeaderMenu === "mrms" && (
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
                      checked={mrmsField === "rotationll240"}
                      onChange={() => setMrmsField("rotationll240")}
                    />
                    4-Hour Low-Level Rotation Tracks (1/s)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mrms-field"
                      checked={mrmsField === "rotationml240"}
                      onChange={() => setMrmsField("rotationml240")}
                    />
                    4-Hour Mid-Level Rotation Tracks (1/s)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mrms-field"
                      checked={mrmsField === "posh"}
                      onChange={() => setMrmsField("posh")}
                    />
                    Probability of Severe Hail (POSH) (%)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mrms-field"
                      checked={mrmsField === "mesh240"}
                      onChange={() => setMrmsField("mesh240")}
                    />
                    4-Hour Maximum Estimated Hail Size (MESH) (in)
                  </label>
                </div>
                )}
              </div>
            </div>
            <div
              className={`analysis-control ${openHeaderMenu === "goes" ? "menu-open" : ""}`}
            >
              <div className="analysis-title">GOES Satellite</div>
              <div className={`analysis-dropdown ${openHeaderMenu === "goes" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className="analysis-dropdown-trigger"
                  onClick={() => setOpenHeaderMenu((current) => (current === "goes" ? null : "goes"))}
                >
                  GOES Satellite
                </button>
                {openHeaderMenu === "goes" && (
                <div className="analysis-menu goes-menu">
                  <label>
                    <input
                      type="radio"
                      name="goes-product"
                      checked={goesProduct === "none"}
                      onChange={() => setGoesProduct("none")}
                    />
                    Off
                  </label>
                  <details className="view-submenu goes-submenu">
                    <summary>Display Style</summary>
                    <div className="view-submenu-content goes-submenu-content">
                      <div className="goes-submenu-options">
                        <label>
                          <input
                            type="radio"
                            name="goes-render-style"
                            checked={goesRenderStyle === "enhanced"}
                            onChange={() => setGoesRenderStyle("enhanced")}
                          />
                          Enhanced
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="goes-render-style"
                            checked={goesRenderStyle === "grayscale"}
                            onChange={() => setGoesRenderStyle("grayscale")}
                          />
                          Grayscale
                        </label>
                      </div>
                    </div>
                  </details>
                  {GOES_MENU_GROUPS.map((group) => (
                    <details className="view-submenu goes-submenu" key={group.id}>
                      <summary>{group.title}</summary>
                      <div className="view-submenu-content goes-submenu-content">
                        <div className="goes-submenu-options">
                          {GOES_BAND_OPTIONS.map((option) => {
                            const productId = `${group.id}-${option.band}` as GoesProduct;
                            return (
                              <label key={productId}>
                                <input
                                  type="radio"
                                  name="goes-product"
                                  checked={goesProduct === productId}
                                  onChange={() => setGoesProduct(productId)}
                                />
                                {option.label}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </details>
                  ))}
                  <details className="view-submenu goes-submenu">
                    <summary>GLM Lightning</summary>
                    <div className="view-submenu-content goes-submenu-content">
                      <div className="goes-submenu-options">
                        <label>
                          <input
                            type="radio"
                            name="glm-product"
                            checked={glmProduct === "none"}
                            onChange={() => setGlmProduct("none")}
                          />
                          Off
                        </label>
                        {GLM_OPTIONS.map((option) => (
                          <label key={option.product}>
                            <input
                              type="radio"
                              name="glm-product"
                              checked={glmProduct === option.product}
                              onChange={() => setGlmProduct(option.product)}
                            />
                            {option.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </details>
                </div>
                )}
              </div>
            </div>
            <div
              className={`analysis-control ${openHeaderMenu === "nws" ? "menu-open" : ""}`}
            >
              <div className="analysis-title">NWS Products</div>
              <div className={`analysis-dropdown ${openHeaderMenu === "nws" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className="analysis-dropdown-trigger"
                  onClick={() => setOpenHeaderMenu((current) => (current === "nws" ? null : "nws"))}
                >
                  NWS Products
                </button>
                {openHeaderMenu === "nws" && (
                <div className="analysis-menu">
                  <label>
                    <input
                      type="checkbox"
                      checked={nwsOverlays.wpcSurface}
                      onChange={(e) => setNwsOverlays((s) => ({ ...s, wpcSurface: e.target.checked }))}
                    />
                    WPC Surface Analysis
                  </label>
                  <div className="analysis-subsection-title">Hazards</div>
                  <label>
                    <input
                      type="checkbox"
                      checked={nwsOverlays.convectiveWatches}
                      onChange={(e) => setNwsOverlays((s) => ({ ...s, convectiveWatches: e.target.checked }))}
                    />
                    SPC Convective Watches
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={nwsOverlays.convectiveWarnings}
                      onChange={(e) => setNwsOverlays((s) => ({ ...s, convectiveWarnings: e.target.checked }))}
                    />
                    Convective Warnings
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={nwsOverlays.floodWarnings}
                      onChange={(e) => setNwsOverlays((s) => ({ ...s, floodWarnings: e.target.checked }))}
                    />
                    Flood Warnings
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={nwsOverlays.spcMesoscaleDiscussions}
                      onChange={(e) => setNwsOverlays((s) => ({ ...s, spcMesoscaleDiscussions: e.target.checked }))}
                    />
                    SPC Mesoscale Discussions
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={nwsOverlays.wpcMesoscaleDiscussions}
                      onChange={(e) => setNwsOverlays((s) => ({ ...s, wpcMesoscaleDiscussions: e.target.checked }))}
                    />
                    WPC Mesoscale Discussions
                  </label>
                </div>
                )}
              </div>
            </div>
            <div
              className={`geography-control ${openHeaderMenu === "geography" ? "menu-open" : ""}`}
            >
              <div className="geography-title">Geographies</div>
              <div className={`geography-dropdown ${openHeaderMenu === "geography" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className="analysis-dropdown-trigger geography-dropdown-trigger"
                  onClick={() => setOpenHeaderMenu((current) => (current === "geography" ? null : "geography"))}
                >
                  Geographic Layers
                </button>
                {openHeaderMenu === "geography" && (
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
                )}
              </div>
            </div>
            </div>
            <div className="header-row header-row-bottom">
            <div className="time-control">
              <div className="time-title">TIME</div>
              {!LIVE_ONLY_PROFILE && (
                <div className="time-row">
                  <button
                    type="button"
                    className="control-btn"
                    onClick={() => {
                      setIsPlaying(false);
                      setSelectedTimeBucket((prev) => {
                        const idx = activeTimeBuckets.findIndex((bucket) => bucket.id === prev);
                        return idx <= 0 ? prev : activeTimeBuckets[idx - 1].id;
                      });
                    }}
                    disabled={activeTimeBuckets.findIndex((bucket) => bucket.id === selectedTimeBucket) <= 0}
                  >
                    ◀
                  </button>

                  <button
                    type="button"
                    className={`control-btn ${isPlaying ? "active" : ""}`}
                    onClick={() => setIsPlaying((p) => !p)}
                    disabled={activeTimeBuckets.length < 2}
                  >
                    {isPlaying ? "Pause" : "Play"}
                  </button>

                  <button
                    type="button"
                    className="control-btn"
                    onClick={() => {
                      setIsPlaying(false);
                      setSelectedTimeBucket((prev) => {
                        const idx = activeTimeBuckets.findIndex((bucket) => bucket.id === prev);
                        return idx >= activeTimeBuckets.length - 1 ? prev : activeTimeBuckets[idx + 1].id;
                      });
                    }}
                    disabled={activeTimeBuckets.findIndex((bucket) => bucket.id === selectedTimeBucket) >= activeTimeBuckets.length - 1}
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
              )}

              <div className="time-bucket-row">
                {activeTimeBuckets.map((bucket) => (
                  <button
                    key={bucket.id}
                    type="button"
                    className={`time-bucket-btn ${selectedTimeBucket === bucket.id ? "active" : ""}`}
                    onClick={() => {
                      setIsPlaying(false);
                      setSelectedTimeBucket(bucket.id);
                    }}
                  >
                    {bucket.label}
                  </button>
                ))}
              </div>

              <div className="time-label">
                {selectedBucket.label}
                {selectedTimeDisplayIso ? ` • ${formatValidTimeLabel(selectedTimeDisplayIso, displayTimeZone)}` : ""}
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
            {glmProduct !== "none" && glmMeta?.stale_warning && (
              <div className="mrms-warning-overlay" style={{ top: mrmsField !== "none" && mrmsMeta?.stale_warning ? 44 : undefined }}>
                GLM {getGlmProductLabel(glmProduct)} warning: matched frame is {Math.round(glmMeta.age_minutes)} minutes old
                ({glmMeta.matched_time ? formatZulu(glmMeta.matched_time) : "—"}).
              </div>
            )}
            {glmProduct !== "none" && glmError && (
              <div
                className="mrms-warning-overlay mrms-warning-error"
                style={{ top: mrmsField !== "none" || (glmMeta?.stale_warning ?? false) ? 44 : undefined }}
              >
                GLM {getGlmProductLabel(glmProduct)} unavailable: {glmError}
              </div>
            )}
            {rrfsChart !== "none" && rrfsMeta?.stale_warning && (
              <div className="mrms-warning-overlay">
                {getRrfsChartLabel(rrfsChart)} warning: matched field is {Math.round(rrfsMeta.age_minutes)} minutes old
                ({rrfsMeta.matched_time ? formatZulu(rrfsMeta.matched_time) : "—"}).
              </div>
            )}
            {rrfsChart !== "none" && rrfsError && (
              <div className="mrms-warning-overlay mrms-warning-error">
                {getRrfsChartLabel(rrfsChart)} unavailable: {rrfsError}
              </div>
            )}
            {anyRrfsContourOn && (
              <canvas
                ref={rrfsFillCanvasRef}
                className="rrfs-fill-canvas"
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
            {nwsOverlays.wpcSurface && wpcSurface?.stale_warning && (
              <div className="mrms-warning-overlay">
                WPC surface analysis warning: latest parsed valid time is {wpcSurface.valid_time ? formatZulu(wpcSurface.valid_time) : "unknown"}
                {typeof wpcSurface.age_minutes === "number" ? ` (${Math.round(wpcSurface.age_minutes)} min old)` : ""}.
              </div>
            )}
            {nwsOverlays.wpcSurface && wpcError && (
              <div className="mrms-warning-overlay mrms-warning-error">
                WPC surface analysis unavailable: {wpcError}
              </div>
            )}
            {hazardError && (
              <div className="mrms-warning-overlay mrms-warning-error" style={{ top: 44 }}>
                Hazards unavailable: {hazardError}
              </div>
            )}
            {nwsOverlays.wpcSurface && frontRenderStyle === "classic" && (
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

            {anyRrfsContourOn && (
              <canvas
                ref={rrfsContourCanvasRef}
                className="rrfs-contour-canvas"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                  zIndex: 15,
                }}
              />
            )}

            {anyRrfsContourOn && (
              <canvas
                ref={rrfsWindCanvasRef}
                className="rrfs-wind-canvas"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                  zIndex: 16,
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

            {(anyAnalysisLikeOverlayOn || anyRrfsContourOn) && (
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

            {!legendsCollapsed && (activeFillLegendCards.length > 0 || Boolean(mrmsGradientLegend) || Boolean(goesGradientLegend) || Boolean(rrfsGradientLegend)) && (
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
                {goesGradientLegend && (
                  <div className="analysis-legend">
                    <div className="wind-fill-legend-title">{goesGradientLegend.title}</div>
                  <div className="mrms-gradient-legend-body">
                    <div className="mrms-gradient-bar" style={{ background: goesGradientLegend.gradientCss }} />
                    <div className="mrms-gradient-labels">
                      {goesGradientLegend.labels.map((lbl) => (
                        <span key={`goes-grad-${lbl}`}>{lbl}</span>
                      ))}
                    </div>
                  </div>
                  </div>
                )}
                {rrfsGradientLegend && (
                  <div className="analysis-legend">
                    <div className="wind-fill-legend-title">{rrfsGradientLegend.title}</div>
                    <div className="mrms-gradient-legend-body">
                      <div className="mrms-gradient-bar" style={{ background: rrfsGradientLegend.gradientCss }} />
                      <div className="mrms-gradient-labels">
                        {rrfsGradientLegend.labels.map((lbl) => (
                          <span key={`rrfs-gradient-${lbl}`}>{lbl}</span>
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
                  <div className="wind-fill-legend-title">Lines</div>
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
              interactiveLayerIds={[
                ...(visibleHazardFeatures.length > 0 ? HAZARD_LAYER_IDS : []),
                ...(showStations
                  ? (displayMode === "plots" || displayMode === "weather" ? ["hit-targets"] : ["unclustered"])
                  : []),
              ]}
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
                const map = mapRef.current?.getMap();
                if (!map) return;

                if (visibleHazardFeatures.length > 0) {
                  const hazardFeatures = map.queryRenderedFeatures(e.point, { layers: HAZARD_LAYER_IDS });
                  const hazardFeature = hazardFeatures?.[0];
                  const hazardId = String((hazardFeature?.properties as any)?.id ?? "");
                  if (hazardId) {
                    const currentItems = [
                      ...(hazardSummary?.current?.warnings ?? []),
                      ...(hazardSummary?.current?.watches ?? []),
                      ...(hazardSummary?.current?.discussions ?? []),
                    ];
                    const hazard =
                      currentItems.find((item) => item.id === hazardId)
                      ?? ((hazardFeature?.properties as any) as HazardListItem | undefined);
                    if (hazard) {
                      setSelectedHazard(hazard as HazardListItem);
                      return;
                    }
                  }
                }

                if (!showStations) return;
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
              {goesProduct !== "none" && goesTileTemplate && (
                <Source
                  id="goes-raster-tiles"
                  key={goesTileTemplate}
                  type="raster"
                  tiles={[goesTileTemplate]}
                  tileSize={256}
                >
                  <Layer {...goesRasterLayer} />
                </Source>
              )}
              {glmProduct !== "none" && glmTileTemplate && (
                <Source
                  id="glm-raster-tiles"
                  key={glmTileTemplate}
                  type="raster"
                  tiles={[glmTileTemplate]}
                  tileSize={256}
                >
                  <Layer {...glmRasterLayer} />
                </Source>
              )}
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
              {visibleHazardFeatures.length > 0 && (
                <Source id="hazards-source" type="geojson" data={visibleHazardsGeoJson}>
                  {hazardLineLayers.map((layer) => (
                    <Layer key={layer.id} {...layer} />
                  ))}
                </Source>
              )}
              {nwsOverlays.wpcSurface && wpcSurface && frontRenderStyle === "simple" && (
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
              {nwsOverlays.wpcSurface && wpcSurface && (
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
          <div className="loading-progress-panel map-loading-progress">
            <div className="loading-progress-meta">
              <span className="loading-progress-text">{loadingProgress.statusText}</span>
              <span className="loading-progress-percent">{loadingProgress.percent}%</span>
            </div>
            <div className="loading-progress-bar">
              <div
                className={`loading-progress-fill ${loadingProgress.isBusy ? "busy" : ""}`}
                style={{ width: `${loadingProgress.percent}%` }}
              />
            </div>
            <div className="loading-stage-list">
              {loadingStages.map((stage) => (
                <span
                  key={stage.key}
                  className={`loading-stage-pill state-${stage.state}`}
                >
                  {stage.label}: {stage.state}
                </span>
              ))}
            </div>
          </div>
          <div className="data-status-panel">
            {dataLayerStatuses.length === 0 ? (
              <div className="data-status-item">No time-matched layers enabled.</div>
            ) : (
              dataLayerStatuses.map((status) => (
                <div
                  key={status.key}
                  className={`data-status-item ${status.state === "dropped" ? "dropped" : "matched"}`}
                >
                  <strong>{status.label}:</strong>{" "}
                  {status.state === "dropped" ? `Unavailable for selected time: ${status.detail}` : status.detail}
                </div>
              ))
            )}
          </div>
        </section>

        <aside className="sidebar">
          <div className="sidebar-content hazard-sidebar-content">
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
            <div className="sidebar-header hazard-sidebar-header">
              <h2>Active Hazards</h2>
              {hazardSummary?.fetched_at && (
                <p className="update-time">Updated: {formatDateTimeShort(hazardSummary.fetched_at, displayTimeZone)}</p>
              )}
            </div>
            {[
              {
                key: "convectiveWarnings" as HazardSectionId,
                title: "Active Convective Warnings",
                items: (hazardSummary?.current.warnings ?? []).filter((item) => item.kind === "tornado_warning" || item.kind === "severe_thunderstorm_warning"),
              },
              {
                key: "spcConvectiveWatches" as HazardSectionId,
                title: "Active SPC Convective Watches",
                items: hazardSummary?.current.watches ?? [],
              },
              {
                key: "spcMesoscaleDiscussions" as HazardSectionId,
                title: "Active SPC Mesoscale Discussions",
                items: (hazardSummary?.current.discussions ?? []).filter((item) => item.kind === "spc_md"),
              },
              {
                key: "wpcMesoscaleDiscussions" as HazardSectionId,
                title: "Active WPC Mesoscale Discussions",
                items: (hazardSummary?.current.discussions ?? []).filter((item) => item.kind === "wpc_mpd"),
              },
            ].map((section) => {
              const hasActive = section.items.length > 0;
              const isOpen = hazardSectionOpen[section.key];
              return (
                <section
                  key={section.key}
                  className={`hazard-section ${hasActive ? "has-active" : ""} ${isOpen ? "open" : "collapsed"}`}
                >
                  <button
                    type="button"
                    className="hazard-section-toggle"
                    onClick={() => setHazardSectionOpen((prev) => ({ ...prev, [section.key]: !prev[section.key] }))}
                    aria-expanded={isOpen}
                  >
                    <span className="hazard-section-title">{section.title}</span>
                    <span className="hazard-section-actions">
                      <span className={`hazard-count-pill ${hasActive ? "has-active" : ""}`}>{section.items.length}</span>
                      <span className="hazard-section-chevron">{isOpen ? "−" : "+"}</span>
                    </span>
                  </button>
                  {isOpen && (
                    section.items.length === 0 ? (
                      <div className="hazard-empty">No active products.</div>
                    ) : (
                      <ul className="hazard-list">
                        {section.items.map((item) => (
                          <li key={item.id} className="hazard-item">
                            {(() => {
                              const isWarning =
                                item.kind === "tornado_warning"
                                || item.kind === "severe_thunderstorm_warning"
                                || item.kind === "flash_flood_warning";
                              const hasCountyCoverage = isWarning && Array.isArray(item.coverage_counties) && item.coverage_counties.length > 0;
                              return (
                            <button type="button" className="hazard-item-main" onClick={() => zoomToHazard(item)}>
                              <div className="hazard-item-title">
                                {item.label}
                                {item.product_number ? ` ${item.product_number}` : ""}
                              </div>
                              <div className="hazard-item-times">
                                {formatDateTimeShort(item.issued_at, displayTimeZone)} to {formatDateTimeShort(item.ends_at, displayTimeZone)}
                              </div>
                              <div className="hazard-item-states">
                                {hasCountyCoverage ? formatCoverageCountiesCompact(item.coverage_counties) : formatStatesCompact(item.states)}
                              </div>
                            </button>
                              );
                            })()}
                            <button
                              type="button"
                              className="hazard-item-action"
                              onClick={() => setSelectedHazard(item)}
                              aria-label={`Open ${item.label}${item.product_number ? ` ${item.product_number}` : ""} text`}
                            >
                              Text
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  )}
                </section>
              );
            })}
          </div>
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
                            <td>{formatMrmsFreshnessNotes(opsSummary.freshness.mrms.rala)}</td>
                          </tr>
                          <tr>
                            <td>MRMS Composite</td>
                            <td>{opsSummary.freshness.mrms.composite.latest_time ? formatZulu(opsSummary.freshness.mrms.composite.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.composite.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.composite.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.composite.status.toUpperCase()}</td>
                            <td>{formatMrmsFreshnessNotes(opsSummary.freshness.mrms.composite)}</td>
                          </tr>
                          <tr>
                            <td>MRMS EchoTop 18</td>
                            <td>{opsSummary.freshness.mrms.etop18.latest_time ? formatZulu(opsSummary.freshness.mrms.etop18.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.etop18.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.etop18.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.etop18.status.toUpperCase()}</td>
                            <td>{formatMrmsFreshnessNotes(opsSummary.freshness.mrms.etop18)}</td>
                          </tr>
                          <tr>
                            <td>MRMS RotationTrack LL 240</td>
                            <td>{opsSummary.freshness.mrms.rotationll240.latest_time ? formatZulu(opsSummary.freshness.mrms.rotationll240.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.rotationll240.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.rotationll240.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.rotationll240.status.toUpperCase()}</td>
                            <td>{formatMrmsFreshnessNotes(opsSummary.freshness.mrms.rotationll240)}</td>
                          </tr>
                          <tr>
                            <td>MRMS RotationTrack ML 240</td>
                            <td>{opsSummary.freshness.mrms.rotationml240.latest_time ? formatZulu(opsSummary.freshness.mrms.rotationml240.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.rotationml240.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.rotationml240.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.rotationml240.status.toUpperCase()}</td>
                            <td>{formatMrmsFreshnessNotes(opsSummary.freshness.mrms.rotationml240)}</td>
                          </tr>
                          <tr>
                            <td>MRMS POSH</td>
                            <td>{opsSummary.freshness.mrms.posh.latest_time ? formatZulu(opsSummary.freshness.mrms.posh.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.posh.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.posh.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.posh.status.toUpperCase()}</td>
                            <td>{formatMrmsFreshnessNotes(opsSummary.freshness.mrms.posh)}</td>
                          </tr>
                          <tr>
                            <td>MRMS MESH 240min</td>
                            <td>{opsSummary.freshness.mrms.mesh240.latest_time ? formatZulu(opsSummary.freshness.mrms.mesh240.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.mrms.mesh240.latest_age_minutes == null ? "—" : `${opsSummary.freshness.mrms.mesh240.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.mrms.mesh240.status.toUpperCase()}</td>
                            <td>{formatMrmsFreshnessNotes(opsSummary.freshness.mrms.mesh240)}</td>
                          </tr>
                          <tr>
                            <td>GLM GOES-E CONUS FED</td>
                            <td>{opsSummary.freshness.glm.east_conus_fed.latest_time ? formatZulu(opsSummary.freshness.glm.east_conus_fed.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.glm.east_conus_fed.latest_age_minutes == null ? "—" : `${opsSummary.freshness.glm.east_conus_fed.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.glm.east_conus_fed.status.toUpperCase()}</td>
                            <td>{opsSummary.freshness.glm.east_conus_fed.available_count} frames</td>
                          </tr>
                          <tr>
                            <td>GLM GOES-W CONUS FED</td>
                            <td>{opsSummary.freshness.glm.west_conus_fed.latest_time ? formatZulu(opsSummary.freshness.glm.west_conus_fed.latest_time) : "—"}</td>
                            <td>{opsSummary.freshness.glm.west_conus_fed.latest_age_minutes == null ? "—" : `${opsSummary.freshness.glm.west_conus_fed.latest_age_minutes} min`}</td>
                            <td>{opsSummary.freshness.glm.west_conus_fed.status.toUpperCase()}</td>
                            <td>{opsSummary.freshness.glm.west_conus_fed.available_count} frames</td>
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

      {selectedHazard && (
        <div className="popup-overlay" onClick={() => setSelectedHazard(null)}>
          <div className="popup-content" onClick={(e) => e.stopPropagation()}>
            <div className="popup-header">
              <div>
                <h3>
                  {selectedHazard.label}
                  {selectedHazard.product_number ? ` ${selectedHazard.product_number}` : ""}
                </h3>
                <p>
                  {formatDateTimeShort(selectedHazard.issued_at, displayTimeZone)} to{" "}
                  {formatDateTimeShort(selectedHazard.ends_at, displayTimeZone)}
                </p>
              </div>
              <button className="popup-close" onClick={() => setSelectedHazard(null)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="popup-body">
              {(() => {
                const isWarning =
                  selectedHazard.kind === "tornado_warning"
                  || selectedHazard.kind === "severe_thunderstorm_warning"
                  || selectedHazard.kind === "flash_flood_warning";
                const hasCountyCoverage = isWarning && Array.isArray(selectedHazard.coverage_counties) && selectedHazard.coverage_counties.length > 0;
                return (
              <div className="detail-section">
                <div className="detail-section-title">Coverage</div>
                <div className="detail-row">
                  <span className="detail-label">{hasCountyCoverage ? "Counties:" : "States:"}</span>
                  <span className="detail-coverage-list">
                    {hasCountyCoverage ? formatCoverageCounties(selectedHazard.coverage_counties) : formatStatesCompact(selectedHazard.states)}
                  </span>
                </div>
              </div>
                );
              })()}
              {selectedHazard.summary && (
                <div className="detail-section">
                  <div className="detail-section-title">Summary</div>
                  <div>{selectedHazard.summary}</div>
                </div>
              )}
              {selectedHazard.discussion_text && (
                <div className="detail-section">
                  <div className="detail-section-title">Discussion Text</div>
                  <pre className="hazard-discussion-text">{selectedHazard.discussion_text}</pre>
                </div>
              )}
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
