import { CircleMarker, Popup } from 'react-leaflet';
import type { Camera } from './hooks/useCameras';

const COLORS: Record<Camera['camera_type'], string> = {
  speed: '#f97316',
  red_light: '#ef4444',
  average_speed: '#a855f7',
  unknown: '#64748b',
};

export function CameraLayer({ cameras }: { cameras: Camera[] }) {
  return (
    <>
      {cameras.map((camera) => (
        <CircleMarker
          key={camera.id}
          center={[camera.latitude, camera.longitude]}
          radius={7}
          pathOptions={{
            color: COLORS[camera.camera_type],
            fillColor: COLORS[camera.camera_type],
            fillOpacity: camera.confidence === 'low' ? 0.3 : 0.85,
          }}
        >
          <Popup>
            <strong>{camera.camera_type.replace('_', ' ')}</strong>
            <br />
            {camera.road_name ?? 'Road name unknown'}
            <br />
            Source: {camera.source} · Confidence: {camera.confidence}
            {camera.last_verified_at && (
              <>
                <br />
                Last verified: {new Date(camera.last_verified_at).toLocaleDateString()}
              </>
            )}
            <br />
            <small>
              Camera locations are based on public information and OpenStreetMap data. They may be
              incomplete or inaccurate. Always follow traffic rules.
            </small>
          </Popup>
        </CircleMarker>
      ))}
    </>
  );
}
