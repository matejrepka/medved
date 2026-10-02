import test from "node:test";
import assert from "node:assert/strict";

import { ScheduledDataStore } from "../src/scheduled-store.js";

test("ScheduledDataStore označí zdroj a fázu chyby sťahovania", async () => {
  const store = new ScheduledDataStore({
    name: "tumedved",
    fetcher: async () => {
      throw new Error("Playwright browser sa nespustil");
    },
  });

  await assert.rejects(store.refresh("test"), (error) => {
    assert.equal(error.refreshSource, "tumedved");
    assert.equal(error.refreshStage, "fetch");
    return true;
  });

  assert.equal(store.meta.error, "Playwright browser sa nespustil");
  assert.equal(store.meta.errorStage, "fetch");
  assert.equal(store.meta.lastRun.status, "error");
});

test("ScheduledDataStore odlíši chybu ukladania od chyby sťahovania", async () => {
  const store = new ScheduledDataStore({
    name: "news",
    fetcher: async () => [{ id: "article-1" }],
    saveFresh: async () => {
      throw new Error("Databáza odmietla zápis");
    },
  });

  await assert.rejects(store.refresh("test"), (error) => {
    assert.equal(error.refreshSource, "news");
    assert.equal(error.refreshStage, "save");
    return true;
  });

  assert.equal(store.meta.errorStage, "save");
  assert.equal(store.meta.lastRun.stage, "save");
});

test("ScheduledDataStore uloží úspešný výsledok posledného behu", async () => {
  const store = new ScheduledDataStore({
    name: "news",
    fetcher: async () => [{ id: "article-1" }, { id: "article-2" }],
  });

  await store.refresh("test");

  assert.equal(store.meta.error, null);
  assert.equal(store.meta.errorStage, null);
  assert.equal(store.meta.lastRun.status, "success");
  assert.equal(store.meta.lastRun.itemCount, 2);
});

test("ScheduledDataStore zdieľa súbežné načítanie databázy", async () => {
  let loads = 0;
  let releaseLoad;
  const gate = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const store = new ScheduledDataStore({
    name: "news",
    fetcher: async () => [],
    loadStored: async () => {
      loads += 1;
      await gate;
      return [{ id: "article-1", _scrapedAt: "2026-09-28T08:00:00Z" }];
    },
  });

  const startup = store.start();
  const request = store.get();
  releaseLoad();

  const [, items] = await Promise.all([startup, request]);
  assert.equal(loads, 1);
  assert.deepEqual(items, [{ id: "article-1" }]);
});

test("refresh never publishes unapproved scraped rows during save or after failure", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const approved = [{ id: "approved" }];
  const store = new ScheduledDataStore({
    name: "news", loadStored: async () => approved,
    fetcher: async () => [{ id: "pending", private: "internal analysis" }],
    saveFresh: async () => { await gate; throw new Error("save failed"); },
  });
  await store.start();
  const refresh = store.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await store.get(), approved);
  release();
  await assert.rejects(refresh, /save failed/);
  assert.deepEqual(await store.get(), approved);
});

test("successful refresh publishes only filtered DB rows; reload failures preserve approved data", async () => {
  let failReload = false;
  const approved = [{ id: "approved" }];
  const store = new ScheduledDataStore({
    name: "news", loadStored: async () => { if (failReload) throw new Error("reload failed"); return approved; },
    fetcher: async () => [{ id: "pending" }], saveFresh: async () => {},
  });
  await store.start();
  assert.deepEqual(await store.refresh(), approved);
  failReload = true;
  await assert.rejects(store.refresh(), /reload failed/);
  assert.deepEqual(await store.get(), approved);
});

test("public data reloads after TTL so moderation by another instance becomes visible", async () => {
  let rows = [{ id: "previously-approved" }];
  const store = new ScheduledDataStore({ name: "news", loadStored: async () => rows, maxAgeMs: 0 });
  await store.start();
  rows = [];
  assert.deepEqual(await store.get(), []);
});
