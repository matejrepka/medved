import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { homeStats } from "../public/home-stats.js";

test("home counts use Slovak calendar dates, include deduplicated public reports and ignore invalid/future dates", () => {
  const warnings = [
    { reportedAt: "2026-10-17T22:30:00Z", source: "tumedved.sk" },
    { reportedAt: "2026-10-18T12:00:00Z", source: "community" },
    { reportedAt: "2026-10-11T22:00:00Z" },
    { reportedAt: "2026-10-11T21:59:59Z" },
    { reportedAt: "2026-10-19T12:00:00Z" },
    { reportedAt: "invalid" }, {},
  ];
  assert.deepEqual(homeStats({ warnings, news: [{ date: "2026-10-17T23:00:00Z" }] }, new Date("2026-10-18T08:00:00Z")), {
    todaySightings: 2, weekSightings: 3, todayNews: 1,
  });
});

test("seven-day window includes the first local day across the autumn clock change", () => {
  const warnings = [{ reportedAt: "2026-10-24T22:30:00Z" }, { reportedAt: "2026-10-24T21:59:00Z" }];
  assert.equal(homeStats({ warnings }, new Date("2026-10-31T12:00:00Z")).weekSightings, 1);
});

test("home hydrates delayed feeds independently and preserves existing counts on failure", async () => {
  const source = (await readFile(new URL("../public/home.js", import.meta.url), "utf8"))
    .replace(/^import .*;\s*/, "");
  const nodes = Object.fromEntries(["todaySightings", "weekSightings", "todayNews"].map(key => [key, { textContent: "—" }]));
  let finishWarnings;
  const warningsResponse = new Promise(resolve => { finishWarnings = resolve; });
  const context = {
    homeStats, localStorage: { getItem: () => null },
    document: {
      getElementById: () => null,
      documentElement: { getAttribute: () => "dark" },
      addEventListener() {},
      querySelector: (selector) => selector === "[data-home-stat]" ? nodes.todaySightings : nodes[selector.match(/"(.*?)"/)?.[1]],
    },
    fetch: (url) => url.endsWith("warnings") ? warningsResponse : Promise.resolve({ ok: false }),
  };
  vm.runInNewContext(source, context);
  assert.equal(nodes.todaySightings.textContent, "—");
  finishWarnings({ ok: true, json: async () => ({ items: [{ reportedAt: new Date().toISOString() }] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.todaySightings.textContent, "1");
  assert.equal(nodes.weekSightings.textContent, "1");
  assert.equal(nodes.todayNews.textContent, "—");
});
