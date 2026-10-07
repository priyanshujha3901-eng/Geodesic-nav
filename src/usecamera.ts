import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';

export interface Camera {
  id: string;
  latitude: number;
  longitude: number;
  road_name: string | null;
  city: string;
  camera_type: 'speed' | 'red_light' | 'average_speed' | 'unknown';
  source: 'delhi_police' | 'osm' | 'ogd';
  confidence: 'high' | 'medium' | 'low';
  attribution: string | null;
  source_reference: string | null;
  last_verified_at: string | null;
}

interface Filters {
  cameraType?: Camera['camera_type'];
  confidence?: Camera['confidence'];
}

// Public, read-only — works for guests and logged-in users alike, since the
// `cameras` table has an "allow read: true" RLS policy.
export function useCameras(filters: Filters = {}) {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let query = supabase
      .from('cameras')
      .select(
        'id, latitude, longitude, road_name, city, camera_type, source, confidence, attribution, source_reference, last_verified_at'
      )
      .eq('city', 'Delhi');

    if (filters.cameraType) query = query.eq('camera_type', filters.cameraType);
    if (filters.confidence) query = query.eq('confidence', filters.confidence);

    setLoading(true);
    query.then(({ data, error }) => {
      if (error) console.error('Failed to load cameras:', error.message);
      setCameras((data as Camera[] | null) ?? []);
      setLoading(false);
    });
  }, [filters.cameraType, filters.confidence]);

  return { cameras, loading };
}
