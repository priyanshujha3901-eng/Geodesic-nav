import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import { useEffect, type ReactNode } from 'react';
import 'leaflet/dist/leaflet.css';

interface MapViewProps {
  center: [number, number];
  zoom?: number;
  children?: ReactNode;
}

function RecenterOnChange({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1]]);
  return null;
}

export function MapView({ center, zoom = 12, children }: MapViewProps) {
  return (
    <MapContainer center={center} zoom={zoom} zoomControl={false} style={{ height: '100%', width: '100%' }}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
      />
      <RecenterOnChange center={center} />
      {children}
    </MapContainer>
  );
}
