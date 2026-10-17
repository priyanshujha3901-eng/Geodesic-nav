// supabase/functions/delhi-bus-positions/index.ts
//
// Secure proxy for the Delhi Open Transit Data GTFS-Realtime "VehiclePositions" feed.
//  - The API key is read ONLY from the private secret DELHI_OTD_API_KEY (Deno.env.get).
//  - The key is never returned, logged, or included in any error message
//    (note: fetch() errors can contain the request URL, so error text is never logged).
//  - The browser never talks to the Delhi API; it calls this function and gets sanitized JSON.

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { createClient } from "@supabase/supabase-js";

const UPSTREAM_URL = "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb";
const CACHE_TTL_MS = 8_000;        // many users share one upstream call
const UPSTREAM_TIMEOUT_MS = 10_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// --- mapper (start) ------------------------------------------------------
export type Vehicle = {
  vehicleId?: string;
  vehicleLabel?: string;
  routeId?: string;
  tripId?: string;
  latitude: number;
  longitude: number;
  timestamp?: number; // seconds since epoch, as given by the feed
  bearing?: number;   // degrees, only if the feed provides it
  speed?: number;     // metres per second, only if the feed provides it
};

// protobufjs leaves unset optional fields on the prototype, so "present" = own property.
const has = (o: unknown, k: string): boolean =>
  typeof o === "object" &&
  o !== null &&
  Object.prototype.hasOwnProperty.call(o, k) &&
  (o as Record<string, unknown>)[k] != null;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const num = (v: unknown): number | undefined => {
  if (v == null) return undefined;

  let n: number;

  if (
    typeof v === "object" &&
    "toNumber" in v &&
    typeof v.toNumber === "function"
  ) {
    n = Number(v.toNumber());
  } else {
    n = Number(v);
  }

  return Number.isFinite(n) ? n : undefined;
};
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// Keeps only vehicles with a valid position. Never invents route / bus numbers.
export function mapFeedToVehicles(
  feed: ReturnType<typeof GtfsRealtimeBindings.transit_realtime.FeedMessage.decode>
): Vehicle[] {
  const out: Vehicle[] = [];
  for (const entity of feed?.entity ?? []) {
    const v = entity?.vehicle;
    const pos = v?.position;
    if (!pos || !has(pos, "latitude") || !has(pos, "longitude")) continue;
    const lat = num(pos.latitude);
    const lng = num(pos.longitude);
    if (lat === undefined || lng === undefined) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;

    const item: Vehicle = { latitude: r6(lat), longitude: r6(lng) };
    const vehicleId = str(v.vehicle?.id);
    const vehicleLabel = str(v.vehicle?.label);
    const routeId = str(v.trip?.routeId);
    const tripId = str(v.trip?.tripId);
    if (vehicleId) item.vehicleId = vehicleId;
    if (vehicleLabel) item.vehicleLabel = vehicleLabel;
    if (routeId) item.routeId = routeId;
    if (tripId) item.tripId = tripId;
    const ts = has(v, "timestamp") ? num(v.timestamp) : undefined;
    if (ts !== undefined && ts > 0) item.timestamp = ts;
    const bearing = has(pos, "bearing") ? num(pos.bearing) : undefined;
    if (bearing !== undefined) item.bearing = bearing;
    const speed = has(pos, "speed") ? num(pos.speed) : undefined;
    if (speed !== undefined && speed >= 0) item.speed = speed;
    out.push(item);
  }
  return out;
}
// --- mapper (end) --------------------------------------------------------

const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

// Only signed-in users (guests count: they have an anonymous session) may call this,
// so strangers cannot burn the Delhi API quota. Done here instead of the built-in
// verify_jwt check so it also works with the newer publishable-key / signing-key setups.
async function isSignedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const url = Deno.env.get("SUPABASE_URL");
  const apikey = req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !apikey) return false;
  const client = createClient(url, apikey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(auth.slice(7));
  return !error && !!data.user;
}

let cache: { at: number; body: string } | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return reply({ error: "unavailable" }, 405);
  if (!(await isSignedIn(req))) return reply({ error: "unauthorized" }, 401);

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return new Response(cache.body, {
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const key = Deno.env.get("DELHI_OTD_API_KEY");
  if (!key) {
    console.error("delhi-bus-positions: DELHI_OTD_API_KEY secret is not set");
    return reply({ error: "unavailable" }, 503);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${UPSTREAM_URL}?key=${encodeURIComponent(key)}`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.error(`delhi-bus-positions: upstream returned HTTP ${res.status}`);
      return reply({ error: "unavailable" }, 502);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const feed =
  GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
    const vehicles = mapFeedToVehicles(feed);
    if (vehicles.length === 0) {
      console.error("delhi-bus-positions: feed contained no valid vehicles");
      return reply({ error: "unavailable" }, 502);
    }

    const body = JSON.stringify({
      vehicles,
      count: vehicles.length,
      source: "Delhi Open Transit Data",
      fetchedAt: new Date().toISOString(),
    });
    cache = { at: Date.now(), body };
    return new Response(body, {
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e) {
    // Only the error class name is logged: the message can contain the URL (and so the key).
    console.error("delhi-bus-positions: request failed:", e instanceof Error ? e.name : "unknown");
    return reply({ error: "unavailable" }, 502);
  }
});
