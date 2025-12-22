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

function App() {
  const [obs, setObs] = useState<SurfaceObs[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewState, setViewState] = useState<Partial<ViewState>>({
    longitude: -97.6,
    latitude: 35.4,
    zoom: 6,
  });
  const zoom = viewState.zoom ?? 0;
  const plotDetail = useMemo(() => {
    if (zoom < 5.5) return "low";
    if (zoom < 7.5) return "medium";
    return "high";
  }, [zoom]);
  const [expandedStations, setExpandedStations] = useState<Set<string>>(new Set());
  const [selectedStation, setSelectedStation] = useState<SurfaceObs | null>(null);
  // Reference to the underlying MapLibre map instance
  const mapRef = useRef<MapRef | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
        return 0.50;
      case "sparse":
        return 3.0;
      case "medium":
      default:
        return 2.0;
    }
  }, [densityMode]);

  // Thin the stations by a pixel grid to reduce the number of points on the map
  const declutteredObs = useMemo(() => {
    const map = mapRef.current?.getMap();
    if (!map) return obs;
  
    const z = viewState.zoom ?? 0;
  
    // Base cell size by zoom (pixels). Bigger cells = fewer stations.
    const baseCell =
      z < 4 ? 30 :
      z < 6 ? 22 :
      z < 8 ? 15 :
      z < 10 ? 10 :
      0;
  
    if (baseCell === 0) return obs;
  
    // Apply user density selection
    const cell = Math.max(6, Math.round(baseCell * densityMultiplier));
  
    return thinByPixelGrid(obs, map, cell);
  }, [
    obs,
    densityMultiplier,
    viewState.longitude,
    viewState.latitude,
    viewState.zoom,
  ]);
  
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
    return {
      type: "FeatureCollection",
      features: declutteredObs.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: {
          id: s.id,
          flightRule: s.flightRule,
        },
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

  useEffect(() => {
    // Initial fetch
    fetchObservations();
    
    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchObservations, 300000);
    
    return () => clearInterval(interval);
  }, []);

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

  // Draw station plots on canvas overlay
  const drawStationPlots = useCallback(() => {
    // Only draw if in plots mode
    if (displayMode !== "plots") return;
    
    const canvas = canvasRef.current;
    const map = mapRef.current?.getMap();
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
  }, [declutteredObs, tempUnit, viewState, displayMode]);

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

  const setMode = (mode: MapRenderMode) => {
    setRenderMode(mode);
    localStorage.setItem("renderMode", mode);
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

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-content">
          <div>
            <h1>Wx Mesoanalysis</h1>
            <p>Prototype mesoanalysis dashboard (surface obs layer)</p>
          </div>
          <div className="header-controls">
          <div className="density-control">
            <div className="density-title">Obs Density</div>
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
            <div className="surface-obs-title">Surface Observations</div>
            <select
              className="surface-obs-select"
              value={displayMode}
              onChange={(e) => setSurfaceObsMode(e.target.value as DisplayMode)}
            >
              <option value="plots">Station Plots</option>
              <option value="dots">Colored Flight Rule</option>
            </select>
          </div>
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
        </div>
      </header>

      <main className="app-main">
        <section className="map-panel">
          <div className="map-container">
            {displayMode === "plots" && (
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
            <MapGL
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
              interactiveLayerIds={displayMode === "plots" ? ["hit-targets"] : ["unclustered"]}
              onClick={(e) => {
                const map = mapRef.current?.getMap();
                if (!map) return;

                const layers =
                  displayMode === "plots"
                    ? ["hit-targets"]
                    : ["unclustered"];

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
                {displayMode === "dots" && (
                  <Layer {...unclusteredLayer} key="dots-layer" />
                )}

                {displayMode === "plots" && (
                  <Layer {...hitTargetsLayer} key="hit-layer" />
                )}
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
                                <span>{s.pressureMb.toFixed(1)} mb</span>
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
                    <span>{selectedStation.pressureMb.toFixed(1)} mb</span>
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


