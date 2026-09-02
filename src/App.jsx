import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';
import 'leaflet-routing-machine';

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

function App() {
  const mapRef = useRef(null);
  const routeControlRef = useRef(null);
  const userMarkerRef = useRef(null);
  const watchIdRef = useRef(null);
  const lastPositionRef = useRef(null);

  const [theme, setTheme] = useState(() => localStorage.getItem('geodesic-theme') || 'light');
  const [screen, setScreen] = useState('search');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [status, setStatus] = useState('Find your next destination');
  const [currentCoords, setCurrentCoords] = useState(null);
  const [allRoutes, setAllRoutes] = useState([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routeSummary, setRouteSummary] = useState({ eta: '--', distance: '--' });
  const [routeDetails, setRouteDetails] = useState({
    distance: '-- km',
    time: '--',
    traffic: 'Normal',
    stops: '2',
  });
  const [trafficNote, setTrafficNote] = useState('');
  const [liveSpeed, setLiveSpeed] = useState('0 km/h');
  const [liveEta, setLiveEta] = useState('--');
  const [traveling, setTraveling] = useState(false);
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

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    return () => {
      map.remove();
    };
  }, []);

  const setRouteData = (route) => {
    const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
    const etaText = formatMinutes(route.summary.totalTime / 60);
    const traffic = getTrafficCondition();
    setRouteSummary({ eta: etaText, distance: `${distanceKm} km` });
    setRouteDetails({
      distance: `${distanceKm} km`,
      time: etaText,
      traffic: traffic.label,
      stops: String(route.waypoints?.length ?? 2),
    });
    setTrafficNote(`${traffic.level === 'clear' ? '✅' : traffic.level === 'moderate' ? '⚠️' : '🚨'} Traffic: ${traffic.label}`);
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

    if (!startPlace || !endPlace) {
      setStatus('Enter both a start and destination.');
      return;
    }

    setLoading(true);
    setStatus('Finding your route...');
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
          styles: [{ color: '#0f766e', opacity: 0.95, weight: 7 }],
        },
        altLineOptions: {
          styles: [{ color: '#cbd5e1', opacity: 0.4, weight: 4, dashArray: '6, 4' }],
        },
      }).addTo(mapRef.current);

      routeControlRef.current = control;

      control.on('routesfound', (event) => {
        const routes = event.routes;
        setAllRoutes(routes);
        setSelectedRouteIndex(0);
        setRouteData(routes[0]);

        const bounds = L.latLngBounds(
          routes[0].coordinates.map(c => [c.lat, c.lng])
        );
        mapRef.current.fitBounds(bounds, { padding: [100, 100], duration: 800 });

        setScreen('route');
        setStatus('Route found! Ready to navigate.');
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
    if (route) {
      setRouteData(route);
    }
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
        setStart('My location');

        if (userMarkerRef.current) {
          userMarkerRef.current.setLatLng(coords);
        } else {
          userMarkerRef.current = L.circleMarker(coords, {
            radius: 10,
            color: '#0f766e',
            fillColor: '#14b8a6',
            fillOpacity: 1,
            weight: 3,
            className: 'user-marker-pulse',
          }).addTo(mapRef.current);
        }

        mapRef.current.panTo(coords, { animate: true, duration: 0.7 });
        setStatus('Location set as start point.');
      },
      () => {
        setStatus('Unable to access your location. Check permissions.');
      }
    );
  };

  const handleTravelToggle = () => {
    if (traveling) {
      if (watchIdRef.current) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setTraveling(false);
      setScreen('route');
      setStatus('Navigation paused.');
      return;
    }

    if (!navigator.geolocation) {
      setStatus('Live navigation unavailable.');
      return;
    }

    setTraveling(true);
    setScreen('live');
    setStatus('Live navigation active. Follow the route.');

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const coords = L.latLng(position.coords.latitude, position.coords.longitude);

        if (lastPositionRef.current) {
          const distance = coords.distanceTo(lastPositionRef.current);
          if (distance < 5) return;
        }

        lastPositionRef.current = coords;
        setCurrentCoords(coords);

        if (userMarkerRef.current) {
          userMarkerRef.current.setLatLng(coords);
        } else {
          userMarkerRef.current = L.circleMarker(coords, {
            radius: 10,
            color: '#0f766e',
            fillColor: '#14b8a6',
            fillOpacity: 1,
            weight: 3,
            className: 'user-marker-pulse',
          }).addTo(mapRef.current);
        }

        mapRef.current.panTo(coords, { animate: true, duration: 0.5 });
        const speed = position.coords.speed === null ? 0 : Math.round(position.coords.speed * 3.6);
        setLiveSpeed(`${speed} km/h`);
        setLiveEta(routeSummary.eta || '--');
      },
      () => {
        setStatus('Location update failed.');
      },
      { enableHighAccuracy: true, maximumAge: 3000 }
    );
  };

  return (
    <>
      <main className="panel">
        <div className="app-topbar">
          <div className="brand">
            <span className="brand-mark">🧭</span>
            <span className="brand-name">Geodesic</span>
          </div>
          <button
            className="theme-toggle"
            type="button"
            onClick={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
            aria-label="Toggle dark mode"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>

        <div className="app-pills">
          <button className={`app-pill ${screen === 'search' ? 'active' : ''}`} type="button" onClick={() => setScreen('search')}>
            Search
          </button>
          <button className={`app-pill ${screen === 'route' ? 'active' : ''}`} type="button" onClick={() => setScreen('route')}>
            Routes
          </button>
          <button className={`app-pill ${screen === 'live' ? 'active' : ''}`} type="button" onClick={() => setScreen('live')}>
            Live
          </button>
        </div>

        <section className={`screen ${screen === 'search' ? 'active' : ''}`} id="searchScreen">
          <div className="search-sheet">
            <div className="route-fields">
              <div className="field">
                <span className="pin" />
                <input id="start" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value !== 'My location') setCurrentCoords(null); }} placeholder="Your location" />
              </div>
              <div className="field">
                <span className="pin end" />
                <input id="end" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="Where to?" />
              </div>
              <button className="swap" type="button" onClick={() => [setStart(end), setEnd(start)]} aria-label="Swap">↕</button>
            </div>
            <div className="actions">
              <button className={`primary ${loading ? 'loading' : ''}`} type="button" onClick={calculateRoute} disabled={loading}>
                {loading ? '...' : 'Search'} <span>→</span>
              </button>
              <button className="secondary locate" type="button" onClick={handleMyLocation}>
                <span>◎</span>
              </button>
            </div>
          </div>
          <div className="status">{status}</div>
          {trafficNote && <div className={`traffic-conditions visible ${getTrafficCondition().level}`}>{trafficNote}</div>}
        </section>

        <section className={`screen ${screen === 'route' ? 'active' : ''}`} id="routeScreen">
          <div className="section-header">
            <span className="eyebrow">Route Ready</span>
            <button className="text-button" type="button" onClick={() => setScreen('search')}>Edit</button>
          </div>

          <div className="summary-card">
            <div className="summary-grid">
              <div>
                <span className="meta">ETA</span>
                <strong>{routeSummary.eta}</strong>
              </div>
              <div>
                <span className="meta">Distance</span>
                <strong>{routeSummary.distance}</strong>
              </div>
            </div>
          </div>

          <div className="mini-tile-grid">
            <div className="mini-tile">
              <h4>Fuel</h4>
              <strong>10%</strong>
            </div>
            <div className="mini-tile">
              <h4>Alerts</h4>
              <strong>2</strong>
            </div>
          </div>

          <div className="route-details">
            <div className="detail-item"><span className="detail-label">Distance</span><span>{routeDetails.distance}</span></div>
            <div className="detail-item"><span className="detail-label">Time</span><span>{routeDetails.time}</span></div>
            <div className="detail-item"><span className="detail-label">Traffic</span><span>{routeDetails.traffic}</span></div>
            <div className="detail-item"><span className="detail-label">Stops</span><span>{routeDetails.stops}</span></div>
          </div>

          <div className={`alternative-routes ${allRoutes.length ? 'visible' : ''}`}>
            <div className="routes-label">Alternatives</div>
            <div>
              {allRoutes.map((route, index) => {
                const distance = (route.summary.totalDistance / 1000).toFixed(1);
                const traffic = getTrafficCondition();
                const adjustedTime = Math.round((route.summary.totalTime / 60) * (traffic.time || 1));
                const timeText = formatMinutes(adjustedTime);

                return (
                  <div
                    key={index}
                    className={`route-option ${selectedRouteIndex === index ? 'selected' : ''}`}
                    onClick={() => handleSelectRoute(index)}
                  >
                    <div className="route-info">
                      <strong>Route {index + 1}</strong>
                      <span className={`traffic-badge traffic-${traffic.level}`}>{traffic.label}</span>
                    </div>
                    <div className="route-traffic">
                      <span>⏱️ {timeText}</span>
                      <span>📍 {distance} km</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <button className={`travel ${traveling ? 'active' : ''}`} type="button" onClick={handleTravelToggle}>
            {traveling ? 'Stop' : 'Navigate'} <span>→</span>
          </button>
          <div className={`live-status ${traveling ? 'visible' : ''}`}>
            <span className="live-dot" />
            <span>Live</span>
            <span>{traveling ? `${liveSpeed}` : 'Ready'}</span>
          </div>
        </section>

        <section className={`screen ${screen === 'live' ? 'active' : ''}`} id="liveScreen">
          <div className="section-header">
            <span className="eyebrow">Navigation</span>
            <button className="text-button" type="button" onClick={() => {
              if (watchIdRef.current) {
                navigator.geolocation.clearWatch(watchIdRef.current);
                watchIdRef.current = null;
              }
              setTraveling(false);
              setScreen('route');
            }}>End</button>
          </div>

          <div className="trip-card">
            <div className="detail-item"><span className="detail-label">Speed</span><span>{liveSpeed}</span></div>
            <div className="detail-item"><span className="detail-label">Route</span><span>In Progress</span></div>
            <div className="detail-item"><span className="detail-label">ETA</span><span>{liveEta}</span></div>
          </div>

          <div className="mini-tile-grid">
            <div className="mini-tile"><h4>Turn</h4><strong>Ahead</strong></div>
            <div className="mini-tile"><h4>Signal</h4><strong>On</strong></div>
          </div>

          <div className="map-chip">
            <span><strong>Map</strong></span>
            <span>Auto-tracking</span>
          </div>

          <div className="live-status visible">
            <span className="live-dot" />
            <span>Tracking</span>
            <span>{liveSpeed}</span>
          </div>
          <button className="secondary" type="button" onClick={() => { if (currentCoords) mapRef.current.panTo(currentCoords, { animate: true, duration: 0.6 }); }} style={{ width: '100%', marginTop: '18px' }}>
            Center Map
          </button>
        </section>

        <nav className="bottom-nav" aria-label="Navigation">
          <button className={`nav-item ${screen === 'search' ? 'active' : ''}`} type="button" onClick={() => setScreen('search')}>Search</button>
          <button className={`nav-item ${screen === 'route' ? 'active' : ''}`} type="button" onClick={() => setScreen('route')}>Routes</button>
          <button className={`nav-item ${screen === 'live' ? 'active' : ''}`} type="button" onClick={() => setScreen('live')}>Drive</button>
          <button className="nav-item" type="button">More</button>
        </nav>
      </main>
      <div id="map" />
    </>
  );
}

export default App;
