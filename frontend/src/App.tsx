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
};

type TempUnit = "F" | "C";

function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
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

// Format the sky conditions as "CLR///" or "SCT015"
function formatSky(sky: SkyCondition[]) {
  return sky
    .map(l => `${l.cover}${l.level_ft !== null ? String(Math.round(l.level_ft / 100)).padStart(3,"0") : "///"}`)
    .join(" ");
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

function App() {
  const [obs, setObs] = useState<SurfaceObs[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewState, setViewState] = useState<ViewState>({
    longitude: -97.6,
    latitude: 35.4,
    zoom: 6,
    bearing: 0,
    pitch: 0,
    padding: { top: 0, left: 0, bottom: 0, right: 0 },
  });
  type TimelineMode = "live" | "history";

  const [timelineMode, setTimelineMode] = useState<TimelineMode>("live");
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
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analysisLabelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
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
  type DisplayMode = "plots" | "dots";

  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    const saved = localStorage.getItem("displayMode");
    return saved === "dots" || saved === "plots" ? (saved as DisplayMode) : "plots";
  });
  
  const setSurfaceObsMode = (mode: DisplayMode) => {
    setDisplayMode(mode);
    localStorage.setItem("displayMode", mode);
  };

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
    const list = declutteredObs ?? [];
    return {
      type: "FeatureCollection",
      features: list.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { id: s.id, flightRule: s.flightRule },
      })),
    } as any;
  }, [declutteredObs]);
  
  // Load temperature unit preference from localStorage, default to Fahrenheit
  const [tempUnit, setTempUnit] = useState<TempUnit>(() => {
    const saved = localStorage.getItem("tempUnit");
    return (saved === "C" || saved === "F" ? saved : "F") as TempUnit;
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

  const fetchAvailableTimes = useCallback(async (minutes = 360) => {
    try {
      const res = await fetch(`/api/obs/times?minutes=${minutes}`);
      const data = await res.json();
      const times: string[] = Array.isArray(data.times) ? data.times : [];
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

  const [showStations, setShowStations] = useState<boolean>(() => {
    const saved = localStorage.getItem("showStations");
    return saved === null ? true : saved === "true";
  });

  useEffect(() => {
    // LIVE MODE: keep your current polling behavior
    if (timelineMode === "live") {
      fetchObservations();
      const interval = setInterval(fetchObservations, 300000);
      return () => clearInterval(interval);
    }
  
    // HISTORY MODE: load list of times once (and occasionally refresh list)
    fetchAvailableTimes(360);
    const interval = setInterval(() => fetchAvailableTimes(360), 300000);
    return () => clearInterval(interval);
  }, [timelineMode, fetchAvailableTimes]);

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
    // Only draw if in plots mode
    if (!showStations) return;
    if (displayMode !== "plots") return;
    
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
  }, [declutteredObs, tempUnit, viewState, displayMode, showStations]);

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
    const newMode: DisplayMode = displayMode === "dots" ? "plots" : "dots";
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

  type AnalysisOverlay = "temp" | "dewpoint" | "slp" | "wind";
  type AnalysisOverlaySet = Record<AnalysisOverlay, boolean>;
  
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
    return { temp: true, dewpoint: false, slp: false, wind: false };
  });
  
  const anyOverlayOn =
  analysisOverlays.temp || analysisOverlays.dewpoint || analysisOverlays.slp || analysisOverlays.wind;

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

type LabelMode = "temp" | "dewpoint" | "slp";
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
  if (!anyOverlayOn) return;

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
  if (!stations || stations.length === 0) return;

  // Performance knobs (contours are heavier than shading)
  const step = 24;          // grid spacing in pixels; 20–32 is typical
  const power = 2;
  const maxRadius = 200;    // px search radius
  const maxRadius2 = maxRadius * maxRadius;
  const kMax = 10;
  const windStep = 42;

  function drawWind() {
    const pts: Array<{ x: number; y: number; u: number; v: number }> = [];
  
    for (const s of declutteredObs) {
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

  function drawOne(mode: AnalysisOverlay) {
    // Build pts for THIS field
    const pts: Array<{ x: number; y: number; val: number }> = [];
    for (const s of declutteredObs) {
      const p = map.project([s.lon, s.lat]);
  
      if (mode === "temp") {
        if (s.tempC == null) continue;
        const val = tempUnit === "F" ? celsiusToFahrenheit(s.tempC) : s.tempC;
        pts.push({ x: p.x, y: p.y, val });
      } else if (mode === "dewpoint") {
        if (s.dewpointC == null) continue;
        const val = tempUnit === "F" ? celsiusToFahrenheit(s.dewpointC) : s.dewpointC;
        pts.push({ x: p.x, y: p.y, val });
      } else if (mode === "slp") {
        if (s.pressureMb == null) continue;
        pts.push({ x: p.x, y: p.y, val: s.pressureMb });
      } else if (mode === "wind") {
        if (s.windDirDeg == null || s.windSpeedKt == null) continue;
        const { u, v } = windToUV(s.windDirDeg, s.windSpeedKt);
        // store both components in val via two arrays (see below)
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
      } else {
        strokeIsobars(ctx, segments, level);
        labelContours(ctx, segments, level, "slp", { tempUnit });
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

    // draw order: pressure under, dewpoint, then temp on top
    if (analysisOverlays.slp) drawOne("slp");
    if (analysisOverlays.dewpoint) drawOne("dewpoint");
    if (analysisOverlays.temp) drawOne("temp");
    if (analysisOverlays.wind) drawWind();
  
    ctx.globalAlpha = 1;
  }, [analysisOverlays, declutteredObs, tempUnit, anyOverlayOn, windRenderMode]);

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

  // Download
  const dataUrl = out.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `wx-mesoanalysis_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  a.click();
}, [showStations, displayMode]);

useEffect(() => {
  localStorage.setItem("showStations", String(showStations));
}, [showStations]);

useEffect(() => {
  if (!mapLoaded) return;
  if (!anyOverlayOn) return;
  drawAnalysisOverlay();
}, [mapLoaded, anyOverlayOn, drawAnalysisOverlay]);

useEffect(() => {
  localStorage.setItem("analysisOverlays", JSON.stringify(analysisOverlays));
}, [analysisOverlays]);

useEffect(() => {
  if (!mapLoaded) return;
  if (!showStations) return;
  if (displayMode !== "plots") return;

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
    if (anyOverlayOn) drawAnalysisOverlay();

    // station plots
    if (showStations && displayMode === "plots") drawStationPlots();

    // helps when toggling layers / mode quickly
    mapRef.current?.getMap()?.triggerRepaint?.();
  });

  return () => cancelAnimationFrame(raf);
}, [
  mapLoaded,
  obs,                 // redraw when the frame changes
  anyOverlayOn,
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
            <div className="density-control">
              <div className="density-title">Obs Density</div>
                <div className="stations-toggle">
                  <label>
                    <input
                      type="checkbox"
                      checked={showStations}
                      onChange={(e) => setShowStations(e.target.checked)}
                    />
                    Show stations
                  </label>
                </div>
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
            <div className="surface-obs-control">
              <div className="surface-obs-title">SFC OBSERVATIONS</div>
              <select
                className="surface-obs-select"
                value={displayMode}
                onChange={(e) => setSurfaceObsMode(e.target.value as DisplayMode)}
                disabled={!showStations}
              >
                <option value="plots">Station Plots</option>
                <option value="dots">Colored Flight Rule</option>
              </select>
            </div>
            <div className="analysis-control">
              <div className="analysis-title">Objective Analysis</div>
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
                {analysisOverlays.wind && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }}>Wind Render</span>
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
                )}
            </div>
            <div className="time-control">
              <div className="time-title">TIME</div>

              <div className="time-row">
                <label className="time-mode">
                  <input
                    type="radio"
                    name="timelineMode"
                    checked={timelineMode === "live"}
                    onChange={() => { setTimelineMode("live"); setIsPlaying(false); }}
                  />
                  Live
                </label>
                <label className="time-mode">
                  <input
                    type="radio"
                    name="timelineMode"
                    checked={timelineMode === "history"}
                    onChange={() => setTimelineMode("history")}
                  />
                  History
                </label>
              </div>

              {timelineMode === "history" && (
                <>
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
                </>
              )}
            </div>
            <div className="header-actions">
              <div className="options-title">OPTIONS</div>
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
                <button type="button" onClick={exportPng} className="export-btn">
                    Download View as PNG
                </button>
            </div>
          </div>

      <main className="app-main">
        <section className="map-panel">
          <div className="map-container">
            {anyOverlayOn && (
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

            {showStations && displayMode === "plots" && (
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

            {anyOverlayOn && (
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
                  ? (displayMode === "plots" ? ["hit-targets"] : ["unclustered"])
                  : []
              }
              onClick={(e) => {
                if (!showStations) return;
                const map = mapRef.current?.getMap();
                if (!map) return;

                const layers = displayMode === "plots" ? ["hit-targets"] : ["unclustered"];
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
              <Source id="stations" type="geojson" data={stationsGeoJson}>
                {displayMode === "dots" && <Layer {...unclusteredLayer} key="dots-layer" />}
                {displayMode === "plots" && <Layer {...hitTargetsLayer} key="hit-layer" />}
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
          </div>
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
                          {s.windSpeedKt !== null && (
                            <span className="wind-info">
                              {" "}
                              {s.windDirDeg !== null
                                ? `${Math.round(s.windDirDeg)}°`
                                : ""}{" "}
                              {s.windSpeedKt.toFixed(0)}kt
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
                                  <span>{s.windSpeedKt.toFixed(1)} kt</span>
                                </div>
                                {s.windGustKt !== null && (
                                  <div className="detail-row">
                                    <span className="detail-label">Wind Gust:</span>
                                    <span>{s.windGustKt.toFixed(1)} kt</span>
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
              </div>
              <button className="popup-close" onClick={closePopup} aria-label="Close">
                ×
              </button>
            </div>
            <div className="popup-body">
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
                      <span>{selectedStation.windSpeedKt.toFixed(1)} kt</span>
                    </div>
                    {selectedStation.windGustKt !== null && (
                      <div className="detail-row">
                        <span className="detail-label">Wind Gust:</span>
                        <span>{selectedStation.windGustKt.toFixed(1)} kt</span>
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


