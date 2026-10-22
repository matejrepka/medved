import assert from "node:assert/strict";
import test from "node:test";
import { precomputePublic } from "../scripts/precompute-public.mjs";
import { snapshotDay } from "../src/db/public-snapshot.js";

function fixture(t, overrides = {}) {
  const logs = [], delays = [], published = [];
  let reads = 0, loads = 0;
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, line => logs.push(line));
  const io = {
    loadSnapshotState: async () => ({ revision: ++reads, built_revision: 0 }),
    loadTumedvedLogs: async () => { loads++; return []; },
    loadApprovedBearReports: async () => [], loadNewsLogs: async () => [], loadSightingBuckets: async () => [],
    publishPublicSnapshot: async revision => { published.push(revision); return true; },
    wait: async delay => { delays.push(delay); },
    ...overrides,
  };
  return { io, logs, delays, published, counts: () => ({ reads, loads }) };
}

test("database timeout retries reload the revision and sources, and log each phase", async t => {
  const f = fixture(t);
  f.io.publishPublicSnapshot = async revision => {
    f.published.push(revision);
    if (revision === 1) throw { code: "57014", message: "canceling statement due to statement timeout" };
    return true;
  };
  await precomputePublic({}, f.io);
  assert.deepEqual(f.published, [1, 2]);
  assert.deepEqual(f.counts(), { reads: 2, loads: 2 }, "A retry cannot publish data from the timed-out attempt");
  assert.deepEqual(f.delays, [2000]);
  assert.ok(f.logs.some(line => /publish failed in \d+ ms \(57014\)/.test(line)));
  for (const stage of ["load-state", "loadTumedvedLogs", "loadApprovedBearReports", "loadNewsLogs",
    "loadSightingBuckets", "loadPlaces", "merge-warnings", "build-overview", "publish"]) {
    assert.ok(f.logs.some(line => line.includes(`${stage} completed in `)), stage);
  }
  assert.ok(f.logs.some(line => /ms total/.test(line)));
});

test("repeated lock timeouts stop after three attempts with the failing stage and original code", async t => {
  const failure = { code: "55P03", message: "canceling statement due to lock timeout" };
  const f = fixture(t, { loadSnapshotState: async () => { throw failure; } });
  await assert.rejects(precomputePublic({}, f.io), error => {
    assert.equal(error.code, "55P03");
    assert.equal(error.cause, failure);
    assert.match(error.message, /^load-state:/);
    return true;
  });
  assert.deepEqual(f.delays, [2000, 5000]);
  assert.equal(f.logs.filter(line => line.includes("load-state failed")).length, 3);
  assert.deepEqual(f.published, []);
});

for (const failure of [
  { code: "42501", message: "permission denied" },
  { code: "57014", message: "canceling statement due to user request" },
]) {
  test(`${failure.message} fails immediately without retry`, async t => {
    const f = fixture(t, { publishPublicSnapshot: async () => { throw failure; } });
    await assert.rejects(precomputePublic({}, f.io), error => error.code === failure.code && error.cause === failure);
    assert.deepEqual(f.counts(), { reads: 1, loads: 1 });
    assert.deepEqual(f.delays, []);
  });
}

test("unchanged snapshot skips work, while force publishes it", async t => {
  const f = fixture(t, { loadSnapshotState: async () => ({ revision: 7, built_revision: 7, built_day: snapshotDay() }) });
  await precomputePublic({}, f.io);
  assert.equal(f.counts().loads, 0);
  assert.deepEqual(f.published, []);
  await precomputePublic({ force: true }, f.io);
  assert.equal(f.counts().loads, 1);
  assert.deepEqual(f.published, [7]);
});

test("revision conflicts rebuild from fresh data and remain bounded", async t => {
  const f = fixture(t, { publishPublicSnapshot: async () => false });
  await assert.rejects(precomputePublic({}, f.io), /Public data kept changing/);
  assert.deepEqual(f.counts(), { reads: 3, loads: 3 });
  assert.deepEqual(f.delays, []);
});
