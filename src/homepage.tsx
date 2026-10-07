import { useEffect, useState } from 'react';
import { Marker, Popup } from 'react-leaflet';
import { MapView } from './components/MapView';
import { CameraLayer } from './components/CameraLayer';
import { GroupTravelPanel } from './components/GroupTravelPanel';
import { RouteMismatchBanner } from './components/RouteMismatchBanner';
import { useCameras } from './hooks/useCameras';
import { useGroupTravel } from './hooks/useGroupTravel';
import { useAuth } from './context/AuthContext';
import { supabase } from './lib/supabase';

const DELHI_CENTER: [number, number] = [28.6139, 77.209];

// NOTE on scope: this is a minimal origin/destination capture, not a full
// turn-by-turn routing engine. It's enough for group-travel + route-mismatch
// logic to work meaningfully. Wiring in real turn-by-turn directions on top
// of this `routes` row is a separate follow-up.
async function geocode(place: string): Promise<[number, number] | null> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=en&countrycodes=in&q=${encodeURIComponent(
      place
    )}`
  );
  const results = await res.json();
  if (!results.length) return null;
  return [Number(results[0].lat), Number(results[0].lon)];
}

export default function HomePage() {
  const { user } = useAuth();
  const [alertsOn, setAlertsOn] = useState(true);
  const [destination, setDestination] = useState('');
  const [routeId, setRouteId] = useState<string | null>(null);
  const [myPosition, setMyPosition] = useState<[number, number] | null>(null);
  const [routeMessage, setRouteMessage] = useState<string | null>(null);
  const { cameras } = useCameras();
  const group = useGroupTravel(user?.id ?? null);

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      setMyPosition([pos.coords.latitude, pos.coords.longitude]);
    });
  }, []);

  const handleSetDestination = async () => {
    if (!destination.trim()) {
      setRouteMessage('Type a destination first.');
      return;
    }

    if (!user) {
      setRouteMessage('Please wait a moment while your session loads.');
      return;
    }

    setRouteMessage(null);

    const origin = myPosition ?? DELHI_CENTER;
    const dest = await geocode(destination.trim());
    if (!dest) {
      setRouteMessage('We could not find that destination. Try a nearby place name.');
      return;
    }

    const { data, error } = await supabase
      .from('routes')
      .insert({
        created_by: user.id,
        origin: `SRID=4326;POINT(${origin[1]} ${origin[0]})`,
        destination: `SRID=4326;POINT(${dest[1]} ${dest[0]})`,
        city: 'Delhi',
      })
      .select('id')
      .single();

    if (error) {
      setRouteMessage(error.message || 'Route creation failed.');
      return;
    }

    if (data) {
      setRouteId(data.id);
      setRouteMessage('Route ready.');
    }
  };

  return (
    <div className="app-shell">
      <MapView center={myPosition ?? DELHI_CENTER}>
        {alertsOn && <CameraLayer cameras={cameras} />}
        {myPosition && (
          <Marker position={myPosition}>
            <Popup>You</Popup>
          </Marker>
        )}
        {Object.values(group.memberLocations)
          .filter((m) => m.user_id !== user?.id)
          .map((m) => (
            <Marker key={m.user_id} position={[m.latitude, m.longitude]}>
              <Popup>Group member</Popup>
            </Marker>
          ))}
      </MapView>

      <div className="top-bar">
        <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Where to?" />
        <button onClick={handleSetDestination}>Go</button>
        <label className="toggle">
          <input type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} />
          Camera alerts
        </label>
      </div>

      {routeMessage && <p className="route-message">{routeMessage}</p>}

      <RouteMismatchBanner group={group} myRouteId={routeId} />
      <GroupTravelPanel routeId={routeId} group={group} />
    </div>
  );
}
