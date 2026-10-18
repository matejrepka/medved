import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadTumedvedLogs, loadApprovedBearReports, loadNewsLogs } from "../src/db/repository.js";
import { loadSightingBuckets } from "../src/db/sighting-buckets.js";
import { mergeWarnings } from "../src/warnings.js";
import { loadPlaces } from "../src/geo/geocode.js";
import { buildPublicOverview } from "../src/public-overview.js";
import { loadSnapshotState, publishPublicSnapshot, snapshotDay } from "../src/db/public-snapshot.js";

// This module is deliberately absent from the HTTP server/Worker imports.
export async function precomputePublic({ force = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await loadSnapshotState();
    if (!state) throw new Error("Public snapshot schema missing; apply migration 011 first.");
    const day = snapshotDay();
    if (!force && state.revision === state.built_revision && state.built_day === day) {
      console.log("[snapshot] unchanged; skipped");
      return;
    }
    const [sightings, reports, news, buckets, gz] = await Promise.all([
      loadTumedvedLogs(), loadApprovedBearReports(), loadNewsLogs(), loadSightingBuckets(), loadPlaces(),
    ]);
    const warnings = mergeWarnings({ sightings, reports, buckets });
    const updatedAt = new Date().toISOString();
    const payload = buildPublicOverview({ warnings, news, gz, updatedAt });
    if (await publishPublicSnapshot(state.revision, day, payload)) {
      console.log(`[snapshot] saved ${payload.locations.length} locations, ${warnings.length} warnings, ${news.length} news`);
      return;
    }
    console.log("[snapshot] data changed during build; retrying");
  }
  throw new Error("Public data kept changing; snapshot was not published. Retry the background job.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await precomputePublic({ force: process.argv.includes("--force") });
}
