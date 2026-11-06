import assert from "node:assert/strict";
import test from "node:test";
import { saveTumedvedLogs, saveNewsLogs, reviewNews, updateNewsFields } from "../src/db/repository.js";

Object.assign(process.env, {
  SUPABASE_URL: "https://imports-fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
});
const sighting = { id: "tm-1", source: "tumedved.sk", location: "Brezno" };
const mockDatabase = (t, respond) => t.mock.method(globalThis, "fetch", async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.equal(url.hostname, "imports-fixture.supabase.co");
  return respond(url, init);
});

for (const column of ["manually_edited", "status"]) {
  test(`an unavailable ${column} check prevents import writes`, async t => {
    let writes = 0;
    mockDatabase(t, (url, init) => {
      if (init.method !== "GET") { writes++; return Response.json([]); }
      if ((url.searchParams.get("select") || "").includes(column) || url.searchParams.has(column)) {
        return Response.json({ code: "57014", message: "statement timeout" }, { status: 500 });
      }
      return Response.json([]);
    });
    await assert.rejects(saveTumedvedLogs([sighting]), error => error.code === "57014");
    assert.equal(writes, 0, "An unknown moderation/edit state must never be treated as unprotected");
  });
}

test("legacy missing columns still allow imports without inventing moderation fields", async t => {
  let written;
  mockDatabase(t, (url, init) => {
    if (init.method === "POST") { written = JSON.parse(init.body); return Response.json([]); }
    return Response.json({ code: "PGRST204", message: "Could not find the column in the schema cache" }, { status: 400 });
  });
  await saveTumedvedLogs([sighting]);
  assert.equal(written.length, 1);
  assert.equal(Object.hasOwn(written[0], "status"), false);
});

test("imports retain manually edited and rejected records", async t => {
  let written;
  mockDatabase(t, (url, init) => {
    if (init.method === "POST") { written = JSON.parse(init.body); return Response.json([]); }
    if (url.searchParams.has("manually_edited")) return Response.json([{ id: "tm-edited" }]);
    return Response.json([{ id: "tm-1", status: "rejected" }]);
  });
  await saveTumedvedLogs([sighting, { ...sighting, id: "tm-edited" }]);
  assert.deepEqual(written.map(row => row.id), ["tm-1"]);
  assert.equal(written[0].status, "rejected");
});

test("unchanged retry summaries do not write or invalidate the public snapshot", async t => {
  let writes = 0;
  mockDatabase(t, (_url, init) => {
    if (init.method !== "GET") { writes++; return Response.json([]); }
    return Response.json([{ id: "news-1", status: "approved", payload: { sourceSummary: "Existing summary" } }]);
  });
  await saveNewsLogs([{ id: "news-1", title: "Medveď", snippet: "Existing summary" }]);
  assert.equal(writes, 0);
});

test("a newly generated AI summary still updates a known article", async t => {
  let written;
  mockDatabase(t, (_url, init) => {
    if (init.method === "PATCH") { written = JSON.parse(init.body); return Response.json([]); }
    return Response.json([{ id: "news-1", status: "approved", payload: { sourceSummary: "Existing summary" } }]);
  });
  await saveNewsLogs([{ id: "news-1", title: "Medveď", snippet: "Existing summary" }], undefined, {
    prepareFresh: async items => { items[0].aiSummary = "New AI summary"; },
  });
  assert.equal(written.payload.aiSummary, "New AI summary");
  assert.equal(Object.hasOwn(written, "status"), false);
});

test("moderation preserves legacy locations and replaces them through one transactional RPC", async t => {
  let call, update;
  mockDatabase(t, (url, init) => {
    if (url.pathname.endsWith("/rpc/replace_news_warning_locations")) {
      call = JSON.parse(init.body);
      return Response.json(true);
    }
    assert.ok(!["DELETE", "POST"].includes(init.method), "Location writes must only use the transactional RPC");
    if (init.method === "PATCH") update = JSON.parse(init.body);
    return Response.json(null);
  });
  await reviewNews("news-1", { status: "approved", category: "warning", place: "Brezno", lat: 48.8, lng: 19.6 });
  assert.equal(update.place, "Brezno");
  assert.equal(call.p_news_id, "news-1");
  assert.deepEqual(call.p_locations, [{ place: "Brezno", lat: 48.8, lng: 19.6, hasCoords: true }]);
});

test("a missing location migration fails clearly without a destructive fallback", async t => {
  mockDatabase(t, (url, init) => {
    if (url.pathname.endsWith("/rpc/replace_news_warning_locations")) {
      return Response.json({ code: "PGRST202", message: "Missing RPC" }, { status: 404 });
    }
    assert.equal(init.method, "PATCH");
    return Response.json(null);
  });
  await assert.rejects(updateNewsFields("news-1", { category: "article" }), /migráciu atomic_news_warning_locations/);
});

test("a concurrent duplicate insert cannot overwrite an existing article's locations", async t => {
  mockDatabase(t, (url, init) => {
    assert.ok(!url.pathname.includes("/rpc/"), "A skipped duplicate must retain its already stored locations");
    if (init.method === "POST") {
      assert.equal(url.searchParams.get("select"), "id");
      return Response.json([]);
    }
    return Response.json([]);
  });
  await saveNewsLogs([{ id: "concurrent-news", title: "Medveď", category: "warning",
    locations: [{ place: "Brezno", lat: 48.8, lng: 19.6 }] }]);
});

test("newly inserted articles still persist all warning locations", async t => {
  let persisted = false;
  mockDatabase(t, (url, init) => {
    if (url.pathname.includes("/rpc/")) {
      const call = JSON.parse(init.body);
      assert.equal(call.p_news_id, "new-news");
      assert.equal(call.p_locations[0].place, "Brezno");
      persisted = true;
      return Response.json(true);
    }
    return Response.json(init.method === "POST" ? [{ id: "new-news" }] : []);
  });
  await saveNewsLogs([{ id: "new-news", title: "Medveď", category: "warning",
    locations: [{ place: "Brezno", lat: 48.8, lng: 19.6 }] }]);
  assert.equal(persisted, true);
});
