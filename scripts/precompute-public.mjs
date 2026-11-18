import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { loadTumedvedLogs, loadApprovedBearReports, loadNewsLogs } from "../src/db/repository.js";
import { loadSightingBuckets } from "../src/db/sighting-buckets.js";
import { mergeWarnings, warningRecordKey } from "../src/warnings.js";
import { loadPlaces } from "../src/geo/geocode.js";
import { buildPublicOverview } from "../src/public-overview.js";
import { loadSnapshotState, publishPublicSnapshot, snapshotDay } from "../src/db/public-snapshot.js";

async function loadRecordHistory(buckets, currentWarnings) {
  const all = { allApproved: true };
  const [sightings, reports, news] = await Promise.all([
    loadTumedvedLogs(all), loadApprovedBearReports(all), loadNewsLogs(all),
  ]);
  // An older bucket primary may have rolled off the map. Keep the URL currently
  // linked by the feed and redirect every approved member to that same record.
  const currentPrimary = new Map(currentWarnings.filter(item => item.bucketId)
    .map(item => [item.bucketId, warningRecordKey(item)]));
  const archiveBuckets = buckets.map(bucket => ({
    ...bucket, primaryKey: currentPrimary.get(bucket.id) || bucket.primaryKey,
  }));
  return { news, warnings: mergeWarnings({ sightings, reports, buckets: archiveBuckets }) };
}

const dependencies = { loadSnapshotState, loadTumedvedLogs, loadApprovedBearReports, loadNewsLogs,
  loadSightingBuckets, loadPlaces, loadRecordHistory, publishPublicSnapshot, wait };

// This module is deliberately absent from the HTTP server/Worker imports.
export async function precomputePublic({ force = false } = {}, overrides = {}) {
  const io = { ...dependencies, ...overrides };
  const started = performance.now();
  const measure = async (stage, operation) => {
    const start = performance.now();
    try {
      const result = await operation();
      console.log(`[snapshot] ${stage} completed in ${Math.round(performance.now() - start)} ms`);
      return result;
    } catch (cause) {
      const error = new Error(`${stage}: ${cause.message || String(cause)}`, { cause });
      error.code = cause.code;
      console.error(`[snapshot] ${stage} failed in ${Math.round(performance.now() - start)} ms (${error.code || "no code"}): ${error.message}`);
      throw error;
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    console.log(`[snapshot] attempt ${attempt + 1}/3`);
    try {
      const state = await measure("load-state", () => io.loadSnapshotState());
      if (!state) throw new Error("Public snapshot schema missing; apply migration 011 first.");
      const day = snapshotDay();
      if (!force && state.revision === state.built_revision && state.built_day === day) {
        console.log(`[snapshot] unchanged; skipped (${Math.round(performance.now() - started)} ms total)`);
        return;
      }
      const [sightings, reports, news, buckets, gz] = await Promise.all(
        ["loadTumedvedLogs", "loadApprovedBearReports", "loadNewsLogs", "loadSightingBuckets", "loadPlaces"]
          .map(name => measure(name, () => io[name]())),
      );
      const warnings = await measure("merge-warnings", () => mergeWarnings({ sightings, reports, buckets }));
      const updatedAt = new Date().toISOString();
      const payload = await measure("build-overview", () => buildPublicOverview({ warnings, news, gz, updatedAt }));
      payload.history = await measure("load-record-history", () => io.loadRecordHistory(buckets, warnings));
      if (await measure("publish", () => io.publishPublicSnapshot(state.revision, day, payload))) {
        console.log(`[snapshot] saved ${payload.locations.length} locations, ${warnings.length} warnings, ${news.length} news (${Math.round(performance.now() - started)} ms total)`);
        return;
      }
      console.log("[snapshot] data changed during build; retrying");
    } catch (error) {
      const timeout = error.code === "55P03" ||
        (error.code === "57014" && /statement timeout/i.test(error.message));
      if (!timeout || attempt === 2) throw error;
      const delay = attempt === 0 ? 2000 : 5000;
      console.warn(`[snapshot] temporary database timeout (${error.code}); retrying in ${delay} ms with fresh data`);
      await io.wait(delay);
    }
  }
  throw new Error("Public data kept changing; snapshot was not published. Retry the background job.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await precomputePublic({ force: process.argv.includes("--force") });
}
