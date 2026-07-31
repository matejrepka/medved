import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("map coordinates do not turn missing values into the Gulf of Guinea", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const match = source.match(/function mapCoord\([^)]*\) \{[\s\S]*?\n\}/);

  assert.ok(match, "mapCoord helper must exist");
  const mapCoord = Function(`${match[0]}; return mapCoord;`)();

  assert.equal(mapCoord(null), null);
  assert.equal(mapCoord(undefined), null);
  assert.equal(mapCoord(""), null);
  assert.equal(mapCoord(0, "lat"), null);
  assert.equal(mapCoord(0, "lng"), null);
  assert.equal(mapCoord(50.1, "lat"), null);
  assert.equal(mapCoord(15, "lng"), null);
  assert.equal(mapCoord("49.02972", "lat"), 49.02972);
  assert.equal(mapCoord("19.5821", "lng"), 19.5821);
});
