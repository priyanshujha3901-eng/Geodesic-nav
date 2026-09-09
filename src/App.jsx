import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';
import 'leaflet-routing-machine';

const getTrafficCondition = () => {
  const rand = Math.random();
  if (rand < 0.6) return { level: 'clear', label: 'Clear roads', time: 0 };
  if (rand < 0.85) return { level: 'moderate', label: 'Some traffic', time: 1.2 };
  return { level: 'heavy', label: 'Heavy traffic', time: 1.5 };
};

const formatMinutes = (minutes) => {
  const value = Math.max(1, Math.round(minutes));
  return value >= 60 ? `${Math.floor(value / 60)}h ${value % 60}m` : `${value} min`;
};

const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

function App() {
  const mapRef = useRef(null);
  const baseLayerRef = useRef(null);
  const routeControlRef = useRef(null);
  const userMarkerRef = useRef(null);
  const watchIdRef = useRef(null);
  const lastPositionRef = useRef(null);

  // ---- persistent preferences ----
  const [theme, setTheme] = useState(() => localStorage.getItem('geodesic-theme') || 'light');
  const [tileMode, setTileMode] = useState('map'); // 'map' | 'satellite'

  // ---- app mode: the big split from the brief ----
  const [appMode, setAppMode] = useState('explore'); // 'explore' | 'drive'
  const [sheetExpanded, setSheetExpanded] = useState(true);

  // ---- trip planning state ----
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [status, setStatus] = useState('Search a destination to begin');
  const [currentCoords, setCurrentCoords] = useState(null);
  const [destCoords, setDestCoords] = useState(null);
  const [allRoutes, setAllRoutes] = useState([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routeSummary, setRouteSummary] = useState({ eta: '--', distance: '--' });
  const [trafficNote, setTrafficNote] = useState(null);
  const [loading, setLoading] = useState(false);

  // ---- live drive state ----
  const [liveSpeed, setLiveSpeed] = useState(0);

  const hasRoute = allRoutes.length > 0;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('geodesic-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.appmode = appMode;
  }, [appMode]);

  // ---- map bootstrap ----
  useEffect(() => {
    const map = L.map('map', { zoomControl: false }).setView([28.7041, 77.1025], 13);
    mapRef.current = map;

    baseLayerRef.current = L.tileLayer(OSM_TILES, {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    return () => map.remove();
  }, []);

  // ---- swap between street map and satellite ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !baseLayerRef.current) return;
    map.removeLayer(baseLayerRef.current);
    baseLayerRef.current = tileMode === 'satellite'
      ? L.tileLayer(SAT_TILES, { maxZoom: 19, attribution: 'Tiles &copy; Esri' })
      : L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
    baseLayerRef.current.addTo(map);
  }, [tileMode]);

  const placeUserMarker = (coords) => {
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng(coords);
    } else {
      userMarkerRef.current = L.circleMarker(coords, {
        radius: 9,
        color: '#0f6b5c',
        fillColor: '#1c8a76',
        fillOpacity: 1,
        weight: 3,
        className: 'user-marker-pulse',
      }).addTo(mapRef.current);
    }
  };

  const applyRoute = (route) => {
    const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
    const etaText = formatMinutes(route.summary.totalTime / 60);
    const traffic = getTrafficCondition();
    setRouteSummary({ eta: etaText, distance: `${distanceKm} km` });
    setTrafficNote(traffic);
  };

  const geocode = async (place) => {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=en&q=${encodeURIComponent(place)}`
    );
    if (!response.ok) throw new Error('Search is unavailable right now. Try again.');
    const results = await response.json();
    if (!results.length) throw new Error(`Couldn't find "${place}". Try a nearby landmark.`);
    return L.latLng(Number(results[0].lat), Number(results[0].lon));
  };

  const searchRoute = async () => {
    const startPlace = start.trim();
    const endPlace = end.trim();
    if (!startPlace || !endPlace) {
      setStatus('Enter both a starting point and a destination.');
      return;
    }

    setLoading(true);
    setStatus('Finding the best route...');
    try {
      const startCoords = currentCoords || (await geocode(startPlace));
      const endCoords = await geocode(endPlace);
      setDestCoords(endCoords);

      if (routeControlRef.current) mapRef.current.removeControl(routeControlRef.current);

      const control = L.Routing.control({
        waypoints: [startCoords, endCoords],
        addWaypoints: false,
        routeWhileDragging: false,
        show: false,
        fitSelectedRoutes: true,
        createMarker: () => null,
        lineOptions: { styles: [{ color: '#0f6b5c', opacity: 0.95, weight: 6 }] },
        altLineOptions: { styles: [{ color: '#b9c2bd', opacity: 0.7, weight: 4, dashArray: '2, 10' }] },
      }).addTo(mapRef.current);

      routeControlRef.current = control;

      control.on('routesfound', (event) => {
        const routes = event.routes;
        setAllRoutes(routes);
        setSelectedRouteIndex(0);
        applyRoute(routes[0]);
        setSheetExpanded(true);
        setStatus('Route ready.');
        setLoading(false);
      });

      control.on('routingerror', () => {
        setStatus("Couldn't connect these two points. Try different places.");
        setLoading(false);
      });
    } catch (error) {
      setStatus(error.message);
      setLoading(false);
    }
  };

  const selectRoute = (index) => {
    setSelectedRouteIndex(index);
    if (allRoutes[index]) applyRoute(allRoutes[index]);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setStatus('This browser cannot access your location.');
      return;
    }
    setStatus('Locating you...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = L.latLng(position.coords.latitude, position.coords.longitude);
        setCurrentCoords(coords);
        setStart('My location');
        placeUserMarker(coords);
        mapRef.current.panTo(coords, { animate: true, duration: 0.6 });
        setStatus('Location set as your start point.');
      },
      () => setStatus('Could not access your location. Check permissions.')
    );
  };

  const startDrive = () => {
    if (!hasRoute) return;
    if (!navigator.geolocation) {
      setStatus('Live drive needs location access, which this browser blocks.');
      return;
    }
    setAppMode('drive');
    setSheetExpanded(false);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const coords = L.latLng(position.coords.latitude, position.coords.longitude);
        if (lastPositionRef.current && coords.distanceTo(lastPositionRef.current) < 4) return;
        lastPositionRef.current = coords;
        setCurrentCoords(coords);
        placeUserMarker(coords);
        mapRef.current.panTo(coords, { animate: true, duration: 0.5 });
        const speed = position.coords.speed == null ? 0 : Math.round(position.coords.speed * 3.6);
        setLiveSpeed(speed);
      },
      () => setStatus('Lost your GPS signal.'),
      { enableHighAccuracy: true, maximumAge: 3000 }
    );
  };

  const endDrive = () => {
    if (watchIdRef.current) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setAppMode('explore');
    setSheetExpanded(true);
    setStatus('Drive ended.');
  };

  const recenter = () => {
    if (currentCoords) mapRef.current.panTo(currentCoords, { animate: true, duration: 0.5 });
  };

  return (
    <>
      <div id="map" />

      {/* floating overlay controls above the map */}
      <div className="map-overlay">
        <button
          className="round-btn"
          type="button"
          onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          aria-label="Toggle dark mode"
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>

        <div className="mode-switch" role="tablist" aria-label="App mode">
          <button
            role="tab"
            aria-selected={appMode === 'explore'}
            className={appMode === 'explore' ? 'active' : ''}
            type="button"
            onClick={endDrive}
          >
            Explore
          </button>
          <button
            role="tab"
            aria-selected={appMode === 'drive'}
            className={`${appMode === 'drive' ? 'active' : ''} ${!hasRoute ? 'locked' : ''}`}
            type="button"
            disabled={!hasRoute}
            onClick={startDrive}
          >
            Drive
          </button>
        </div>

        <button
          className="round-btn"
          type="button"
          onClick={() => setTileMode((m) => (m === 'map' ? 'satellite' : 'map'))}
          aria-label="Toggle satellite view"
        >
          {tileMode === 'map' ? '🛰️' : '🗺️'}
        </button>
      </div>

      {appMode === 'explore' && (
        <button className="locate-fab" type="button" onClick={useMyLocation} aria-label="Use my location">
          ◎
        </button>
      )}

      {appMode === 'drive' && (
        <>
          <div className="drive-hud-top">
            <span className="drive-hud-eyebrow">Heading to</span>
            <strong className="drive-hud-destination">{end || 'destination'}</strong>
          </div>
          <button className="locate-fab drive" type="button" onClick={recenter} aria-label="Recenter map">
            ◎
          </button>
        </>
      )}

      {/* ================= EXPLORE SHEET ================= */}
      {appMode === 'explore' && (
        <section className={`sheet ${sheetExpanded ? 'expanded' : 'peek'}`}>
          <button
            className="sheet-handle"
            type="button"
            onClick={() => setSheetExpanded((v) => !v)}
            aria-label={sheetExpanded ? 'Collapse panel' : 'Expand panel'}
          >
            <span className="handle-bar" />
          </button>

          <div className="sheet-body">
            <div className="sheet-brand">
              <span className="sheet-brand-mark">🧭</span>
              <span className="sheet-brand-name">Geodesic</span>
            </div>

            {!hasRoute && (
              <div className="search-block">
                <div className="field-stack">
                  <div className="field-row">
                    <span className="dot start" />
                    <input
                      value={start}
                      onFocus={() => setSheetExpanded(true)}
                      onChange={(e) => {
                        setStart(e.target.value);
                        if (e.target.value !== 'My location') setCurrentCoords(null);
                      }}
                      placeholder="Starting point"
                    />
                  </div>
                  <div className="field-row">
                    <span className="dot end" />
                    <input
                      value={end}
                      onFocus={() => setSheetExpanded(true)}
                      onChange={(e) => setEnd(e.target.value)}
                      placeholder="Where are you going?"
                    />
                  </div>
                  <button
                    className="swap-btn"
                    type="button"
                    onClick={() => { setStart(end); setEnd(start); }}
                    aria-label="Swap start and destination"
                  >
                    ⇅
                  </button>
                </div>

                <div className="action-row">
                  <button className={`primary-btn ${loading ? 'busy' : ''}`} type="button" onClick={searchRoute} disabled={loading}>
                    {loading ? 'Searching…' : 'Find route'}
                  </button>
                  <button className="ghost-btn" type="button" onClick={useMyLocation}>
                    My location
                  </button>
                </div>

                <p className="status-line">{status}</p>
              </div>
            )}

            {hasRoute && (
              <div className="route-block">
                <div className="route-headline">
                  <div>
                    <span className="eyebrow">To</span>
                    <strong>{end}</strong>
                  </div>
                  <button className="ghost-btn small" type="button" onClick={() => { setAllRoutes([]); setStatus('Search a destination to begin'); }}>
                    Edit
                  </button>
                </div>

                <div className="stat-strip">
                  <div>
                    <span className="stat-value">{routeSummary.eta}</span>
                    <span className="stat-label">Arrival time</span>
                  </div>
                  <div>
                    <span className="stat-value">{routeSummary.distance}</span>
                    <span className="stat-label">Distance</span>
                  </div>
                </div>

                {trafficNote && (
                  <div className={`traffic-pill ${trafficNote.level}`}>
                    {trafficNote.level === 'clear' ? '●' : trafficNote.level === 'moderate' ? '▲' : '■'} {trafficNote.label}
                  </div>
                )}

                {allRoutes.length > 1 && (
                  <div className="route-alt-list">
                    {allRoutes.map((route, index) => {
                      const distance = (route.summary.totalDistance / 1000).toFixed(1);
                      const time = formatMinutes(route.summary.totalTime / 60);
                      return (
                        <button
                          key={index}
                          type="button"
                          className={`route-alt ${selectedRouteIndex === index ? 'selected' : ''}`}
                          onClick={() => selectRoute(index)}
                        >
                          <span>Route {index + 1}</span>
                          <span className="route-alt-meta">{time} · {distance} km</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <button className="primary-btn drive-cta" type="button" onClick={startDrive}>
                  Start drive
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ================= DRIVE HUD BOTTOM ================= */}
      {appMode === 'drive' && (
        <section className="drive-hud-bottom">
          <div className="drive-stat">
            <span className="drive-stat-value">{liveSpeed}</span>
            <span className="drive-stat-label">km/h</span>
          </div>
          <div className="drive-stat divider">
            <span className="drive-stat-value">{routeSummary.eta}</span>
            <span className="drive-stat-label">eta</span>
          </div>
          <div className="drive-stat">
            <span className="drive-stat-value">{routeSummary.distance}</span>
            <span className="drive-stat-label">route</span>
          </div>
          <button className="end-drive-btn" type="button" onClick={endDrive}>
            End
          </button>
        </section>
      )}
    </>
  );
}

export default App;
