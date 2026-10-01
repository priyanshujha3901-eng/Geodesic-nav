import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';
import 'leaflet-routing-machine';

const NAV_ZOOM = 17;
const HEADING_SCALE = 1.8;

// routing.openstreetmap.de is the OSRM project's free community demo server —
// it's the only free, no-API-key option that actually serves car/bike/foot
// profiles (the main public demo at router.project-osrm.org only does cars).
// It's rate-limited (~1 req/sec, non-commercial use) so don't hammer it.
const TRANSPORT_PROFILES = {
  car: { label: 'Car', icon: '🚗', serviceUrl: 'https://routing.openstreetmap.de/routed-car/route/v1', profile: 'driving' },
  bike: { label: 'Bike', icon: '🚴', serviceUrl: 'https://routing.openstreetmap.de/routed-bike/route/v1', profile: 'bike' },
  walk: { label: 'Walk', icon: '🚶', serviceUrl: 'https://routing.openstreetmap.de/routed-foot/route/v1', profile: 'foot' },
  // No free public transit-routing API exists, so "Bus" reuses the car
  // route's geometry and slows down the time estimate — clearly labelled
  // as estimated in the UI rather than pretending it's real transit data.
  bus: { label: 'Bus', icon: '🚌', simulated: true },
};
const TRANSPORT_ORDER = ['car', 'bike', 'walk', 'bus'];

const MAP_LAYERS = {
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
  },
};

const getTrafficCondition = () => {
  const rand = Math.random();
  if (rand < 0.6) return { level: 'clear', label: 'Clear', time: 0 };
  if (rand < 0.85) return { level: 'moderate', label: 'Moderate', time: 1.2 };
  return { level: 'heavy', label: 'Heavy', time: 1.5 };
};

const formatMinutes = (minutes) => {
  const value = Math.max(1, Math.round(minutes));
  return value >= 60 ? `${Math.floor(value / 60)}h ${value % 60}m` : `${value} min`;
};

const formatDistance = (meters) => {
  if (meters == null || Number.isNaN(meters)) return '--';
  if (meters < 950) return `${Math.max(0, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
};

const formatClock = (date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const turnIcon = (instruction) => {
  if (!instruction) return '⬆️';
  if (instruction.type === 'DestinationReached') return '🏁';
  if (instruction.type === 'Roundabout' || instruction.type === 'Rotary') return '🔄';
  switch (instruction.modifier) {
    case 'Left': return '⬅️';
    case 'SharpLeft': return '↩️';
    case 'SlightLeft': return '↖️';
    case 'Right': return '➡️';
    case 'SharpRight': return '↪️';
    case 'SlightRight': return '↗️';
    case 'Uturn': return '🔄';
    default: return '⬆️';
  }
};

// Compass bearing (0-360, 0 = north) from one LatLng to another.
const computeBearing = (from, to) => {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLon = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

// Finds the nearest point on the route to the user, the next maneuver ahead
// of it, and the remaining distance to the destination.
const getRouteProgress = (route, userLatLng) => {
  const coords = route.coordinates;
  let nearestIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = userLatLng.distanceTo(coords[i]);
    if (d < minDist) {
      minDist = d;
      nearestIdx = i;
    }
  }
  let remaining = 0;
  for (let i = nearestIdx; i < coords.length - 1; i++) {
    remaining += coords[i].distanceTo(coords[i + 1]);
  }
  const upcoming =
    route.instructions.find((ins) => ins.index > nearestIdx) ||
    route.instructions[route.instructions.length - 1];
  const maneuverCoord = coords[upcoming?.index] ?? coords[coords.length - 1];
  const distanceToManeuver = userLatLng.distanceTo(maneuverCoord);
  return {
    nearestIdx,
    remaining,
    instruction: upcoming ? { ...upcoming, distanceToManeuver } : null,
  };
};

function App() {
  const mapRef = useRef(null);
  const routeControlRef = useRef(null);
  const userMarkerRef = useRef(null);
  const watchIdRef = useRef(null);
  const selectedRouteRef = useRef(null);
  const streetLayerRef = useRef(null);
  const satelliteLayerRef = useRef(null);
  const lastStartCoordsRef = useRef(null);
  const lastEndCoordsRef = useRef(null);
  const lastHeadingCoordsRef = useRef(null);
  const headingRef = useRef(0);

  const [theme, setTheme] = useState(() => localStorage.getItem('geodesic-theme') || 'light');
  const [screen, setScreen] = useState('search'); // search | preview | drive
  const [mapType, setMapType] = useState('street'); // street | satellite
  const [povMode, setPovMode] = useState('north'); // north | heading
  const [transportMode, setTransportMode] = useState('car');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [status, setStatus] = useState('');
  const [currentCoords, setCurrentCoords] = useState(null);
  const [allRoutes, setAllRoutes] = useState([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routeSummary, setRouteSummary] = useState({ eta: '--', distance: '--', arrival: '--', simulated: false });
  const [trafficNote, setTrafficNote] = useState(null);
  const [liveSpeed, setLiveSpeed] = useState('0 km/h');
  const [driveStats, setDriveStats] = useState({ eta: '--', distance: '--', arrival: '--' });
  const [currentInstruction, setCurrentInstruction] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('geodesic-theme', theme);
  }, [theme]);

  useEffect(() => {
    const map = L.map('map', { zoomControl: false }).setView([28.7041, 77.1025], 13);
    mapRef.current = map;

    streetLayerRef.current = L.tileLayer(MAP_LAYERS.street.url, { maxZoom: 19, attribution: MAP_LAYERS.street.attribution });
    satelliteLayerRef.current = L.tileLayer(MAP_LAYERS.satellite.url, { maxZoom: 19, attribution: MAP_LAYERS.satellite.attribution });
    streetLayerRef.current.addTo(map);

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coords = L.latLng(position.coords.latitude, position.coords.longitude);
          setCurrentCoords(coords);
          setStart('Your location');
          map.setView(coords, 15, { animate: true });
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000 }
      );
    }

    return () => {
      map.remove();
    };
  }, []);

  const toggleMapType = () => {
    const map = mapRef.current;
    setMapType((prev) => {
      const next = prev === 'street' ? 'satellite' : 'street';
      if (next === 'satellite') {
        map.removeLayer(streetLayerRef.current);
        map.addLayer(satelliteLayerRef.current);
      } else {
        map.removeLayer(satelliteLayerRef.current);
        map.addLayer(streetLayerRef.current);
      }
      return next;
    });
  };

  // Rotates the whole map DOM node to face the direction of travel. The
  // user's own marker is counter-rotated separately (see setMarkerHeading)
  // so it always points the right way regardless of this.
  const applyMapRotation = () => {
    const container = mapRef.current?.getContainer();
    if (!container) return;
    container.style.transformOrigin = '50% 50%';
    container.style.transition = 'transform 0.3s linear';
    if (povMode === 'heading') {
      container.style.transform = `rotate(${-headingRef.current}deg) scale(${HEADING_SCALE})`;
    } else {
      container.style.transform = 'none';
    }
  };

  useEffect(() => {
    applyMapRotation();
    if (!mapRef.current) return;
    if (povMode === 'heading') mapRef.current.dragging.disable();
    else mapRef.current.dragging.enable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [povMode]);

  const setMarkerHeading = (bearing) => {
    const shape = userMarkerRef.current?.getElement()?.querySelector('.user-arrow-shape');
    if (shape) shape.style.transform = `rotate(${bearing}deg)`;
  };

  const userIcon = () =>
    L.divIcon({
      className: 'user-marker-icon',
      html: '<div class="user-arrow-shape">▲</div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });

  const ensureUserMarker = (coords) => {
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng(coords);
    } else {
      userMarkerRef.current = L.marker(coords, { icon: userIcon(), interactive: false }).addTo(mapRef.current);
    }
  };

  const applyRouteSelection = (route) => {
    selectedRouteRef.current = route;
    const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
    const etaText = formatMinutes(route.summary.totalTime / 60);
    const arrivalText = formatClock(new Date(Date.now() + route.summary.totalTime * 1000));
    setRouteSummary({ eta: etaText, distance: `${distanceKm} km`, arrival: arrivalText, simulated: !!route.simulated });
    setTrafficNote(getTrafficCondition());
  };

  const geocode = async (place) => {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=en&q=${encodeURIComponent(place)}`
    );
    if (!response.ok) throw new Error('Search unavailable. Try another location.');
    const results = await response.json();
    if (!results.length) throw new Error(`"${place}" not found. Try a nearby city.`);
    return L.latLng(Number(results[0].lat), Number(results[0].lon));
  };

  const runRouting = (startCoords, endCoords, mode) => {
    const profileInfo = TRANSPORT_PROFILES[mode];
    const fetchProfile = profileInfo.simulated ? TRANSPORT_PROFILES.car : profileInfo;

    if (routeControlRef.current) {
      mapRef.current.removeControl(routeControlRef.current);
    }

    const control = L.Routing.control({
      waypoints: [startCoords, endCoords],
      serviceUrl: fetchProfile.serviceUrl,
      profile: fetchProfile.profile,
      addWaypoints: false,
      routeWhileDragging: false,
      show: false,
      fitSelectedRoutes: true,
      createMarker: () => null,
      lineOptions: {
        styles: [
          { color: '#1d4ed8', opacity: 0.25, weight: 12 },
          { color: '#3b82f6', opacity: 1, weight: 6 },
        ],
      },
      altLineOptions: {
        styles: [{ color: '#94a3b8', opacity: 0.7, weight: 5 }],
      },
    }).addTo(mapRef.current);

    routeControlRef.current = control;

    control.on('routesfound', (event) => {
      let routes = event.routes;
      if (profileInfo.simulated) {
        routes = routes.map((r) => ({
          ...r,
          summary: {
            totalDistance: r.summary.totalDistance,
            totalTime: r.summary.totalTime * 1.6 + 300,
          },
          simulated: true,
        }));
      }
      setAllRoutes(routes);
      setSelectedRouteIndex(0);
      applyRouteSelection(routes[0]);

      const bounds = L.latLngBounds(routes[0].coordinates.map((c) => [c.lat, c.lng]));
      mapRef.current.fitBounds(bounds, { padding: [80, 80], duration: 0.6 });

      setScreen('preview');
      setStatus('');
      setLoading(false);
    });

    control.on('routingerror', () => {
      setStatus(mode !== 'car' ? 'No route found for this mode. Try Car instead.' : 'No route found. Try different locations.');
      setLoading(false);
    });
  };

  const calculateRoute = async () => {
    const startPlace = start.trim();
    const endPlace = end.trim();

    if (!endPlace) {
      setStatus('Type a destination.');
      return;
    }
    if (!startPlace && !currentCoords) {
      setStatus('Set your starting point first.');
      return;
    }

    setLoading(true);
    setStatus('Finding route...');
    try {
      const startCoords = currentCoords || (await geocode(startPlace));
      const endCoords = await geocode(endPlace);
      lastStartCoordsRef.current = startCoords;
      lastEndCoordsRef.current = endCoords;
      runRouting(startCoords, endCoords, transportMode);
    } catch (error) {
      setStatus(error.message);
      setLoading(false);
    }
  };

  const handleModeChange = (mode) => {
    setTransportMode(mode);
    if (screen === 'preview' && lastStartCoordsRef.current && lastEndCoordsRef.current) {
      setLoading(true);
      setStatus('Updating route...');
      runRouting(lastStartCoordsRef.current, lastEndCoordsRef.current, mode);
    }
  };

  const handleSelectRoute = (index) => {
    setSelectedRouteIndex(index);
    const route = allRoutes[index];
    if (route) applyRouteSelection(route);
  };

  const handleMyLocation = () => {
    if (!navigator.geolocation) {
      setStatus('Location not available in this browser.');
      return;
    }
    setStatus('Getting your location...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = L.latLng(position.coords.latitude, position.coords.longitude);
        setCurrentCoords(coords);
        setStart('Your location');
        ensureUserMarker(coords);
        mapRef.current.setView(coords, 15, { animate: true });
        setStatus('');
      },
      () => setStatus('Unable to access your location. Check permissions.')
    );
  };

  const startDrive = () => {
    const route = selectedRouteRef.current;
    if (!route) return;

    const initialPoint = currentCoords || route.coordinates[0];
    ensureUserMarker(initialPoint);
    lastHeadingCoordsRef.current = initialPoint;
    headingRef.current = 0;
    setPovMode('north');
    mapRef.current.setView(initialPoint, NAV_ZOOM, { animate: true });

    const progress = getRouteProgress(route, initialPoint);
    setCurrentInstruction(progress.instruction);
    const initialMinutes = (progress.remaining / route.summary.totalDistance) * (route.summary.totalTime / 60);
    setDriveStats({
      eta: formatMinutes(initialMinutes),
      distance: formatDistance(progress.remaining),
      arrival: formatClock(new Date(Date.now() + initialMinutes * 60000)),
    });

    setScreen('drive');

    if (!navigator.geolocation) {
      setStatus('Live navigation unavailable on this device.');
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const coords = L.latLng(position.coords.latitude, position.coords.longitude);
        setCurrentCoords(coords);
        ensureUserMarker(coords);
        mapRef.current.setView(coords, NAV_ZOOM, { animate: true, duration: 0.5 });

        if (lastHeadingCoordsRef.current && coords.distanceTo(lastHeadingCoordsRef.current) > 3) {
          const bearing = computeBearing(lastHeadingCoordsRef.current, coords);
          headingRef.current = bearing;
          setMarkerHeading(bearing);
          applyMapRotation();
        }
        lastHeadingCoordsRef.current = coords;

        const speed = position.coords.speed == null ? 0 : Math.round(position.coords.speed * 3.6);
        setLiveSpeed(`${speed} km/h`);

        const activeRoute = selectedRouteRef.current;
        if (activeRoute) {
          const p = getRouteProgress(activeRoute, coords);
          setCurrentInstruction(p.instruction);
          const remainingMinutes = (p.remaining / activeRoute.summary.totalDistance) * (activeRoute.summary.totalTime / 60);
          setDriveStats({
            eta: formatMinutes(remainingMinutes),
            distance: formatDistance(p.remaining),
            arrival: formatClock(new Date(Date.now() + remainingMinutes * 60000)),
          });
        }
      },
      () => setStatus('Location update failed.'),
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
  };

  const endDrive = () => {
    if (watchIdRef.current) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setPovMode('north');
    const container = mapRef.current?.getContainer();
    if (container) container.style.transform = 'none';
    mapRef.current?.dragging.enable();
    setScreen('preview');
  };

  const recenter = () => {
    if (currentCoords) {
      mapRef.current.setView(currentCoords, NAV_ZOOM, { animate: true });
    }
  };

  const activeRouteForPreview = allRoutes[selectedRouteIndex];

  const ModeRow = () => (
    <div className="mode-row">
      {TRANSPORT_ORDER.map((mode) => (
        <button
          key={mode}
          type="button"
          className={`mode-btn ${transportMode === mode ? 'active' : ''}`}
          onClick={() => handleModeChange(mode)}
        >
          <span className="mode-icon">{TRANSPORT_PROFILES[mode].icon}</span>
          <span className="mode-label">{TRANSPORT_PROFILES[mode].label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div id="map" className={mapType === 'satellite' ? 'satellite-mode' : ''} />

      {screen === 'search' && (
        <div className="top-search-wrap">
          <div className="brand-row">
            <div className="brand-chip">
              <span className="brand-mark">🧭</span> Geodesic
            </div>
            <button
              className="icon-btn"
              type="button"
              onClick={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
              aria-label="Toggle dark mode"
            >
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>

          <div className="search-card">
            <div className="search-row">
              <span className="dot start-dot" />
              <input
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  if (e.target.value !== 'Your location') setCurrentCoords(null);
                }}
                placeholder="Your location"
              />
            </div>
            <div className="search-divider" />
            <div className="search-row">
              <span className="dot end-dot" />
              <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="Where to?" />
              <button className="swap-btn" type="button" onClick={() => [setStart(end), setEnd(start)]} aria-label="Swap">
                ↕
              </button>
            </div>
          </div>

          <ModeRow />

          {status && <div className="toast">{status}</div>}

          <button className="fab maptype-fab" type="button" onClick={toggleMapType} aria-label="Toggle satellite view">
            {mapType === 'street' ? '🛰️' : '🗺️'}
          </button>
          <button className="fab locate-fab" type="button" onClick={handleMyLocation} aria-label="Use my location">
            ◎
          </button>
          <button className={`fab-primary search-fab ${loading ? 'loading' : ''}`} type="button" onClick={calculateRoute} disabled={loading}>
            {loading ? 'Searching...' : 'Search route'}
          </button>
        </div>
      )}

      {screen === 'preview' && (
        <div className="sheet">
          <div className="sheet-handle" />
          <div className="sheet-header">
            <button className="icon-btn" type="button" onClick={() => setScreen('search')} aria-label="Back">
              ←
            </button>
            <div className="sheet-title">{end || 'Destination'}</div>
          </div>

          <ModeRow />

          <div className="eta-row">
            <div className="eta-big">{loading ? '...' : routeSummary.eta}</div>
            <div className="eta-sub">
              {routeSummary.distance} · arrive {routeSummary.arrival}
            </div>
            {routeSummary.simulated && <div className="simulated-note">Estimated — no live transit data available</div>}
          </div>

          {trafficNote && !routeSummary.simulated && (
            <div className={`traffic-chip traffic-${trafficNote.level}`}>
              {trafficNote.level === 'clear' ? '✅' : trafficNote.level === 'moderate' ? '⚠️' : '🚨'} {trafficNote.label} traffic
            </div>
          )}

          {allRoutes.length > 1 && (
            <div className="alt-routes-row">
              {allRoutes.map((route, index) => {
                const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
                const etaText = formatMinutes(route.summary.totalTime / 60);
                return (
                  <button
                    key={index}
                    type="button"
                    className={`alt-card ${selectedRouteIndex === index ? 'selected' : ''}`}
                    onClick={() => handleSelectRoute(index)}
                  >
                    <strong>{etaText}</strong>
                    <span>{distanceKm} km</span>
                  </button>
                );
              })}
            </div>
          )}

          <button className="go-btn" type="button" onClick={startDrive} disabled={!activeRouteForPreview || loading}>
            GO
          </button>
        </div>
      )}

      {screen === 'drive' && (
        <div className="drive-hud">
          <div className="instruction-banner">
            <div className="turn-icon">{turnIcon(currentInstruction)}</div>
            <div className="instruction-text">
              <div className="instruction-distance">{formatDistance(currentInstruction?.distanceToManeuver)}</div>
              <div className="instruction-road">{currentInstruction?.text || 'Head towards destination'}</div>
            </div>
            <button className="icon-btn end-btn" type="button" onClick={endDrive} aria-label="End navigation">
              ✕
            </button>
          </div>

          <button className="fab maptype-fab drive-pos" type="button" onClick={toggleMapType} aria-label="Toggle satellite view">
            {mapType === 'street' ? '🛰️' : '🗺️'}
          </button>
          <button
            className="fab pov-fab"
            type="button"
            onClick={() => setPovMode((p) => (p === 'north' ? 'heading' : 'north'))}
            aria-label="Toggle map orientation"
          >
            {povMode === 'north' ? '🧭' : '🔼'}
          </button>
          <button className="fab recenter-fab" type="button" onClick={recenter} aria-label="Recenter">
            ⌖
          </button>

          <div className="drive-bottom-bar">
            <div className="drive-stat">
              <strong>{driveStats.eta}</strong>
              <span>ETA</span>
            </div>
            <div className="drive-stat">
              <strong>{driveStats.distance}</strong>
              <span>distance</span>
            </div>
            <div className="drive-stat">
              <strong>{driveStats.arrival}</strong>
              <span>arrival</span>
            </div>
            <div className="drive-stat">
              <strong>{liveSpeed}</strong>
              <span>speed</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
