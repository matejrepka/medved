import test from "node:test";
import assert from "node:assert/strict";

import { isTrustedSighting, sightingStatus } from "../src/db/repository.js";

for (const key of ["tumedved", "mapamedvedov", "sprejnamedveda"]) {
  test(`${key} sightings are automatically approved`, () => {
    const item = { sourceKey: key, sourceLinks: [] };
    assert.equal(isTrustedSighting(item), true);
    assert.equal(sightingStatus(item), "approved");
    assert.equal(sightingStatus(item, "pending"), "approved");
  });
}

test("admin rejection is preserved for trusted sources", () => {
  assert.equal(sightingStatus({ source: "tumedved.sk" }, "rejected"), "rejected");
});

test("unknown sources still require moderation", () => {
  const item = { source: "example.com", url: "https://example.com/report/1" };
  assert.equal(isTrustedSighting(item), false);
  assert.equal(sightingStatus(item), "pending");
});
