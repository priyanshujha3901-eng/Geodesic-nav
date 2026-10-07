// scripts/import-cameras.mjs
//
// Imports Delhi speed/red-light camera locations from:
//   1. OpenStreetMap, via the Overpass API (primary source)
//   2. Delhi Traffic Police's public RLVD/OSVD camera pages (best-effort —
//      see scrapeDelhiPolice() below; government page structure changes
//      without notice, so this fails soft rather than blocking the OSM import)
//
// Run with: node scripts/import-cameras.mjs
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Set these as GitHub Actions secrets — never commit them, never hardcode them,
// never paste the service-role key into chat/code.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Rough bounding box covering Delhi NCT.
const DELHI_BBOX = { south: 28.4, west: 76.8, north: 28.9, east: 77.4 };

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchOverpassCameras() {
  const { south, west, north, east } = DELHI_BBOX;
  const query = `
    [out:json][timeout:60];
    (
      node["highway"="speed_camera"](${south},${west},${north},${east});
      node["enforcement"](${south},${west},${north},${east});
    );
    out body;
  `;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: query,
  });

  if (!res.ok) throw new Error(`Overpass API request failed: ${res.status}`);
  const data = await res.json();

  return (data.elements ?? []).map((el) => {
    const tags = el.tags ?? {};
    let cameraType = 'unknown';
    if (tags.highway === 'speed_camera' || tags.enforcement === 'maxspeed') cameraType = 'speed';
    else if (tags.enforcement === 'traffic_signals') cameraType = 'red_light';
    else if (tags.enforcement === 'average_speed') cameraType = 'average_speed';

    return {
      latitude: el.lat,
      longitude: el.lon,
      road_name: tags.name ?? tags['addr:street'] ?? null,
      city: 'Delhi',
      state: 'Delhi',
      camera_type: cameraType,
      source: 'osm',
      confidence: 'medium',
      attribution: 'OpenStreetMap contributors',
      source_reference: `https://www.openstreetmap.org/node/${el.id}`,
      last_verified_at: null,
    };
  });
}

// Best-effort scraper for the Delhi Traffic Police RLVD/OSVD public pages.
// NOTE: verify PAGE_URL is current and inspect the live HTML before relying
// on this — if it returns an empty array, update the selectors below rather
// than assuming no cameras exist.
async function scrapeDelhiPolice() {
  const PAGE_URL = 'https://www.delhitrafficpolice.nic.in/rlvd-osvd-cameras'; // verify/update this URL
  try {
    const res = await fetch(PAGE_URL);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const html = await res.text();

    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const results = [];

    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
        m[1].replace(/<[^>]+>/g, '').trim()
      );
      if (cells.length < 2) continue;
      const roadName = cells.find((c) => c.length > 3) ?? null;
      if (!roadName) continue;
      results.push({ roadName, cameraTypeHint: row[1].toLowerCase().includes('rlvd') ? 'red_light' : 'speed' });
    }

    return results;
  } catch (err) {
    console.warn('Delhi Police scraper skipped:', err.message);
    return [];
  }
}

async function geocodeJunction(roadName) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(
    `${roadName}, Delhi, India`
  )}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'geodesic-camera-import/1.0' } });
  if (!res.ok) return null;
  const results = await res.json();
  if (!results.length) return null;
  return { latitude: Number(results[0].lat), longitude: Number(results[0].lon) };
}

async function geocodeDelhiPoliceEntries(entries) {
  const geocoded = [];
  for (const entry of entries) {
    const coords = await geocodeJunction(entry.roadName);
    if (coords) {
      geocoded.push({
        latitude: coords.latitude,
        longitude: coords.longitude,
        road_name: entry.roadName,
        city: 'Delhi',
        state: 'Delhi',
        camera_type: entry.cameraTypeHint,
        source: 'delhi_police',
        confidence: 'medium', // geocoded from a junction name, not GPS-surveyed
        attribution: 'Delhi Traffic Police (public listing)',
        source_reference: 'https://www.delhitrafficpolice.nic.in/rlvd-osvd-cameras',
        last_verified_at: new Date().toISOString(),
      });
    }
    // Respect Nominatim's 1 request/second usage policy.
    await new Promise((r) => setTimeout(r, 1100));
  }
  return geocoded;
}

async function upsertCameras(newCameras) {
  const { data: existing, error: fetchError } = await supabase
    .from('cameras')
    .select('id, latitude, longitude, camera_type')
    .eq('city', 'Delhi');

  if (fetchError) throw new Error(`Failed to read existing cameras: ${fetchError.message}`);

  const toInsert = [];
  let skipped = 0;

  for (const cam of newCameras) {
    const duplicate = (existing ?? []).find(
      (e) => e.camera_type === cam.camera_type && haversineMeters(e.latitude, e.longitude, cam.latitude, cam.longitude) < 30
    );
    if (duplicate) {
      skipped += 1;
      continue;
    }
    toInsert.push({ ...cam, location: `SRID=4326;POINT(${cam.longitude} ${cam.latitude})` });
  }

  console.log(`${toInsert.length} new cameras to insert, ${skipped} duplicates skipped.`);

  const BATCH = 200;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const chunk = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from('cameras').insert(chunk);
    if (error) console.error(`Batch insert failed (rows ${i}-${i + chunk.length}):`, error.message);
  }
}

async function main() {
  console.log('Fetching OSM/Overpass cameras for Delhi...');
  const osmCameras = await fetchOverpassCameras();
  console.log(`Found ${osmCameras.length} candidate cameras from OSM.`);

  console.log('Attempting Delhi Traffic Police camera list...');
  const policeEntries = await scrapeDelhiPolice();
  console.log(`Found ${policeEntries.length} candidate entries from Delhi Police page.`);
  const policeCameras = policeEntries.length ? await geocodeDelhiPoliceEntries(policeEntries) : [];

  const allCameras = [...osmCameras, ...policeCameras];
  if (!allCameras.length) {
    console.log('No cameras found from either source. Nothing to import.');
    return;
  }

  await upsertCameras(allCameras);
  console.log('Camera import complete.');
}

main().catch((err) => {
  console.error('Camera import failed:', err);
  process.exit(1);
});
