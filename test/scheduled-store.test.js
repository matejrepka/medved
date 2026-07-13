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
