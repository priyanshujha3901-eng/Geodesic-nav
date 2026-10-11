import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';
import 'leaflet-routing-machine';
import { supabase } from './supabase';

const NAV_ZOOM = 17;
const HEADING_SCALE = 1.8;

// RFC 2606 reserves .invalid specifically for "this is not a real,
// deliverable address" — that's why it's used here, not a guessed domain.
const EMAIL_DOMAIN = 'geodesic.invalid';
const usernameToEmail = (username) => `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;

// Same free OSRM demo network as before — car/bike/foot profiles.
const TRANSPORT_PROFILES = {
  car: { label: 'Car', icon: '🚗', serviceUrl: 'https://routing.openstreetmap.de/routed-car/route/v1', profile: 'driving' },
  bike: { label: 'Bike', icon: '🚴', serviceUrl: 'https://routing.openstreetmap.de/routed-bike/route/v1', profile: 'bike' },
  walk: { label: 'Walk', icon: '🚶', serviceUrl: 'https://routing.openstreetmap.de/routed-foot/route/v1', profile: 'foot' },
  bus: { label: 'Bus', icon: '🚌', simulated: true },
};
const TRANSPORT_ORDER = ['car', 'bike', 'walk', 'bus'];

const MAP_LAYERS = {
  street: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors' },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
  },
};

const CAMERA_COLORS = { speed: '#f97316', red_light: '#ef4444', average_speed: '#a855f7', unknown: '#64748b' };

const getTrafficCondition = () => {
  const rand = Math.random();
  if (rand < 0.6) return { level: 'clear', label: 'Clear' };
  if (rand < 0.85) return { level: 'moderate', label: 'Moderate' };
  return { level: 'heavy', label: 'Heavy' };
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

const computeBearing = (from, to) => {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLon = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const getRouteProgress = (route, userLatLng) => {
  const coords = route.coordinates;
  let nearestIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = userLatLng.distanceTo(coords[i]);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  }
  let remaining = 0;
  for (let i = nearestIdx; i < coords.length - 1; i++) remaining += coords[i].distanceTo(coords[i + 1]);
  const upcoming = route.instructions.find((ins) => ins.index > nearestIdx) || route.instructions[route.instructions.length - 1];
  const maneuverCoord = coords[upcoming?.index] ?? coords[coords.length - 1];
  const distanceToManeuver = userLatLng.distanceTo(maneuverCoord);
  return { nearestIdx, remaining, instruction: upcoming ? { ...upcoming, distanceToManeuver } : null };
};

function App() {
  const mapRef = useRef(null);
  const routeControlRef = useRef(null);
  const userMarkerRef = useRef(null);
  const selectedRouteRef = useRef(null);
  const streetLayerRef = useRef(null);
  const satelliteLayerRef = useRef(null);
  const lastHeadingCoordsRef = useRef(null);
  const headingRef = useRef(0);
  const lastGroupWriteRef = useRef(0);
  const camerasLayerRef = useRef(L.layerGroup());
  const groupMemberMarkersRef = useRef({});
  const lastStartCoordsRef = useRef(null);
  const lastEndCoordsRef = useRef(null);
  const povModeRef = useRef('north');

  const [theme, setTheme] = useState(() => localStorage.getItem('geodesic-theme') || 'light');
  const [screen, setScreen] = useState('search');
  const [mapType, setMapType] = useState('street');
  const [povMode, setPovMode] = useState('north');
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
  const [alertsOn, setAlertsOn] = useState(true);
  const [currentRouteId, setCurrentRouteId] = useState(null);

  // --- Auth state ---
  const [authUser, setAuthUser] = useState(null);
  const [authProfile, setAuthProfile] = useState(null);
  const isGuest = authProfile ? authProfile.is_anonymous : true;
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [signUpUsername, setSignUpUsername] = useState('');
  const [signUpMobile, setSignUpMobile] = useState('');
  const [signUpPassword, setSignUpPassword] = useState('');
  const [signUpConfirmPassword, setSignUpConfirmPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [myProfileDetails, setMyProfileDetails] = useState(null);

  // --- Group travel state ---
  const [activeGroup, setActiveGroup] = useState(null);
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupMemberLocations, setGroupMemberLocations] = useState({});
  const [mismatch, setMismatch] = useState(null);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState([]);
  const [invitedIds, setInvitedIds] = useState(new Set());
  const [myInvitations, setMyInvitations] = useState([]);
  const [groupsError, setGroupsError] = useState(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('geodesic-theme', theme);
  }, [theme]);

  // --- Map init ---
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

    return () => map.remove();
  }, []);

  // --- Auth: silent guest sign-in, session tracking ---
  useEffect(() => {
    let mounted = true;
    const init = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        const { data: anon, error } = await supabase.auth.signInAnonymously();
        if (error) console.error('Anonymous sign-in failed:', error.message);
        if (mounted) setAuthUser(anon.session?.user ?? null);
      } else if (mounted) {
        setAuthUser(data.session.user);
      }
    };
    init();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setAuthUser(session?.user ?? null));
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authUser) { setAuthProfile(null); return; }
    supabase.from('profiles').select('id, username, is_anonymous').eq('id', authUser.id).single()
      .then(({ data }) => setAuthProfile(data));
  }, [authUser?.id]);

  useEffect(() => {
    if (screen === 'profile' && !isGuest) {
      supabase.rpc('get_my_profile').then(({ data }) => setMyProfileDetails(data?.[0] ?? null));
    }
  }, [screen, isGuest]);

  const handleSignUp = async () => {
    const username = signUpUsername.trim();
    if (!username) { setAuthError('Choose a username.'); return; }
    if (signUpPassword.length < 6) { setAuthError('Password must be at least 6 characters.'); return; }
    if (signUpPassword !== signUpConfirmPassword) { setAuthError('Passwords do not match.'); return; }

    setAuthBusy(true);
    setAuthError(null);
    try {
      const { data, error } = await supabase.auth.signUp({ email: usernameToEmail(username), password: signUpPassword });
      if (error) {
        throw new Error(error.message.toLowerCase().includes('already registered') ? 'That username is taken.' : error.message);
      }
      if (data.user) {
        const { error: profileError } = await supabase
          .from('profiles')
          .update({ username, mobile_number: signUpMobile.trim() || null })
          .eq('id', data.user.id);
        if (profileError) throw new Error(profileError.message.includes('duplicate') ? 'That username is taken.' : profileError.message);
      }
      setScreen('search');
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogin = async () => {
    if (!loginUsername.trim() || !loginPassword) { setAuthError('Enter your username and password.'); return; }
    setAuthBusy(true);
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(loginUsername),
      password: loginPassword,
    });
    setAuthBusy(false);
    if (error) { setAuthError('Incorrect username or password.'); return; }
    setScreen('search');
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    await supabase.auth.signInAnonymously();
    setScreen('search');
  };

  // --- Camera layer (public, works for guests too) ---
  useEffect(() => {
    supabase
      .from('cameras')
      .select('id, latitude, longitude, road_name, camera_type, source, confidence, last_verified_at')
      .eq('city', 'Delhi')
      .then(({ data, error }) => {
        if (error) { console.error('Failed to load cameras:', error.message); return; }
        const layer = camerasLayerRef.current;
        layer.clearLayers();
        (data || []).forEach((cam) => {
          const color = CAMERA_COLORS[cam.camera_type] || CAMERA_COLORS.unknown;
          L.circleMarker([cam.latitude, cam.longitude], {
            radius: 7,
            color,
            fillColor: color,
            fillOpacity: cam.confidence === 'low' ? 0.3 : 0.85,
          })
            .bindPopup(
              `<strong>${cam.camera_type.replace('_', ' ')}</strong><br/>${cam.road_name || 'Road name unknown'}<br/>` +
                `Source: ${cam.source} · Confidence: ${cam.confidence}<br/>` +
                `<small>Camera locations are based on public information and OpenStreetMap data. They may be incomplete or inaccurate. Always follow traffic rules.</small>`
            )
            .addTo(layer);
        });
      });
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    if (alertsOn) camerasLayerRef.current.addTo(mapRef.current);
    else mapRef.current.removeLayer(camerasLayerRef.current);
  }, [alertsOn]);

  const ensureUserMarker = (coords) => {
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng(coords);
    } else {
      userMarkerRef.current = L.marker(coords, {
        icon: L.divIcon({ className: 'user-marker-icon', html: '<div class="user-arrow-shape">▲</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        interactive: false,
      }).addTo(mapRef.current);
    }
  };

  const setMarkerHeading = (bearing) => {
    const shape = userMarkerRef.current?.getElement()?.querySelector('.user-arrow-shape');
    if (shape) shape.style.transform = `rotate(${bearing}deg)`;
  };

  const toggleMapType = () => {
    const map = mapRef.current;
    setMapType((prev) => {
      const next = prev === 'street' ? 'satellite' : 'street';
      if (next === 'satellite') { map.removeLayer(streetLayerRef.current); map.addLayer(satelliteLayerRef.current); }
      else { map.removeLayer(satelliteLayerRef.current); map.addLayer(streetLayerRef.current); }
      return next;
    });
  };

  const applyMapRotation = () => {
    const container = mapRef.current?.getContainer();
    if (!container) return;
    container.style.transformOrigin = '50% 50%';
    container.style.transition = 'transform 0.3s linear';
    container.style.transform = povModeRef.current === 'heading' ? `rotate(${-headingRef.current}deg) scale(${HEADING_SCALE})` : 'none';
  };

  useEffect(() => {
    povModeRef.current = povMode;
    applyMapRotation();
    if (!mapRef.current) return;
    if (povMode === 'heading') mapRef.current.dragging.disable();
    else mapRef.current.dragging.enable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [povMode]);

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

    if (routeControlRef.current) mapRef.current.removeControl(routeControlRef.current);

    const control = L.Routing.control({
      waypoints: [startCoords, endCoords],
      serviceUrl: fetchProfile.serviceUrl,
      profile: fetchProfile.profile,
      addWaypoints: false,
      routeWhileDragging: false,
      show: false,
      fitSelectedRoutes: true,
      createMarker: () => null,
      lineOptions: { styles: [{ color: '#1d4ed8', opacity: 0.25, weight: 12 }, { color: '#3b82f6', opacity: 1, weight: 6 }] },
      altLineOptions: { styles: [{ color: '#94a3b8', opacity: 0.7, weight: 5 }] },
    }).addTo(mapRef.current);

    routeControlRef.current = control;

    control.on('routesfound', async (event) => {
      let routes = event.routes;
      if (profileInfo.simulated) {
        routes = routes.map((r) => ({ ...r, summary: { totalDistance: r.summary.totalDistance, totalTime: r.summary.totalTime * 1.6 + 300 }, simulated: true }));
      }
      setAllRoutes(routes);
      setSelectedRouteIndex(0);
      applyRouteSelection(routes[0]);

      const bounds = L.latLngBounds(routes[0].coordinates.map((c) => [c.lat, c.lng]));
      mapRef.current.fitBounds(bounds, { padding: [80, 80], duration: 0.6 });

      if (!isGuest && authUser) {
        const first = routes[0].coordinates[0];
        const last = routes[0].coordinates[routes[0].coordinates.length - 1];
        const { data } = await supabase
          .from('routes')
          .insert({
            created_by: authUser.id,
            origin: `SRID=4326;POINT(${first.lng} ${first.lat})`,
            destination: `SRID=4326;POINT(${last.lng} ${last.lat})`,
            distance_meters: routes[0].summary.totalDistance,
            duration_seconds: routes[0].summary.totalTime,
            mode,
            city: 'Delhi',
          })
          .select('id')
          .single();
        setCurrentRouteId(data?.id ?? null);
      } else {
        setCurrentRouteId(null);
      }

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
    if (!endPlace) { setStatus('Type a destination.'); return; }
    if (!startPlace && !currentCoords) { setStatus('Set your starting point first.'); return; }

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
    if (!navigator.geolocation) { setStatus('Location not available in this browser.'); return; }
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
  };

  const endDrive = () => {
    setPovMode('north');
    const container = mapRef.current?.getContainer();
    if (container) container.style.transform = 'none';
    mapRef.current?.dragging.enable();
    setScreen('preview');
  };

  const recenter = () => {
    if (currentCoords) mapRef.current.setView(currentCoords, NAV_ZOOM, { animate: true });
  };

  // --- Combined geolocation watcher: drives the nav HUD AND shares location
  // with the active group, whichever applies, from a single watchPosition. ---
  useEffect(() => {
    const needsWatch = screen === 'drive' || !!activeGroup;
    if (!needsWatch || !navigator.geolocation) return;

    const id = navigator.geolocation.watchPosition(
      (position) => {
        const coords = L.latLng(position.coords.latitude, position.coords.longitude);
        setCurrentCoords(coords);
        ensureUserMarker(coords);

        if (screen === 'drive') {
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
        }

        if (activeGroup && authUser) {
          const now = Date.now();
          if (now - lastGroupWriteRef.current > 2500) {
            lastGroupWriteRef.current = now;
            supabase
              .from('user_locations')
              .upsert({
                group_id: activeGroup.id,
                user_id: authUser.id,
                location: `SRID=4326;POINT(${coords.lng} ${coords.lat})`,
                latitude: coords.lat,
                longitude: coords.lng,
                speed_mps: position.coords.speed,
                heading: position.coords.heading,
                updated_at: new Date().toISOString(),
              })
              .then(({ error }) => { if (error) console.error('Failed to share location:', error.message); });
          }
        }
      },
      (err) => console.error('Geolocation error:', err.message),
      { enableHighAccuracy: true, maximumAge: 2000 }
    );

    return () => navigator.geolocation.clearWatch(id);
  }, [screen, activeGroup?.id, authUser?.id]);

  // --- Group travel ---
  const loadActiveGroup = useCallback(async () => {
    if (!authUser) { setActiveGroup(null); return; }
    const { data } = await supabase
      .from('group_members')
      .select('group_id, groups!inner(id, creator_id, status, route_id)')
      .eq('user_id', authUser.id)
      .eq('status', 'active')
      .eq('groups.status', 'active')
      .maybeSingle();
    setActiveGroup(data?.groups ?? null);
  }, [authUser?.id]);

  useEffect(() => { loadActiveGroup(); }, [loadActiveGroup]);

  useEffect(() => {
    if (!activeGroup) {
      setGroupMemberLocations({});
      setMismatch(null);
      return;
    }

    supabase
      .from('user_locations')
      .select('user_id, latitude, longitude')
      .eq('group_id', activeGroup.id)
      .then(({ data }) => {
        const map = {};
        (data || []).forEach((row) => { map[row.user_id] = row; });
        setGroupMemberLocations(map);
      });

    const locChannel = supabase
      .channel(`loc-${activeGroup.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_locations', filter: `group_id=eq.${activeGroup.id}` }, (payload) => {
        if (payload.eventType === 'DELETE') {
          setGroupMemberLocations((prev) => {
            const next = { ...prev };
            delete next[payload.old.user_id];
            return next;
          });
        } else {
          setGroupMemberLocations((prev) => ({ ...prev, [payload.new.user_id]: payload.new }));
        }
      })
      .subscribe();

    const mismatchChannel = supabase
      .channel(`mismatch-${activeGroup.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_route_mismatches', filter: `group_id=eq.${activeGroup.id}` }, (payload) => {
        setMismatch(payload.new && !payload.new.resolved ? payload.new : null);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(locChannel);
      supabase.removeChannel(mismatchChannel);
    };
  }, [activeGroup?.id]);

  // Render other members' positions imperatively on the Leaflet map.
  useEffect(() => {
    if (!mapRef.current) return;
    const seen = new Set();
    Object.entries(groupMemberLocations).forEach(([uid, loc]) => {
      if (uid === authUser?.id) return;
      seen.add(uid);
      const pos = [loc.latitude, loc.longitude];
      if (groupMemberMarkersRef.current[uid]) {
        groupMemberMarkersRef.current[uid].setLatLng(pos);
      } else {
        groupMemberMarkersRef.current[uid] = L.marker(pos, {
          icon: L.divIcon({ className: 'member-marker-icon', html: '<div class="member-marker-shape">●</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        }).addTo(mapRef.current);
      }
    });
    Object.keys(groupMemberMarkersRef.current).forEach((uid) => {
      if (!seen.has(uid)) {
        mapRef.current.removeLayer(groupMemberMarkersRef.current[uid]);
        delete groupMemberMarkersRef.current[uid];
      }
    });
  }, [groupMemberLocations, authUser?.id]);

  useEffect(() => {
    if (screen === 'groups' && activeGroup) {
      supabase.rpc('get_group_member_usernames', { p_group_id: activeGroup.id })
        .then(({ data, error }) => { if (!error) setGroupMembers(data || []); });
    }
  }, [screen, activeGroup?.id]);

  useEffect(() => {
    if (screen === 'invitations') {
      supabase.rpc('get_my_invitations').then(({ data, error }) => { if (!error) setMyInvitations(data || []); });
    }
  }, [screen]);

  const handleStartGroupTravel = async () => {
    if (isGuest) { setScreen('login'); return; }
    if (!currentRouteId) { setGroupsError('Find a route before starting Group Travel.'); return; }
    const { data, error } = await supabase.rpc('create_group', { p_route_id: currentRouteId });
    if (error) { setGroupsError(error.message); return; }
    await loadActiveGroup();
    setGroupsError(null);
    setScreen('groups');
  };

  const handleInviteSearch = async (q) => {
    setInviteQuery(q);
    if (!q.trim()) { setInviteResults([]); return; }
    const { data, error } = await supabase.rpc('search_profiles_by_username', { p_query: q.trim() });
    if (!error) setInviteResults(data || []);
  };

  const handleInviteUser = async (userId) => {
    if (!activeGroup) return;
    const { error } = await supabase.rpc('invite_user_to_group', { p_group_id: activeGroup.id, p_invitee_id: userId });
    if (error) { setGroupsError(error.message); return; }
    setInvitedIds((prev) => new Set(prev).add(userId));
    setGroupsError(null);
  };

  const handleRespondInvite = async (inviteId, accept) => {
    const { error } = await supabase.rpc('respond_to_invite', { p_invite_id: inviteId, p_accept: accept, p_route_id: currentRouteId });
    if (error) { setGroupsError(error.message); return; }
    setMyInvitations((prev) => prev.filter((i) => i.invite_id !== inviteId));
    if (accept) { await loadActiveGroup(); setScreen('groups'); }
  };

  const handleLeaveGroup = async () => {
    if (!activeGroup) return;
    await supabase.rpc('leave_group', { p_group_id: activeGroup.id });
    setActiveGroup(null);
  };

  const handleEndGroup = async () => {
    if (!activeGroup) return;
    await supabase.rpc('end_group', { p_group_id: activeGroup.id });
    setActiveGroup(null);
  };

  const handleSwitchRoute = async () => {
    if (!mismatch || !activeGroup) return;
    const theirRouteId = mismatch.user_a_route_id === currentRouteId ? mismatch.user_b_route_id : mismatch.user_a_route_id;
    await supabase.rpc('update_my_route_in_group', { p_group_id: activeGroup.id, p_route_id: theirRouteId });
  };

  const ModeRow = () => (
    <div className="mode-row">
      {TRANSPORT_ORDER.map((mode) => (
        <button key={mode} type="button" className={`mode-btn ${transportMode === mode ? 'active' : ''}`} onClick={() => handleModeChange(mode)}>
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
            <div className="brand-chip"><span className="brand-mark">🧭</span> Geodesic</div>
            <button className="icon-btn" type="button" onClick={() => setTheme((p) => (p === 'light' ? 'dark' : 'light'))} aria-label="Toggle dark mode">
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>

          <div className="search-card">
            <div className="search-row">
              <span className="dot start-dot" />
              <input value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value !== 'Your location') setCurrentCoords(null); }} placeholder="Your location" />
            </div>
            <div className="search-divider" />
            <div className="search-row">
              <span className="dot end-dot" />
              <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="Where to?" />
              <button className="swap-btn" type="button" onClick={() => [setStart(end), setEnd(start)]} aria-label="Swap">↕</button>
            </div>
          </div>

          <ModeRow />

          <label className="toggle camera-toggle">
            <input type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} />
            Camera alerts
          </label>

          {status && <div className="toast">{status}</div>}

          <button className="fab maptype-fab" type="button" onClick={toggleMapType} aria-label="Toggle satellite view">{mapType === 'street' ? '🛰️' : '🗺️'}</button>
          <button className="fab locate-fab" type="button" onClick={handleMyLocation} aria-label="Use my location">◎</button>
          <button className={`fab-primary search-fab ${loading ? 'loading' : ''}`} type="button" onClick={calculateRoute} disabled={loading}>
            {loading ? 'Searching...' : 'Search route'}
          </button>
        </div>
      )}

      {screen === 'preview' && (
        <div className="sheet">
          <div className="sheet-handle" />
          <div className="sheet-header">
            <button className="icon-btn" type="button" onClick={() => setScreen('search')} aria-label="Back">←</button>
            <div className="sheet-title">{end || 'Destination'}</div>
          </div>

          <ModeRow />

          <div className="eta-row">
            <div className="eta-big">{loading ? '...' : routeSummary.eta}</div>
            <div className="eta-sub">{routeSummary.distance} · arrive {routeSummary.arrival}</div>
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
                  <button key={index} type="button" className={`alt-card ${selectedRouteIndex === index ? 'selected' : ''}`} onClick={() => handleSelectRoute(index)}>
                    <strong>{etaText}</strong>
                    <span>{distanceKm} km</span>
                  </button>
                );
              })}
            </div>
          )}

          <button className="go-btn" type="button" onClick={startDrive} disabled={loading}>GO</button>
          <button className="secondary-btn" type="button" onClick={handleStartGroupTravel}>+ Group Travel</button>
          {groupsError && <p className="error-text">{groupsError}</p>}
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
            <button className="icon-btn end-btn" type="button" onClick={endDrive} aria-label="End navigation">✕</button>
          </div>

          <button className="fab maptype-fab drive-pos" type="button" onClick={toggleMapType} aria-label="Toggle satellite view">{mapType === 'street' ? '🛰️' : '🗺️'}</button>
          <button className="fab pov-fab" type="button" onClick={() => setPovMode((p) => (p === 'north' ? 'heading' : 'north'))} aria-label="Toggle map orientation">
            {povMode === 'north' ? '🧭' : '🔼'}
          </button>
          <button className="fab recenter-fab" type="button" onClick={recenter} aria-label="Recenter">⌖</button>

          <div className="drive-bottom-bar">
            <div className="drive-stat"><strong>{driveStats.eta}</strong><span>ETA</span></div>
            <div className="drive-stat"><strong>{driveStats.distance}</strong><span>distance</span></div>
            <div className="drive-stat"><strong>{driveStats.arrival}</strong><span>arrival</span></div>
            <div className="drive-stat"><strong>{liveSpeed}</strong><span>speed</span></div>
          </div>
        </div>
      )}

      {screen === 'login' && (
        <div className="auth-overlay">
          <div className="auth-card">
            <h2>Login</h2>
            <input placeholder="Username" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} />
            <input placeholder="Password" type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} />
            {authError && <p className="error-text">{authError}</p>}
            <button className="auth-primary" disabled={authBusy} onClick={handleLogin}>{authBusy ? '...' : 'Login'}</button>
            <button className="auth-link" onClick={() => { setAuthError(null); setScreen('signup'); }}>Don't have an account? Sign up</button>
            <button className="auth-link" onClick={() => setScreen('search')}>Continue as guest</button>
          </div>
        </div>
      )}

      {screen === 'signup' && (
        <div className="auth-overlay">
          <div className="auth-card">
            <h2>Create account</h2>
            <input placeholder="Username" value={signUpUsername} onChange={(e) => setSignUpUsername(e.target.value)} />
            <input placeholder="Mobile number (optional)" value={signUpMobile} onChange={(e) => setSignUpMobile(e.target.value)} />
            <input placeholder="Password" type="password" value={signUpPassword} onChange={(e) => setSignUpPassword(e.target.value)} />
            <input placeholder="Confirm password" type="password" value={signUpConfirmPassword} onChange={(e) => setSignUpConfirmPassword(e.target.value)} />
            {authError && <p className="error-text">{authError}</p>}
            <button className="auth-primary" disabled={authBusy} onClick={handleSignUp}>{authBusy ? '...' : 'Create account'}</button>
            <button className="auth-link" onClick={() => { setAuthError(null); setScreen('login'); }}>Already have an account? Login</button>
            <button className="auth-link" onClick={() => setScreen('search')}>Continue as guest</button>
          </div>
        </div>
      )}

      {screen === 'profile' && (
        <div className="auth-overlay">
          <div className="auth-card">
            <h2>My profile</h2>
            <p><strong>Username:</strong> @{myProfileDetails?.username ?? authProfile?.username}</p>
            <p><strong>Mobile number:</strong> {myProfileDetails?.mobile_number || 'Not set'}</p>
            <button className="auth-link" onClick={() => setScreen('search')}>Close</button>
          </div>
        </div>
      )}

      {screen === 'groups' && (
        <div className="auth-overlay">
          <div className="auth-card groups-card">
            <h2>My groups</h2>
            {!activeGroup && <p>No active group. Find a route, then tap "+ Group Travel".</p>}
            {activeGroup && (
              <>
                <p className="label">Members</p>
                <ul className="member-list">
                  {groupMembers.map((m) => (
                    <li key={m.user_id}>@{m.username}{m.role === 'creator' ? ' (creator)' : ''}</li>
                  ))}
                </ul>

                <p className="label">Search user by username</p>
                <input value={inviteQuery} onChange={(e) => handleInviteSearch(e.target.value)} placeholder="username" />
                <ul className="invite-results">
                  {inviteResults.map((u) => (
                    <li key={u.id}>
                      <span>@{u.username}</span>
                      <button disabled={invitedIds.has(u.id)} onClick={() => handleInviteUser(u.id)}>
                        {invitedIds.has(u.id) ? 'Invited' : 'Invite'}
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="group-actions">
                  <button onClick={handleLeaveGroup}>Leave group</button>
                  {activeGroup.creator_id === authUser?.id && <button onClick={handleEndGroup}>End group</button>}
                </div>
              </>
            )}
            {groupsError && <p className="error-text">{groupsError}</p>}
            <button className="auth-link" onClick={() => setScreen('search')}>Close</button>
          </div>
        </div>
      )}

      {screen === 'invitations' && (
        <div className="auth-overlay">
          <div className="auth-card">
            <h2>Invitations</h2>
            {myInvitations.length === 0 && <p>No pending invitations.</p>}
            <ul className="invite-results">
              {myInvitations.map((inv) => (
                <li key={inv.invite_id} className="invite-row">
                  <span>Invited by @{inv.inviter_username}</span>
                  <span className="invite-actions">
                    <button onClick={() => handleRespondInvite(inv.invite_id, true)}>Accept</button>
                    <button onClick={() => handleRespondInvite(inv.invite_id, false)}>Decline</button>
                  </span>
                </li>
              ))}
            </ul>
            <button className="auth-link" onClick={() => setScreen('search')}>Close</button>
          </div>
        </div>
      )}

      {screen === 'settings' && (
        <div className="auth-overlay">
          <div className="auth-card">
            <h2>Settings</h2>
            <p>More settings coming soon.</p>
            <button className="auth-link" onClick={() => setScreen('search')}>Close</button>
          </div>
        </div>
      )}

      {mismatch && activeGroup && screen !== 'drive' && (
        <div className="mismatch-banner">
          <p>You and your friend are on different routes.</p>
          <button onClick={handleSwitchRoute}>Switch to their route?</button>
        </div>
      )}

      {screen !== 'drive' && (
        <>
          <button className="fab menu-fab" type="button" onClick={() => setMenuOpen((o) => !o)} aria-label="Account menu">⋮</button>
          {menuOpen && (
            <div className="account-menu">
              {isGuest ? (
                <button onClick={() => { setScreen('login'); setMenuOpen(false); }}>Login / Sign up</button>
              ) : (
                <div className="account-menu-header">@{authProfile?.username}</div>
              )}
              <button onClick={() => { setScreen(isGuest ? 'login' : 'profile'); setMenuOpen(false); }}>My profile</button>
              <button onClick={() => { setScreen(isGuest ? 'login' : 'groups'); setMenuOpen(false); }}>My groups</button>
              <button onClick={() => { setScreen(isGuest ? 'login' : 'invitations'); setMenuOpen(false); }}>Invitations</button>
              <button onClick={() => { setScreen('settings'); setMenuOpen(false); }}>Settings</button>
              {!isGuest && <button onClick={() => { handleLogout(); setMenuOpen(false); }}>Logout</button>}
            </div>
          )}
        </>
      )}
    </>
  );
}

export default App;
