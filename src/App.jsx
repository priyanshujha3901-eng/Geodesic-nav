import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';
import 'leaflet-routing-machine';
import { supabase } from './supabase';
import { REPORT_CATEGORIES, REPORT_CATEGORY_BY_ID, REPORT_BUTTON_ICON_INNER, iconSvg, reportIconSvg } from './reportIcons';

const NAV_ZOOM = 18;
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

// --- community reports: constants and pure helpers ---------------------
const REPORT_MIN_ZOOM = 9;                  // speed cameras load for the visible area from this zoom up
const REPORT_ROUTE_MAX_DISTANCE_M = 100;    // hazards must be this close to the selected route to show
const REPORT_VOTE_RADIUS_M = 300;           // keep equal to vote_report() on the server
const REPORT_REFRESH_MS = 60000;
const REPORT_FIX_MAX_AGE_MS = 15000;        // an older GPS fix counts as stale
const REPORT_FIX_MAX_ACCURACY_M = 100;      // a worse fix counts as unreliable
const REPORT_SAVE_TIMEOUT_MS = 15000;
const REPORT_DESC_MAX = 80;

const newRequestId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject({ timeout: true }), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

// Server rule messages (raise exception) arrive with SQLSTATE P0001; anything else gets a generic text.
const reportErrorText = (error, fallback) =>
  (error && error.code === 'P0001' && error.message) ? error.message : fallback;

const reportAgo = (iso) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (!Number.isFinite(mins)) return 'a while ago';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

const draftPinHtml = (id) => {
  const c = REPORT_CATEGORY_BY_ID[id] || REPORT_CATEGORY_BY_ID.other;
  return `<div class="report-draft-pin" style="--pin:${c.color}"><span>${reportIconSvg(id, 22)}</span></div>`;
};

const reportMarkerIcon = (r) => {
  const c = REPORT_CATEGORY_BY_ID[r.category] || REPORT_CATEGORY_BY_ID.other;
  const cls = ['report-pin', r.status === 'dimmed' ? 'dimmed' : '', r.status === 'community_confirmed' ? 'confirmed' : 'unconfirmed', r.is_mine ? 'mine' : ''].join(' ');
  return L.divIcon({
    className: 'report-marker-icon',
    html: `<div class="${cls}" style="background:${c.color}">${reportIconSvg(r.category, 18)}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
};


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

// --- route-progress core (start) ---------------------------------------
// Pure helpers for the grey "travelled" / blue "remaining" route lines.
// They never modify the route geometry; they only track how far along the
// original route the user has got (forward-only).
const PROGRESS_WINDOW_M = 1000;       // only look this far ahead of current progress
const PROGRESS_MIN_TOLERANCE_M = 60;  // max distance from the route to count as "on it"
const PROGRESS_MIN_STEP_M = 2;        // ignore tiny movements (GPS noise)
const ARRIVAL_SNAP_M = 20;            // this close to the end = arrived

const projectOnSegment = (pt, a, b) => {
  const k = Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lng - a.lng) * k;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : (((pt.lng - a.lng) * k) * dx + (pt.lat - a.lat) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { t, point: L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t) };
};

const buildRouteProgress = (coords) => {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + coords[i - 1].distanceTo(coords[i]));
  return { coords, cum, total: cum[cum.length - 1], along: 0, seg: 0, point: coords[0] };
};

// Returns true when progress moved forward. Never moves backward.
const advanceRouteProgress = (p, userLatLng, accuracy) => {
  if (p.along >= p.total) return false;
  const tolerance = Math.max(PROGRESS_MIN_TOLERANCE_M, accuracy || 0);
  let best = null;
  for (let i = p.seg; i < p.coords.length - 1; i++) {
    if (p.cum[i] - p.along > PROGRESS_WINDOW_M) break;
    const proj = projectOnSegment(userLatLng, p.coords[i], p.coords[i + 1]);
    const dist = userLatLng.distanceTo(proj.point);
    if (dist > tolerance) continue;
    const along = p.cum[i] + proj.t * (p.cum[i + 1] - p.cum[i]);
    // small penalty for far-ahead matches so loops / out-and-back roads don't cause jumps
    const score = dist + 0.01 * Math.max(0, along - p.along);
    if (!best || score < best.score) best = { i, point: proj.point, along, score };
  }
  if (!best) return false;
  if (p.total - best.along <= ARRIVAL_SNAP_M) {
    best = { i: p.coords.length - 2, point: p.coords[p.coords.length - 1], along: p.total };
  }
  if (best.along <= p.along) return false;
  if (best.along < p.total && best.along - p.along < PROGRESS_MIN_STEP_M) return false;
  p.along = best.along;
  p.seg = best.i;
  p.point = best.point;
  return true;
};

const progressPolylines = (p) => {
  if (p.along <= 0) return { travelled: [], remaining: p.coords };
  return {
    travelled: [...p.coords.slice(0, p.seg + 1), p.point],
    remaining: p.along >= p.total ? [] : [p.point, ...p.coords.slice(p.seg + 1)],
  };
};
// --- route-progress core (end) -----------------------------------------

// CCTV-style camera glyph (inline SVG, no external file)
const CCTV_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l12-4 2 6-12 4z" fill="#fff" fill-opacity=".25"/><path d="M17 10l4 1.5"/><path d="M8 14l-1 3h4"/><path d="M9 20h8"/></svg>';

// --- route-camera core (start) -----------------------------------------
const ROUTE_CAMERA_MAX_DISTANCE_M = 75; // a camera this close to the route line counts as "near the route"
const ROUTE_CAMERA_FIELDS = 'id, latitude, longitude, road_name, camera_type, source, confidence, last_verified_at';
// While a route is shown, hide the city-wide camera dots so only cameras near the route remain.
// Set to false to keep the old city-wide dots visible during a route as well.
const HIDE_CITY_CAMERAS_DURING_ROUTE = true;

const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Cameras within maxM of the route polyline, sorted by distance along the route.
// `cum` is the cumulative route distance per vertex (from buildRouteProgress).
const matchCamerasToRoute = (coords, cum, cameras, maxM) => {
  const n = coords.length;
  if (n < 2) return [];
  const lat0 = coords[0].lat;
  const lng0 = coords[0].lng;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110574;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (coords[i].lng - lng0) * kx;
    ys[i] = (coords[i].lat - lat0) * ky;
  }
  const out = [];
  for (const cam of cameras) {
    const lat = Number(cam.latitude);
    const lng = Number(cam.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const cx = (lng - lng0) * kx;
    const cy = (lat - lat0) * ky;
    let bestD2 = maxM * maxM + 1e-9;
    let bestAlong = -1;
    for (let i = 0; i < n - 1; i++) {
      const x1 = xs[i], y1 = ys[i], x2 = xs[i + 1], y2 = ys[i + 1];
      if (cx < Math.min(x1, x2) - maxM || cx > Math.max(x1, x2) + maxM) continue;
      if (cy < Math.min(y1, y2) - maxM || cy > Math.max(y1, y2) + maxM) continue;
      const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((cx - x1) * dx + (cy - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * dx, py = y1 + t * dy;
      const d2 = (cx - px) * (cx - px) + (cy - py) * (cy - py);
      if (d2 < bestD2) { bestD2 = d2; bestAlong = cum[i] + t * (cum[i + 1] - cum[i]); }
    }
    if (bestAlong >= 0) out.push({ camera: { ...cam, latitude: lat, longitude: lng }, along: bestAlong, distance: Math.sqrt(bestD2) });
  }
  out.sort((a, b) => a.along - b.along);
  return out;
};

const routeCameraPopupHtml = (c) =>
  `<strong>${escapeHtml(String(c.camera_type || 'unknown').replace('_', ' '))}</strong><br/>` +
  (c.road_name ? `${escapeHtml(c.road_name)}<br/>` : '') +
  `Near selected route<br/>Source: ${escapeHtml(c.source)} · Confidence: ${escapeHtml(c.confidence)}` +
  (c.last_verified_at ? `<br/>Last verified: ${escapeHtml(new Date(c.last_verified_at).toLocaleDateString())}` : '') +
  `<br/><small>Camera locations are based on public information and OpenStreetMap data. They may be incomplete or inaccurate. Always follow traffic rules.</small>`;
// --- route-camera core (end) -------------------------------------------

// --- live-bus core (start) ---------------------------------------------
const BUS_REFRESH_MS = 12000;  // live bus refresh while Bus mode is selected
const BUS_DETAIL_MAX = 800;    // more buses than this in view -> light dots instead of labelled icons

// Keeps only vehicles with a usable position; key = stable id so markers can be reused.
const normalizeBusVehicles = (vehicles) => {
  const next = new Map();
  (vehicles || []).forEach((v, i) => {
    const lat = Number(v.latitude);
    const lng = Number(v.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return;
    next.set(String(v.vehicleId || v.vehicleLabel || v.tripId || `anon-${i}`), { ...v, latitude: lat, longitude: lng });
  });
  return next;
};

// Only real data: route id if the feed has one, else the vehicle label, else nothing.
const busLabel = (b) => String(b.routeId || b.vehicleLabel || '').trim();

const busPopupHtml = (b) => {
  const rows = ['<strong>Bus</strong>'];
  if (b.vehicleLabel) rows.push(`Vehicle: ${escapeHtml(b.vehicleLabel)}`);
  if (b.vehicleId && b.vehicleId !== b.vehicleLabel) rows.push(`Vehicle ID: ${escapeHtml(b.vehicleId)}`);
  if (b.routeId) rows.push(`Route ID: ${escapeHtml(b.routeId)}`);
  if (Number.isFinite(Number(b.timestamp)) && Number(b.timestamp) > 0) {
    rows.push(`Last updated: ${escapeHtml(new Date(Number(b.timestamp) * 1000).toLocaleTimeString())}`);
  }
  if (b.speed != null && Number.isFinite(Number(b.speed))) rows.push(`Speed: ${Math.round(Number(b.speed) * 3.6)} km/h`);
  if (b.bearing != null && Number.isFinite(Number(b.bearing))) rows.push(`Bearing: ${Math.round(Number(b.bearing))}°`);
  rows.push('<small>Data: Delhi Open Transit Data</small>');
  return rows.join('<br/>');
};
// --- live-bus core (end) -----------------------------------------------

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
  const routeProgressRef = useRef(null);      // { coords (original route), cum, total, along, seg, point }
  const progressLinesRef = useRef(null);      // { travelled, remaining } Leaflet polylines
  const previewLineStylesRef = useRef(null);  // saved opacities of the routing-machine preview line
  const flyingRef = useRef(false);            // true while the GO flyTo animation runs
  const routeCamerasLayerRef = useRef(L.layerGroup()); // cameras near the selected route
  const routeCamerasRef = useRef({ items: [], markers: [], passed: 0, req: 0 });
  // community reports
  const reportsLayerRef = useRef(null);
  const reportMarkersRef = useRef(new Map());
  const viewportRowsRef = useRef([]);
  const routeRowsRef = useRef([]);
  const mineRowsRef = useRef([]);
  const dismissedIdsRef = useRef(new Set());
  const reportsReqRef = useRef(0);
  const reportApiRef = useRef({});
  const reportPhaseRef = useRef('idle');
  const placingReportRef = useRef(false);
  const draftMarkerRef = useRef(null);
  const draftLatLngRef = useRef(null);
  const reportRequestIdRef = useRef(null);
  const locateSeqRef = useRef(0);
  const justDraggedRef = useRef(0);
  const prevPovRef = useRef(null);
  const reportToastTimerRef = useRef(null);
  const routeActiveRef = useRef(false);
  const alertsOnRef = useRef(true);
  const busLayerRef = useRef(L.layerGroup());   // live bus markers (Bus mode only)
  const busesRef = useRef(new Map());           // latest feed data, key -> bus
  const busMarkersRef = useRef(new Map());      // key -> labelled L.marker
  const busDotsRef = useRef(new Map());         // key -> light canvas dot (very crowded views)
  const busCanvasRef = useRef(null);

  const [theme, setTheme] = useState(() => localStorage.getItem('geodesic-theme') || 'light');
  const [screen, setScreen] = useState('search');
  const [mapType, setMapType] = useState('street');
  const [povMode, setPovMode] = useState('north');
  const [reportPhase, setReportPhase] = useState('idle'); // idle | menu | locating | failed | draft | saving
  const [reportCategory, setReportCategory] = useState(null);
  const [reportDesc, setReportDesc] = useState('');
  const [reportError, setReportError] = useState('');
  const [reportControlsVisible, setReportControlsVisible] = useState(true);
  const [reportFailInfo, setReportFailInfo] = useState(null);
  const [reportDraftInfo, setReportDraftInfo] = useState(null);
  const [reportToast, setReportToast] = useState('');
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
  const [routeActive, setRouteActive] = useState(false);  // a route is currently shown (preview / drive)
  const [busStatus, setBusStatus] = useState('idle');     // idle | loading | live | error

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
    // Stacking: route lines (overlayPane 400) < buses 585 < route cameras 590 < live-location / group markers (markerPane 600)
    map.createPane('busPane').style.zIndex = '585';
    map.createPane('routeCameras').style.zIndex = '590';
    map.createPane('reports').style.zIndex = '588';
    map.createPane('reportDraft').style.zIndex = '650';

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
    const showCity = alertsOn && !(HIDE_CITY_CAMERAS_DURING_ROUTE && routeActive);
    if (showCity) camerasLayerRef.current.addTo(mapRef.current);
    else mapRef.current.removeLayer(camerasLayerRef.current);
    if (alertsOn) routeCamerasLayerRef.current.addTo(mapRef.current);
    else mapRef.current.removeLayer(routeCamerasLayerRef.current);
  }, [alertsOn, routeActive]);

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

  // --- Route progress: grey travelled / blue remaining lines (drive mode only) ---
  // The full route stays untouched in selectedRouteRef / routeProgressRef.coords.
  // Only the two display polylines are updated, with setLatLngs().
  const setPreviewRouteVisible = (visible) => {
    const map = mapRef.current;
    if (!map) return;
    if (visible) {
      (previewLineStylesRef.current || []).forEach(([poly, opacity]) => poly.setStyle({ opacity }));
      previewLineStylesRef.current = null;
      return;
    }
    if (previewLineStylesRef.current) return;
    const saved = [];
    map.eachLayer((layer) => {
      if (layer instanceof L.Routing.Line) {
        layer.eachLayer((poly) => {
          saved.push([poly, poly.options.opacity]);
          poly.setStyle({ opacity: 0 });
        });
      }
    });
    previewLineStylesRef.current = saved;
  };

  const clearRouteProgress = () => {
    if (progressLinesRef.current) {
      mapRef.current?.removeLayer(progressLinesRef.current.travelled);
      mapRef.current?.removeLayer(progressLinesRef.current.remaining);
      progressLinesRef.current = null;
    }
    routeProgressRef.current = null;
    resetRouteCameraDimming();
    setPreviewRouteVisible(true);
  };

  const renderRouteProgress = () => {
    const p = routeProgressRef.current;
    if (!p || !mapRef.current) return;
    if (!progressLinesRef.current) {
      const base = { interactive: false, lineCap: 'round', lineJoin: 'round', weight: 8 };
      progressLinesRef.current = {
        travelled: L.polyline([], { ...base, color: '#6B7280', opacity: 0.9 }).addTo(mapRef.current),
        remaining: L.polyline([], { ...base, color: '#3b82f6', opacity: 1 }).addTo(mapRef.current),
      };
    }
    const { travelled, remaining } = progressPolylines(p);
    progressLinesRef.current.travelled.setLatLngs(travelled);
    progressLinesRef.current.remaining.setLatLngs(remaining);
    updatePassedRouteCameras(p.along);
  };

  const startRouteProgress = (route, userLatLng) => {
    clearRouteProgress();
    if (!route.coordinates || route.coordinates.length < 2) return;
    setPreviewRouteVisible(false);
    routeProgressRef.current = buildRouteProgress(route.coordinates);
    advanceRouteProgress(routeProgressRef.current, userLatLng, 0);
    renderRouteProgress();
  };

  const updateRouteProgress = (userLatLng, accuracy) => {
    const p = routeProgressRef.current;
    if (p && advanceRouteProgress(p, userLatLng, accuracy)) renderRouteProgress();
  };

  // --- Cameras near the selected route (matched once per route, not per GPS fix) ---
  const clearRouteCameras = () => {
    const rc = routeCamerasRef.current;
    rc.req += 1; // invalidates any lookup still in flight
    routeCamerasLayerRef.current.clearLayers();
    rc.items = [];
    rc.markers = [];
    rc.passed = 0;
  };

  const resetRouteCameraDimming = () => {
    const rc = routeCamerasRef.current;
    rc.markers.forEach((m) => m.setOpacity(1));
    rc.passed = 0;
  };

  // Cameras already behind the user are dimmed (not removed); the ones ahead stay full strength.
  const updatePassedRouteCameras = (along) => {
    const rc = routeCamerasRef.current;
    while (rc.passed < rc.items.length && rc.items[rc.passed].along < along - 15) {
      rc.markers[rc.passed].setOpacity(0.4);
      rc.passed += 1;
    }
  };

  const renderRouteCameras = (matched) => {
    const rc = routeCamerasRef.current;
    rc.items = matched;
    rc.markers = matched.map(({ camera }) => {
      const color = CAMERA_COLORS[camera.camera_type] || CAMERA_COLORS.unknown;
      const marker = L.marker([camera.latitude, camera.longitude], {
        pane: 'routeCameras',
        keyboard: false,
        icon: L.divIcon({
          className: 'route-camera-icon',
          html: `<div class="route-camera-pin" style="background:${color}">${CCTV_SVG}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      }).bindPopup(routeCameraPopupHtml(camera));
      routeCamerasLayerRef.current.addLayer(marker);
      return marker;
    });
    rc.passed = 0;
    if (routeProgressRef.current) updatePassedRouteCameras(routeProgressRef.current.along);
  };

  const updateRouteCameras = async (route) => {
    clearRouteCameras();
    const token = routeCamerasRef.current.req;
    const coords = route?.coordinates;
    if (!coords || coords.length < 2) return;
    try {
      // Ask Supabase only for cameras inside the route's bounding box, then match exactly.
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      coords.forEach((c) => {
        if (c.lat < minLat) minLat = c.lat;
        if (c.lat > maxLat) maxLat = c.lat;
        if (c.lng < minLng) minLng = c.lng;
        if (c.lng > maxLng) maxLng = c.lng;
      });
      const padLat = 0.0012;
      const padLng = padLat / Math.cos(((minLat + maxLat) / 2 * Math.PI) / 180);
      const rows = [];
      for (let from = 0; from < 10000; from += 1000) {
        const { data, error } = await supabase
          .from('cameras')
          .select(ROUTE_CAMERA_FIELDS)
          .eq('city', 'Delhi')
          .gte('latitude', minLat - padLat).lte('latitude', maxLat + padLat)
          .gte('longitude', minLng - padLng).lte('longitude', maxLng + padLng)
          .order('id')
          .range(from, from + 999);
        if (token !== routeCamerasRef.current.req) return; // route changed meanwhile
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const { cum } = buildRouteProgress(coords);
      renderRouteCameras(matchCamerasToRoute(coords, cum, rows, ROUTE_CAMERA_MAX_DISTANCE_M));
    } catch (e) {
      console.error('Route cameras unavailable:', e?.message || 'unknown error');
    }
  };

  // --- community reports ------------------------------------------------
  // Leaflet callbacks (map events, popups, draft pin) are created once, so they call through
  // reportApiRef, which is refreshed on every render and never holds stale state.
  routeActiveRef.current = routeActive;
  alertsOnRef.current = alertsOn;

  const showReportToast = (msg) => {
    setReportToast(msg);
    clearTimeout(reportToastTimerRef.current);
    reportToastTimerRef.current = setTimeout(() => setReportToast(''), 5000);
  };

  const goReportPhase = (ph) => {
    reportPhaseRef.current = ph;
    placingReportRef.current = ['locating', 'failed', 'draft', 'saving'].includes(ph);
    setReportPhase(ph);
  };

  const removeDraftMarker = () => {
    if (draftMarkerRef.current) { draftMarkerRef.current.remove(); draftMarkerRef.current = null; }
    draftLatLngRef.current = null;
  };

  const restorePovAfterReport = () => {
    if (prevPovRef.current) { setPovMode(prevPovRef.current); prevPovRef.current = null; }
  };

  // Back to IDLE; nothing is saved.
  const endReporting = () => {
    if (reportPhaseRef.current === 'saving') return;
    locateSeqRef.current += 1; // ignore any GPS answer still on its way
    removeDraftMarker();
    reportRequestIdRef.current = null;
    setReportCategory(null);
    setReportDesc('');
    setReportError('');
    setReportFailInfo(null);
    setReportDraftInfo(null);
    setReportControlsVisible(true);
    goReportPhase('idle');
    restorePovAfterReport();
  };

  const handleReportButton = () => {
    const ph = reportPhaseRef.current;
    if (ph === 'saving') { showReportToast('Saving your report… please wait.'); return; }
    if (ph === 'idle') { goReportPhase('menu'); return; }
    endReporting();
  };

  const startDraft = (catId, latlng, source, accuracy) => {
    const map = mapRef.current;
    if (!map) return;
    removeDraftMarker();
    const marker = L.marker(latlng, {
      pane: 'reportDraft',
      draggable: true,
      autoPan: false,
      keyboard: true,
      zIndexOffset: 1000,
      title: 'Draft report pin. Drag to adjust.',
      icon: L.divIcon({ className: 'report-draft-icon', html: draftPinHtml(catId), iconSize: [48, 60], iconAnchor: [24, 60] }),
    }).addTo(map);
    marker.on('dragstart', () => reportApiRef.current.onDraftDragStart());
    marker.on('dragend', () => reportApiRef.current.onDraftDragEnd());
    marker.on('click', () => reportApiRef.current.onDraftTap());
    draftMarkerRef.current = marker;
    draftLatLngRef.current = latlng;
    reportRequestIdRef.current = newRequestId();
    setReportCategory(catId);
    setReportDraftInfo({ source, accuracy: accuracy == null ? null : accuracy });
    setReportError('');
    setReportFailInfo(null);
    setReportControlsVisible(true);
    goReportPhase('draft');
    map.setView(latlng, Math.max(map.getZoom(), 16), { animate: true });
  };

  const failLocation = (catId, message, fix, accuracy) => {
    setReportFailInfo({ id: catId, message, fix, accuracy });
    goReportPhase('failed');
  };

  const pickReportCategory = (catId) => {
    if (reportPhaseRef.current !== 'menu') return;
    setReportCategory(catId);
    setReportDesc('');
    setReportError('');
    // Rotated (heading-up) maps cannot drag markers reliably: switch to north-up while placing.
    if (povMode === 'heading' && !prevPovRef.current) { prevPovRef.current = 'heading'; setPovMode('north'); }
    goReportPhase('locating');
    const seq = ++locateSeqRef.current;
    if (!navigator.geolocation) { failLocation(catId, 'This browser has no location support.', null, null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (seq !== locateSeqRef.current) return;
        const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
        const acc = pos.coords.accuracy;
        const age = pos.timestamp ? Date.now() - pos.timestamp : 0;
        if (age > REPORT_FIX_MAX_AGE_MS) { failLocation(catId, 'Your location reading is out of date.', ll, acc); return; }
        if (acc > REPORT_FIX_MAX_ACCURACY_M) { failLocation(catId, `Your location is only accurate to about ±${Math.round(acc)} m.`, ll, acc); return; }
        startDraft(catId, ll, 'gps', acc);
      },
      (err) => {
        if (seq !== locateSeqRef.current) return;
        const msg = err && err.code === 1
          ? 'Location permission is off. Allow location for this site to start at your position.'
          : err && err.code === 3 ? 'Getting your location took too long.' : 'Your location is unavailable right now.';
        failLocation(catId, msg, null, null);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  };

  const submitDraft = async () => {
    if (reportPhaseRef.current !== 'draft') return;
    const ll = draftLatLngRef.current;
    const cat = reportCategory;
    if (!ll || !cat) return;
    const desc = cat === 'other' ? reportDesc.trim().slice(0, REPORT_DESC_MAX) : null;
    goReportPhase('saving');
    setReportError('');
    if (draftMarkerRef.current) draftMarkerRef.current.dragging.disable();
    try {
      const { data, error } = await withTimeout(
        supabase.rpc('create_report', {
          p_category: cat,
          p_lat: ll.lat,
          p_lng: ll.lng,
          p_description: desc || null,
          p_request_id: reportRequestIdRef.current,
          p_position_source: reportDraftInfo?.source || 'gps',
          p_accuracy_m: reportDraftInfo?.accuracy ?? null,
        }),
        REPORT_SAVE_TIMEOUT_MS
      );
      if (error) throw error;
      showReportToast(data?.merged ? 'This is already reported here. It is on the map.' : 'Report saved. Thank you!');
      removeDraftMarker();
      reportRequestIdRef.current = null;
      setReportCategory(null);
      setReportDesc('');
      setReportDraftInfo(null);
      setReportControlsVisible(true);
      goReportPhase('idle');
      restorePovAfterReport();
      loadMyReports();
      loadReports();
    } catch (e) {
      if (draftMarkerRef.current) draftMarkerRef.current.dragging.enable();
      setReportError(
        e && e.timeout
          ? 'Not confirmed: the connection was slow, so we cannot tell if it saved. Tap Place here to retry. It will not create a duplicate.'
          : reportErrorText(e, 'Could not save your report. Check your connection and try again.')
      );
      setReportControlsVisible(true);
      goReportPhase('draft');
    }
  };

  // ---- saved reports on the map ----
  const syncReportMarkers = () => {
    const layer = reportsLayerRef.current;
    if (!layer) return;
    const showCams = alertsOnRef.current;
    const want = new Map();
    [...viewportRowsRef.current, ...routeRowsRef.current].forEach((r) => {
      if (dismissedIdsRef.current.has(r.id)) return;
      if (r.category === 'speed_camera' && !showCams && !r.is_mine) return; // Camera alerts off hides cameras only
      want.set(r.id, r);
    });
    mineRowsRef.current.forEach((r) => { if (!want.has(r.id) && !dismissedIdsRef.current.has(r.id)) want.set(r.id, r); });

    const existing = reportMarkersRef.current;
    want.forEach((r, id) => {
      const sig = `${r.status}|${r.confirms}|${r.denies}|${r.my_vote || ''}|${r.is_mine ? 1 : 0}`;
      let m = existing.get(id);
      if (!m) {
        const cat = REPORT_CATEGORY_BY_ID[r.category] || REPORT_CATEGORY_BY_ID.other;
        m = L.marker([r.latitude, r.longitude], { pane: 'reports', icon: reportMarkerIcon(r), title: cat.label, alt: cat.label, keyboard: true });
        const mk = m;
        mk.bindPopup(() => reportApiRef.current.buildPopup(mk._report), { minWidth: 210, maxWidth: 260 });
        layer.addLayer(mk);
        existing.set(id, mk);
        mk._sig = sig;
      } else if (m._sig !== sig) {
        m.setIcon(reportMarkerIcon(r));
        m._sig = sig;
      }
      m._report = r;
    });
    existing.forEach((m, id) => { if (!want.has(id)) { layer.removeLayer(m); existing.delete(id); } });
  };

  const loadReports = async (opts = {}) => {
    const map = mapRef.current;
    if (!map) return;
    const token = ++reportsReqRef.current;
    const route = 'route' in opts ? opts.route : (routeActiveRef.current ? selectedRouteRef.current : null);
    const coords = route && route.coordinates;
    try {
      if (coords && coords.length > 1) {
        // Route mode: every category, only within REPORT_ROUTE_MAX_DISTANCE_M of the route.
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        coords.forEach((c) => {
          if (c.lat < minLat) minLat = c.lat;
          if (c.lat > maxLat) maxLat = c.lat;
          if (c.lng < minLng) minLng = c.lng;
          if (c.lng > maxLng) maxLng = c.lng;
        });
        const padLat = 0.0015;
        const padLng = padLat / Math.cos(((minLat + maxLat) / 2 * Math.PI) / 180);
        const { data, error } = await supabase.rpc('get_reports_in_bbox', {
          p_min_lat: minLat - padLat, p_min_lng: minLng - padLng, p_max_lat: maxLat + padLat, p_max_lng: maxLng + padLng,
          p_categories: null, p_limit: 1000,
        });
        if (token !== reportsReqRef.current) return;
        if (error) throw error;
        const { cum } = buildRouteProgress(coords);
        routeRowsRef.current = matchCamerasToRoute(coords, cum, data || [], REPORT_ROUTE_MAX_DISTANCE_M).map((m) => m.camera);
        viewportRowsRef.current = [];
      } else {
        // No route: only speed cameras, for the visible area.
        routeRowsRef.current = [];
        if (map.getZoom() < REPORT_MIN_ZOOM) {
          viewportRowsRef.current = [];
        } else {
          const b = map.getBounds();
          const { data, error } = await supabase.rpc('get_reports_in_bbox', {
            p_min_lat: b.getSouth(), p_min_lng: b.getWest(), p_max_lat: b.getNorth(), p_max_lng: b.getEast(),
            p_categories: ['speed_camera'], p_limit: 1000,
          });
          if (token !== reportsReqRef.current) return;
          if (error) throw error;
          viewportRowsRef.current = data || [];
        }
      }
      syncReportMarkers();
    } catch (e) {
      console.error('Reports unavailable:', (e && e.message) || 'unknown error');
    }
  };

  const loadMyReports = async () => {
    try {
      const { data, error } = await supabase.rpc('get_my_reports');
      if (error) throw error;
      mineRowsRef.current = data || [];
      syncReportMarkers();
    } catch (e) {
      console.error('My reports unavailable:', (e && e.message) || 'unknown error');
    }
  };

  const getFreshFix = () =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('no-geolocation')); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(L.latLng(pos.coords.latitude, pos.coords.longitude)),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
      );
    });

  const voteOnReport = async (r, vote) => {
    let here;
    try { here = await getFreshFix(); } catch (e) { showReportToast('Turn on location to answer. We only accept answers from people near the report.'); return; }
    if (here.distanceTo(L.latLng(r.latitude, r.longitude)) > REPORT_VOTE_RADIUS_M) {
      showReportToast(`Get within ${REPORT_VOTE_RADIUS_M} m of this report to answer.`);
      return;
    }
    const { error } = await supabase.rpc('vote_report', { p_report_id: r.id, p_vote: vote, p_lat: here.lat, p_lng: here.lng });
    if (error) { showReportToast(reportErrorText(error, 'Could not send your answer. Try again.')); return; }
    if (mapRef.current) mapRef.current.closePopup();
    showReportToast('Thanks, your answer was saved.');
    loadReports();
    loadMyReports();
  };

  const hideReportForMe = async (r) => {
    const { error } = await supabase.rpc('dismiss_report', { p_report_id: r.id });
    if (error) { showReportToast(reportErrorText(error, 'Could not hide this report. Try again.')); return; }
    dismissedIdsRef.current.add(r.id);
    if (mapRef.current) mapRef.current.closePopup();
    syncReportMarkers();
    showReportToast('Hidden for you. Other people still see it.');
  };

  // Popup content is built with DOM nodes and textContent, so report text can never inject HTML.
  const buildReportPopup = (r) => {
    const cat = REPORT_CATEGORY_BY_ID[r.category] || REPORT_CATEGORY_BY_ID.other;
    const root = document.createElement('div');
    root.className = 'report-popup';
    const head = document.createElement('div');
    head.className = 'report-popup-head';
    const badge = document.createElement('span');
    badge.className = 'report-popup-badge';
    badge.style.background = cat.color;
    badge.innerHTML = reportIconSvg(r.category, 16); // constant SVG from reportIcons.js
    const title = document.createElement('strong');
    title.textContent = cat.label;
    head.append(badge, title);
    root.appendChild(head);
    const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; root.appendChild(d); return d; };
    if (r.description) line('report-popup-desc', r.description);
    const statusText = {
      unconfirmed: 'Community-reported · not yet confirmed',
      community_confirmed: 'Community-confirmed',
      dimmed: 'Possibly gone: several people say it is not there',
    }[r.status] || 'Community-reported';
    line('report-popup-status', statusText);
    line('report-popup-meta', `Last seen ${reportAgo(r.last_confirmed_at || r.created_at)} · ${r.confirms} still there · ${r.denies} not there`);
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; b.onclick = fn; return b; };
    if (r.is_mine) {
      line('report-popup-note', 'This is your report. Other people can confirm it.');
    } else if (r.my_vote) {
      line('report-popup-note', `You answered: ${r.my_vote === 'confirm' ? 'still there' : 'not there'}.`);
    } else {
      line('report-popup-q', 'Is it still there?');
      const row = document.createElement('div');
      row.className = 'report-popup-actions';
      row.append(
        btn('Still there', 'report-btn primary small', () => reportApiRef.current.vote(r, 'confirm')),
        btn('Not there', 'report-btn small', () => reportApiRef.current.vote(r, 'deny'))
      );
      root.appendChild(row);
    }
    if (!r.is_mine) root.appendChild(btn('Hide for me', 'report-link', () => reportApiRef.current.hideForMe(r)));
    line('report-popup-disclaimer', 'Community reports can be wrong. Always follow road signs and traffic rules.');
    return root;
  };

  reportApiRef.current = {
    loadReports,
    loadMyReports,
    endReporting,
    buildPopup: buildReportPopup,
    vote: voteOnReport,
    hideForMe: hideReportForMe,
    onDraftDragStart: () => { justDraggedRef.current = Date.now(); },
    onDraftDragEnd: () => {
      const m = draftMarkerRef.current;
      if (!m) return;
      draftLatLngRef.current = m.getLatLng();
      justDraggedRef.current = Date.now();
      setReportDraftInfo((i) => ({ ...(i || {}), source: i && i.source === 'manual' ? 'manual' : 'adjusted' }));
      setReportControlsVisible(true);
    },
    onDraftTap: () => {
      if (reportPhaseRef.current === 'draft' && Date.now() - justDraggedRef.current > 400) setReportControlsVisible(true);
    },
    // A tap on the bare map hides Place here / Cancel. It never moves, saves or deletes the draft.
    onMapClick: () => {
      if (reportPhaseRef.current === 'draft' && Date.now() - justDraggedRef.current > 400) setReportControlsVisible(false);
    },
    onPopupOpen: () => {
      if (reportPhaseRef.current === 'draft') setReportControlsVisible(false);
    },
  };

  // Map listeners, periodic refresh, first load.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    if (!reportsLayerRef.current) reportsLayerRef.current = L.layerGroup();
    reportsLayerRef.current.addTo(map);
    let moveTimer = null;
    const onMove = () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => { if (!routeActiveRef.current) reportApiRef.current.loadReports(); }, 600);
    };
    const onClick = () => reportApiRef.current.onMapClick();
    const onPopup = () => reportApiRef.current.onPopupOpen();
    map.on('moveend', onMove);
    map.on('click', onClick);
    map.on('popupopen', onPopup);
    const iv = setInterval(() => reportApiRef.current.loadReports(), REPORT_REFRESH_MS);
    return () => {
      clearTimeout(moveTimer);
      clearInterval(iv);
      clearTimeout(reportToastTimerRef.current);
      reportsReqRef.current += 1;
      map.off('moveend', onMove);
      map.off('click', onClick);
      map.off('popupopen', onPopup);
    };
  }, []);

  // Reload once the (guest or real) session exists, and again if the user changes.
  useEffect(() => {
    if (!authUser) return;
    dismissedIdsRef.current = new Set();
    reportApiRef.current.loadReports();
    reportApiRef.current.loadMyReports();
  }, [authUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Camera alerts checkbox shows/hides speed cameras (imported + reported).
  useEffect(() => { syncReportMarkers(); }, [alertsOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reporting only exists on the search and drive screens.
  useEffect(() => {
    if (screen !== 'search' && screen !== 'drive' && reportPhaseRef.current !== 'idle' && reportPhaseRef.current !== 'saving') {
      reportApiRef.current.endReporting();
    }
  }, [screen]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && reportPhaseRef.current !== 'idle' && reportPhaseRef.current !== 'saving') reportApiRef.current.endReporting();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Leaving the route view (Back to search) cancels the route cameras.
  useEffect(() => {
    if (screen === 'search') {
      clearRouteCameras();
      setRouteActive(false);
      loadReports({ route: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => () => { routeCamerasRef.current.req += 1; }, []);

  // --- Live Delhi buses (only while Bus mode is selected) ---
  const clearBuses = () => {
    busLayerRef.current.clearLayers();
    busMarkersRef.current.clear();
    busDotsRef.current.clear();
    busesRef.current = new Map();
    mapRef.current?.removeLayer(busLayerRef.current);
  };

  const busIcon = (label) =>
    L.divIcon({
      className: 'bus-marker-icon',
      html: `<div class="bus-marker">${label ? `<span class="bus-label">${escapeHtml(label)}</span>` : ''}<span class="bus-glyph">🚌</span></div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 32],
    });

  // Draws buses inside the (padded) view. Few buses -> labelled icons. Very crowded view
  // (e.g. whole Delhi) -> light canvas dots, so nothing is discarded and the browser stays fast.
  const renderBuses = () => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds().pad(0.3);
    const visible = [];
    busesRef.current.forEach((b, key) => {
      if (bounds.contains([b.latitude, b.longitude])) visible.push([key, b]);
    });
    const detailed = visible.length <= BUS_DETAIL_MAX;
    const wanted = new Set(visible.map(([key]) => key));
    const markers = busMarkersRef.current;
    const dots = busDotsRef.current;
    const layer = busLayerRef.current;

    markers.forEach((m, key) => { if (!detailed || !wanted.has(key)) { layer.removeLayer(m); markers.delete(key); } });
    dots.forEach((d, key) => { if (detailed || !wanted.has(key)) { layer.removeLayer(d); dots.delete(key); } });

    visible.forEach(([key, b]) => {
      const latlng = [b.latitude, b.longitude];
      const popup = () => busPopupHtml(busesRef.current.get(key) || b);
      if (detailed) {
        const label = busLabel(b);
        const existing = markers.get(key);
        if (existing) {
          existing.setLatLng(latlng);
          if (existing._busLabel !== label) { existing.setIcon(busIcon(label)); existing._busLabel = label; }
        } else {
          const m = L.marker(latlng, { icon: busIcon(label), pane: 'busPane', keyboard: false }).bindPopup(popup);
          m._busLabel = label;
          layer.addLayer(m);
          markers.set(key, m);
        }
      } else {
        const existing = dots.get(key);
        if (existing) {
          existing.setLatLng(latlng);
        } else {
          if (!busCanvasRef.current) busCanvasRef.current = L.canvas({ pane: 'busPane' });
          const d = L.circleMarker(latlng, {
            renderer: busCanvasRef.current, radius: 4, weight: 1, color: '#ffffff', fillColor: '#0d9488', fillOpacity: 0.9,
          }).bindPopup(popup);
          layer.addLayer(d);
          dots.set(key, d);
        }
      }
    });
  };

  useEffect(() => {
    const map = mapRef.current;
    if (transportMode !== 'bus' || !map) return undefined;
    let cancelled = false;
    let inFlight = false;
    let moveTimer = null;
    busLayerRef.current.addTo(map);
    setBusStatus('loading');

    const load = async () => {
      if (inFlight) return; // never overlap requests
      inFlight = true;
      try {
        const { data, error } = await supabase.functions.invoke('delhi-bus-positions');
        if (cancelled) return;
        if (error || !data || !Array.isArray(data.vehicles)) throw new Error('unavailable');
        const next = normalizeBusVehicles(data.vehicles);
        if (next.size === 0) throw new Error('unavailable');
        busesRef.current = next;
        setBusStatus('live');
        renderBuses();
      } catch {
        if (cancelled) return;
        clearBuses();
        busLayerRef.current.addTo(map);
        setBusStatus('error');
      } finally {
        inFlight = false;
      }
    };

    const onMove = () => { clearTimeout(moveTimer); moveTimer = setTimeout(renderBuses, 200); };
    map.on('moveend', onMove);
    load();
    const timer = setInterval(load, BUS_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(moveTimer);
      map.off('moveend', onMove);
      clearBuses();
      setBusStatus('idle');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportMode]);

  const applyRouteSelection = (route) => {
    clearRouteProgress(); // new route selected: drop old progress, show it fully blue
    setRouteActive(true);
    updateRouteCameras(route); // cameras near THIS route (replaces any previous set)
    loadReports({ route });
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
    // Smooth fly to the live location at driving zoom. GPS panning is paused
    // until the flight ends, because panTo()/setView() would cancel it midway.
    flyingRef.current = true;
    mapRef.current.flyTo([initialPoint.lat, initialPoint.lng], NAV_ZOOM, { animate: true, duration: 1.2 });
    mapRef.current.once('moveend', () => { flyingRef.current = false; });
    setTimeout(() => { flyingRef.current = false; }, 1600);
    startRouteProgress(route, initialPoint);

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
    clearRouteProgress();
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
          // follow the user, keep whatever zoom they have (and don't interrupt the flyTo)
          if (!flyingRef.current && !placingReportRef.current) mapRef.current.panTo(coords, { animate: true, duration: 0.5 });
          updateRouteProgress(coords, position.coords.accuracy);
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
    <>
      <div className="mode-row">
        {TRANSPORT_ORDER.map((mode) => (
          <button key={mode} type="button" className={`mode-btn ${transportMode === mode ? 'active' : ''}`} onClick={() => handleModeChange(mode)}>
            <span className="mode-icon">{TRANSPORT_PROFILES[mode].icon}</span>
            <span className="mode-label">{TRANSPORT_PROFILES[mode].label}</span>
          </button>
        ))}
      </div>
      {transportMode === 'bus' && busStatus === 'error' && <div className="toast">Live bus data temporarily unavailable.</div>}
    </>
  );

  const reportActive = reportPhase !== 'idle';
  const reportDriveClass = screen === 'drive' ? 'drive-pos' : '';
  const reportCatLabel = (REPORT_CATEGORY_BY_ID[reportCategory] || {}).label || '';
  const reportSaving = reportPhase === 'saving';
  const reportHint =
    !reportDraftInfo ? ''
      : reportDraftInfo.source === 'gps'
        ? `Your phone's GPS position${reportDraftInfo.accuracy ? ` (about ±${Math.round(reportDraftInfo.accuracy)} m)` : ''}. Drag the pin to adjust it.`
        : reportDraftInfo.source === 'adjusted'
          ? 'Position adjusted by you. Drag the pin to change it.'
          : 'Placed manually on the map. Drag the pin onto the right spot.';

  const reportButton = (drivePos) => (
    <button
      className={`fab report-fab ${drivePos ? 'drive-pos' : ''} ${reportActive ? 'active' : ''}`}
      type="button"
      onClick={handleReportButton}
      aria-pressed={reportActive}
      aria-label={reportActive ? 'Cancel reporting' : 'Report a camera or hazard'}
      title={reportActive ? 'Cancel reporting' : 'Report'}
    >
      <span dangerouslySetInnerHTML={{ __html: iconSvg(REPORT_BUTTON_ICON_INNER, 24, 'currentColor') }} />
    </button>
  );

  const reportOverlays = (
    <>
      {(screen === 'search' || screen === 'drive') && reportPhase === 'menu' && (
        <div className={`report-menu ${reportDriveClass}`} role="menu" aria-label="Choose what to report">
          {REPORT_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="report-cat"
              style={{ background: c.color }}
              aria-label={c.label}
              title={c.label}
              onClick={() => pickReportCategory(c.id)}
              dangerouslySetInnerHTML={{ __html: reportIconSvg(c.id, 26) }}
            />
          ))}
        </div>
      )}

      {reportPhase === 'locating' && (
        <div className={`report-panel ${reportDriveClass}`} role="status">
          <div className="report-panel-text">Getting your location…</div>
          <div className="report-panel-actions">
            <button type="button" className="report-btn" onClick={endReporting}>Cancel</button>
          </div>
        </div>
      )}

      {reportPhase === 'failed' && reportFailInfo && (
        <div className={`report-panel ${reportDriveClass}`} role="alert">
          <div className="report-panel-text">{reportFailInfo.message}</div>
          <div className="report-panel-hint">GPS can be off by tens of metres, so always check the pin before saving.</div>
          <div className="report-panel-actions">
            <button type="button" className="report-btn primary" onClick={() => startDraft(reportFailInfo.id, mapRef.current.getCenter(), 'manual', null)}>Place manually</button>
            {reportFailInfo.fix && (
              <button type="button" className="report-btn" onClick={() => startDraft(reportFailInfo.id, reportFailInfo.fix, 'gps', reportFailInfo.accuracy)}>Use anyway</button>
            )}
            <button type="button" className="report-btn" onClick={endReporting}>Cancel</button>
          </div>
        </div>
      )}

      {(reportPhase === 'draft' || reportSaving) && reportControlsVisible && (
        <div className={`report-panel ${reportDriveClass}`} role="group" aria-label={`Place report: ${reportCatLabel}`}>
          <div className="report-panel-text">{reportCatLabel}</div>
          {reportCategory === 'other' && (
            <input
              className="report-desc"
              type="text"
              maxLength={REPORT_DESC_MAX}
              placeholder="Short description (optional)"
              aria-label="Short description (optional)"
              value={reportDesc}
              disabled={reportSaving}
              onChange={(e) => setReportDesc(e.target.value)}
            />
          )}
          <div className="report-panel-hint">{reportHint}</div>
          {reportError && <div className="report-panel-error" role="alert">{reportError}</div>}
          <div className="report-panel-actions">
            <button type="button" className="report-btn primary" disabled={reportSaving} onClick={submitDraft}>{reportSaving ? 'Saving…' : 'Place here'}</button>
            <button type="button" className="report-btn" disabled={reportSaving} onClick={endReporting}>Cancel</button>
          </div>
        </div>
      )}

      {reportToast && <div className="report-toast" role="status">{reportToast}</div>}
    </>
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
          {reportButton(false)}
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
            {routeSummary.simulated && (
              <div className="simulated-note">
                {busStatus === 'live' ? 'Estimated trip time — live bus positions shown on the map' : 'Estimated — no live transit data available'}
              </div>
            )}
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
          {reportButton(true)}
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
      {reportOverlays}
    </>
  );
}

export default App;
