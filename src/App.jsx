import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';
import 'leaflet-routing-machine';

// Zoom level used while actively driving — this is what makes roads
// actually visible instead of the whole-route overview zoom.
const NAV_ZOOM = 17;
const LIVE_LOCATION_MIN_DISTANCE = 20;
const LIVE_LOCATION_MAX_ACCURACY = 35;

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

// Finds the point on the route nearest to the user, the next maneuver ahead
// of that point, and how much distance is left to the destination.
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
  const lastLiveLocationRef = useRef(null);

  const [theme, setTheme] = useState(() => localStorage.getItem('geodesic-theme') || 'light');
  const [screen, setScreen] = useState('search'); // search | preview | drive
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [status, setStatus] = useState('');
  const [currentCoords, setCurrentCoords] = useState(null);
  const [allRoutes, setAllRoutes] = useState([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routeSummary, setRouteSummary] = useState({ eta: '--', distance: '--', arrival: '--' });
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

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    // Try to center on the user right away, like Waze does on launch.
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coords = L.latLng(position.coords.latitude, position.coords.longitude);
          setCurrentCoords(coords);
          setStart('Your location');
          ensureUserMarker(coords);
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

  const ensureUserMarker = (coords) => {
    if (!coords || !mapRef.current) return;

    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng(coords);
    } else {
      userMarkerRef.current = L.circleMarker(coords, {
        radius: 9,
        color: '#1d4ed8',
        fillColor: '#3b82f6',
        fillOpacity: 1,
        weight: 3,
        className: 'user-marker-pulse',
      }).addTo(mapRef.current);
    }
  };

  const syncLiveUserPosition = (coords, zoom = null) => {
    if (!coords) return;

    ensureUserMarker(coords);

    if (!mapRef.current) return;

    if (zoom != null) {
      mapRef.current.setView(coords, zoom, { animate: true, duration: 0.5 });
    } else {
      mapRef.current.panTo(coords, { animate: true, duration: 0.5 });
    }
  };

  const shouldUpdateLiveLocation = (coords, accuracyMeters = 25) => {
    if (!coords) return false;
    if (!lastLiveLocationRef.current) {
      lastLiveLocationRef.current = coords;
      return true;
    }

    const movedMeters = coords.distanceTo(lastLiveLocationRef.current);
    if (accuracyMeters > LIVE_LOCATION_MAX_ACCURACY) return false;
    if (movedMeters < LIVE_LOCATION_MIN_DISTANCE) return false;

    lastLiveLocationRef.current = coords;
    return true;
  };

  const applyRouteSelection = (route) => {
    selectedRouteRef.current = route;
    const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
    const etaText = formatMinutes(route.summary.totalTime / 60);
    const arrivalText = formatClock(new Date(Date.now() + route.summary.totalTime * 1000));
    setRouteSummary({ eta: etaText, distance: `${distanceKm} km`, arrival: arrivalText });
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

      if (routeControlRef.current) {
        mapRef.current.removeControl(routeControlRef.current);
      }

      const control = L.Routing.control({
        waypoints: [startCoords, endCoords],
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
        const routes = event.routes;
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
        setStatus('No route found. Try different locations.');
        setLoading(false);
      });
    } catch (error) {
      setStatus(error.message);
      setLoading(false);
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
        lastLiveLocationRef.current = coords;
        syncLiveUserPosition(coords, 15);
        setStatus('');
      },
      () => setStatus('Unable to access your location. Check permissions.')
    );
  };

  const startDrive = () => {
    const route = selectedRouteRef.current;
    if (!route) return;

    const initialPoint = currentCoords || route.coordinates[0];
    lastLiveLocationRef.current = initialPoint;
    syncLiveUserPosition(initialPoint, NAV_ZOOM);

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
        const accuracyMeters = position.coords.accuracy ?? 25;
        const speed = position.coords.speed == null ? 0 : Math.round(position.coords.speed * 3.6);
        setLiveSpeed(`${speed} km/h`);

        if (accuracyMeters > LIVE_LOCATION_MAX_ACCURACY) {
          return;
        }

        setCurrentCoords(coords);

        if (shouldUpdateLiveLocation(coords, accuracyMeters)) {
          syncLiveUserPosition(coords, NAV_ZOOM);
        }

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
    lastLiveLocationRef.current = null;
    setScreen('preview');
  };

  const recenter = () => {
    if (currentCoords) {
      mapRef.current.setView(currentCoords, NAV_ZOOM, { animate: true });
    }
  };

  return (
    <>
      <div id="map" />

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

          {status && <div className="toast">{status}</div>}

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

          <div className="eta-row">
            <div className="eta-big">{routeSummary.eta}</div>
            <div className="eta-sub">
              {routeSummary.distance} · arrive {routeSummary.arrival}
            </div>
          </div>

          {trafficNote && (
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

          <button className="go-btn" type="button" onClick={startDrive}>
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
