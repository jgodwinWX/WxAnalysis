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

function App() {
  const [obs, setObs] = useState<SurfaceObs[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewState, setViewState] = useState<ViewState>({
    longitude: -97.6,
    latitude: 35.4,
    zoom: 6,
  });
  const [expandedStations, setExpandedStations] = useState<Set<string>>(new Set());
  const [selectedStation, setSelectedStation] = useState<SurfaceObs | null>(null);
  // Reference to the underlying MapLibre map instance
  const mapRef = useRef<MapRef | null>(null);
  const obsById = useMemo(() => {
    const m = new Map<string, SurfaceObs>();
    for (const s of obs) m.set(s.id, s);
    return m;
  }, [obs]);

  // Thin the stations by a pixel grid to reduce the number of points on the map
  const declutteredObs = useMemo(() => {
    const map = mapRef.current?.getMap();
    if (!map) return obs;
  
    const z = viewState.zoom ?? 0;
  
    // Bigger cells = fewer stations. Tune these numbers to taste.
    const cell =
      z < 4 ? 30 :
      z < 6 ? 22 :
      z < 8 ? 15 :
      z < 10 ? 10 :
      0;
  
    if (cell === 0) return obs;
    return thinByPixelGrid(obs, map, cell);
  }, [obs, viewState.longitude, viewState.latitude, viewState.zoom]);

  // Cluster layer for areas with dense station clusters
  const clusterLayer: any = {
    id: "clusters",
    type: "circle",
    source: "stations",
    filter: ["has", "point_count"],
    paint: {
      "circle-opacity": 0.65,
      "circle-color": [
        "step",
        ["get", "point_count"],
        "#6b7280",   // small clusters
        50, "#4b5563",
        200, "#374151",
        1000, "#111827"
      ],
      "circle-radius": ["step", ["get", "point_count"], 16, 50, 20, 200, 26, 1000, 32],
    },
  };
  
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
            <button
              className={`control-btn ${colorCodeByFlightRule ? "active" : ""}`}
              onClick={toggleColorCodeByFlightRule}
              type="button"
              aria-label="Toggle flight rule color coding"
              title="Color code map labels by flight rule"
            >
              Flight Rules
            </button>
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
            <MapGL
              ref={mapRef}
              reuseMaps
              mapLib={maplibregl}
              {...viewState}
              onMove={(evt) => setViewState(evt.viewState)}
              minZoom={2}
              maxZoom={12}
              mapStyle={mapStyle}
              attributionControl={true}
              interactiveLayerIds={["unclustered"]}
              onClick={(e) => {
                const map = mapRef.current?.getMap();
                if (!map) return;

                const features = map.queryRenderedFeatures(e.point, {
                  layers: ["unclustered"],
                });

                const f = features?.[0];
                if (!f) return;

                const id = (f.properties as any)?.id as string | undefined;
                if (!id) return;

                const station = obsById.get(id);
                if (!station) return;

                // This should trigger your existing details panel / popup
                setSelectedStation(station);

                console.log("clicked station", id);
              }}
            >
              <NavigationControl position="top-left" />
              <Source
                id="stations"
                type="geojson"
                data={stationsGeoJson}
              >
                <Layer {...unclusteredLayer} />
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
              <h3>{selectedStation.name} ({selectedStation.id})</h3>
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


