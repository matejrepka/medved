import { getSupabase } from "./supabase.js";
import { buildRecordDocuments } from "../record-documents.js";

const STATE_TTL_MS = 15_000;
const MAX_DOCUMENTS = 128;
let caches = new WeakMap();

function cacheFor(client) {
  if (!caches.has(client)) caches.set(client, { state: null, expiresAt: 0, pending: null,
    version: null, documents: new Map(), loads: new Map() });
  return caches.get(client);
}

export function invalidatePublicSnapshotCache() {
  caches = new WeakMap();
}

export async function getPublicSnapshotVersion(client = getSupabase()) {
  if (!client) return null;
  const cache = cacheFor(client);
  if (cache.expiresAt <= Date.now()) {
    if (!cache.pending) cache.pending = loadSnapshotState(client).then(state => {
      const version = state && state.revision === state.built_revision && state.updated_at
        ? `${state.built_revision}:${state.updated_at}` : null;
      if (version !== cache.version) {
        cache.documents.clear();
        cache.loads.clear();
      }
      cache.version = version;
      cache.state = state;
      cache.expiresAt = Date.now() + STATE_TTL_MS;
    }).finally(() => { cache.pending = null; });
    await cache.pending;
  }
  return cache.version;
}

export const snapshotDay = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit",
}).format(date);

export async function loadSnapshotState(client = getSupabase()) {
  if (!client) return null;
  const { data, error } = await client.from("public_snapshots")
    .select("revision,built_revision,built_day,updated_at").eq("id", "overview").maybeSingle();
  if (error) throw error;
  return data;
}

export async function loadPublicSnapshot({ kind = "overview", slug = null, client = getSupabase() } = {}) {
  if (!client) return null;
  const version = await getPublicSnapshotVersion(client);
  if (!version) return null;
  const cache = cacheFor(client);
  const key = JSON.stringify([kind, slug]);
  if (cache.documents.has(key)) {
    const document = cache.documents.get(key);
    cache.documents.delete(key);
    cache.documents.set(key, document);
    return document;
  }
  if (!cache.loads.has(key)) {
    const pending = (async () => {
      // The database independently checks revision again, covering edits that
      // happen between the small metadata query and the document read.
      const { data, error } = await client.rpc("read_public_snapshot", { p_kind: kind, p_slug: slug });
      if (error) throw error;
      if (data && cache.version === version) {
        cache.documents.set(key, data);
        if (cache.documents.size > MAX_DOCUMENTS) cache.documents.delete(cache.documents.keys().next().value);
      }
      return data;
    })();
    cache.loads.set(key, pending);
    pending.finally(() => {
      if (cache.loads.get(key) === pending) cache.loads.delete(key);
    }).catch(() => {});
  }
  return cache.loads.get(key);
}

export async function publishPublicSnapshot(revision, day, payload, client = getSupabase()) {
  if (!client) throw new Error("Supabase is not configured");
  const started = performance.now();
  const { allLocations, ...report } = payload.report;
  const directory = payload.locations.map(({ warningItems, newsItems, ...location }) => location);
  // Prepare small documents once. Each visitor downloads just their report or
  // location, never the complete directory with repeated article/report text.
  const documents = {
    stats: { report, updatedAt: payload.updatedAt },
    overview: { report, locations: directory, topLocations: directory.slice(0, 12), updatedAt: payload.updatedAt },
    locations: Object.fromEntries(payload.locations.map(location => [location.slug, location])),
    warnings: { items: payload.warnings, updatedAt: payload.updatedAt },
    news: { items: payload.news, updatedAt: payload.updatedAt },
    records: buildRecordDocuments(payload),
  };
  console.log(`[snapshot] prepare-documents completed in ${Math.round(performance.now() - started)} ms (${Object.keys(documents.records).length} records)`);
  const { data, error } = await client.rpc("publish_public_snapshot", {
    p_revision: revision, p_day: day, p_payload: documents,
  });
  if (error) throw error;
  return data === true;
}
