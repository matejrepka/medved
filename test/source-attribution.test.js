import test from "node:test";
import assert from "node:assert/strict";
import { sightingSourceLinks } from "../src/sightings-dedupe.js";
import { mergeWarnings } from "../src/warnings.js";
import { mapamedvedovAttributions, tumedvedAttributions, sourceAttributionHtml, sourceAttributionText } from "../src/source-attribution.js";
import { buildWarningEmail, buildDigestEmail } from "../src/email/templates.js";

const original = "https://mapamedvedov.sk/pozorovanie/55";
const sighting = { id: "55", sourceKey: "mapamedvedov", source: "mapamedvedov.sk", url: original,
  sourceLinks: [{ key: "mapamedvedov", label: "mapamedvedov.sk", url: original }] };

test("legacy source links receive attribution metadata and keep the observation URL", () => {
  const [link] = sightingSourceLinks(sighting);
  assert.equal(link.label, "mapamedveďov.sk");
  assert.equal(link.url, original);
  assert.equal(link.license, "CC BY 4.0");
  assert.equal(link.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
  assert.match(link.changes, /zjednotený formát/);
});

test("attribution survives a bucket whose primary record comes from another source", () => {
  const primary = { id: "tm-1", source: "tumedved.sk", url: "https://tumedved.sk/1" };
  const [merged] = mergeWarnings({ sightings: [primary, sighting], buckets: [
    { id: "bucket", primaryKey: "sighting:tm-1", memberKeys: ["sighting:tm-1", "sighting:55"] },
  ] });
  assert.equal(mapamedvedovAttributions(merged).length, 1);
  assert.match(sourceAttributionHtml(merged), /href="https:\/\/mapamedvedov.sk\/pozorovanie\/55"/);
  assert.match(sourceAttributionText(merged), /mapamedveďov.sk.*CC BY 4.0/);
});

test("unrelated data is not assigned this license and unsafe URLs use the source homepage", () => {
  assert.equal(sourceAttributionHtml({ source: "other.example", url: "https://other.example/" }), "");
  assert.equal(mapamedvedovAttributions({ sourceLinks: [{ key: "mapamedvedov", url: "javascript:alert(1)" }] })[0].url,
    "https://mapamedvedov.sk/");
  const html = sourceAttributionHtml({ sourceLinks: [{ key: "mapamedvedov", url: `${original}?a=1&b=2` }] });
  assert.ok(html.includes("?a=1&amp;b=2"));
});

test("tumedved attribution retains the direct report link without assigning a license", () => {
  const item = { source: "tumedved.sk", url: "https://tumedved.sk/?p=42" };
  assert.deepEqual(tumedvedAttributions(item), [{ label: "tumedved.sk", url: item.url }]);
  assert.equal(sourceAttributionText(item), `Zdroj: tumedved.sk — ${item.url}`);
  assert.ok(sourceAttributionHtml(item).includes(`href="${item.url}"`));
  assert.ok(!sourceAttributionHtml(item).includes("CC BY"));
  assert.equal(tumedvedAttributions({ sourceKey: "tumedved", url: "javascript:alert(1)" })[0].url,
    "https://tumedved.sk/");
  assert.equal(tumedvedAttributions({ sourceLinks: [{ key: "other", url: "https://tumedved.sk.evil.example/42" }] }).length, 0);
});

test("single and digest emails credit nested persisted source links in both formats", () => {
  const row = { id: 1, aggregate_type: "sightings_log", payload: {
    location: "Test", source: "tumedved.sk", url: "https://tumedved.sk/1", payload: { sourceLinks: sighting.sourceLinks },
  } };
  const options = { row, rows: [row], subscription: { notify_type: "all" }, unsubscribeToken: "test",
    config: { siteOrigin: "https://www.kdejemedved.sk" } };
  for (const email of [buildWarningEmail(options), buildDigestEmail(options)]) {
    for (const content of [email.html, email.text]) {
      assert.ok(content.includes(original));
      assert.ok(content.includes("mapamedveďov.sk"));
      assert.ok(content.includes("CC BY 4.0"));
      assert.ok(content.includes("zjednotený formát"));
      assert.ok(content.includes("tumedved.sk"));
      assert.ok(content.includes("https://tumedved.sk/1"));
    }
  }
});
