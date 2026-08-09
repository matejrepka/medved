import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("record detail retries with a fresh overview before returning a missing-record error", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(source, /async function loadLocationOverview\(\{ force = false \} = \{\}\)/);
  assert.match(
    source,
    /if \(!record && token\) \{\s*overview = await loadLocationOverview\(\{ force: true \}\);\s*\(\{ record, recordType \} = findOverviewRecord/
  );
  assert.match(
    source,
    /await updateBearReportStatus\([\s\S]*?invalidateLocationOverviewCache\(\)/
  );
});
