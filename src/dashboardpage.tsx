import { useMemo, useState } from 'react';
import { MapView } from './components/MapView';
import { CameraLayer } from './components/CameraLayer';
import { useCameras, type Camera } from './hooks/useCameras';

const DELHI_CENTER: [number, number] = [28.6139, 77.209];

// Public, read-only dashboard. No auth, no user data, no group data —
// only the `cameras` table is ever touched here.
export default function DashboardPage() {
  const [cameraType, setCameraType] = useState<Camera['camera_type'] | ''>('');
  const [confidence, setConfidence] = useState<Camera['confidence'] | ''>('');
  const { cameras, loading } = useCameras({
    cameraType: cameraType || undefined,
    confidence: confidence || undefined,
  });

  const corridorCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    cameras.forEach((c) => {
      const key = c.road_name ?? 'Unknown road';
      counts[key] = (counts[key] ?? 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
  }, [cameras]);

  return (
    <div className="dashboard">
      <header>
        <h1>Delhi Road Camera Dashboard</h1>
        <p className="disclaimer">
          Camera locations are based on public information and OpenStreetMap data. They may be
          incomplete or inaccurate. Always follow traffic rules.
        </p>
      </header>

      <div className="dashboard-layout">
        <aside>
          <label>
            Camera type
            <select value={cameraType} onChange={(e) => setCameraType(e.target.value as Camera['camera_type'] | '')}>
              <option value="">All</option>
              <option value="speed">Speed</option>
              <option value="red_light">Red light</option>
              <option value="average_speed">Average speed</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label>
            Confidence
            <select value={confidence} onChange={(e) => setConfidence(e.target.value as Camera['confidence'] | '')}>
              <option value="">All</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>

          <h2>Cameras per road</h2>
          {loading ? (
            <p>Loading...</p>
          ) : (
            <ul>
              {corridorCounts.map(([road, count]) => (
                <li key={road}>
                  {road}: {count}
                </li>
              ))}
            </ul>
          )}
          <p className="count-total">{cameras.length} cameras shown</p>
        </aside>

        <div className="dashboard-map">
          <MapView center={DELHI_CENTER} zoom={11}>
            <CameraLayer cameras={cameras} />
          </MapView>
        </div>
      </div>
    </div>
  );
}
