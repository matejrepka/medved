import test from "node:test";
import assert from "node:assert/strict";
import { createLocationSearch, resolveSlovakLocation } from "../src/geo/search.js";
import { geocodeNews, lookupPlaceByName } from "../src/geo/geocode.js";

const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const route = {
  type: "relation", id: 10,
  tags: { description: "Javorová cesta", route: "hiking", ref: "8886" },
  members: [{ type: "way", geometry: [
    { lat: 48.95, lon: 20.39 }, { lat: 48.955, lon: 20.395 }, { lat: 48.96, lon: 20.40 },
  ] }],
};

test("Kláštorská cesta resolves offline with inflections, accents and region", async () => {
  const search = createLocationSearch({ fetchImpl: () => { throw new Error("Must stay offline"); } });
  for (const query of ["Kláštorská cesta", "klastorska cesta", "Kláštorskej ceste",
    "Kláštorská cesta v Slovenskom raji", "Kláštorská cesta, Slovenský raj"]) {
    const [hit] = await search(query);
    assert.equal(hit.name, "Kláštorská cesta");
    assert.equal(hit.lat, 48.9526744);
    assert.equal(hit.lng, 20.3988546);
    assert.equal(hit.precision, "route");
    assert.match(hit.label, /Slovenský raj.*orientačný bod na trase/);
  }
  assert.equal((await resolveSlovakLocation("Kláštorská cesta, Slovenský raj")).name, "Kláštorská cesta");
});

test("Overpass finds routes by description and puts the marker on their geometry", async () => {
  const calls = [];
  const search = createLocationSearch({ minIntervalMs: 0, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return response(String(url).includes("nominatim") ? [] : {
      elements: options.body.get("data").includes("[description~") ? [route] : [],
    });
  } });
  const [hit] = await search("Javorova cesta");
  assert.equal(hit.name, "Javorová cesta");
  assert.equal(hit.lat, 48.955);
  assert.equal(hit.lng, 20.395);
  assert.equal(hit.precision, "route");
  assert.match(calls[1].options.body.get("data"), /\[description="Javorova cesta"\]/);
  assert.match(calls[2].options.body.get("data"), /\[description~/);
  assert.match(calls[2].options.body.get("data"), /j\[aáä\]v\[oóô\]\[rŕ\]\[oóô\]v\[aáä\]/);
  assert.match(calls[1].options.body.get("data"), /nwr\(area\.sk\)\(47\.65,16\.75,49\.7,22\.65\)\[/);
  assert.match(calls[1].options.headers["User-Agent"], /KdeJeMedved/);
  await search("Javorová cesta");
  assert.equal(calls.length, 3, "cached accent variants must not call the providers again");
});

test("natural areas, guideposts and local aliases are found; unrelated/foreign/invalid results are rejected", async () => {
  const search = createLocationSearch({ minIntervalMs: 0, fetchImpl: async (url) => response(
    String(url).includes("nominatim") ? [] : { elements: [
      { type: "node", lat: 48.96, lon: 20.42, tags: { name: "Javorová dolina", natural: "valley" } },
      { type: "node", lat: 48.97, lon: 20.41, tags: { name: "Rázcestie", alt_name: "Javorová dolina", information: "guidepost" } },
      { type: "node", lat: 48.96, lon: 20.42, tags: { name: "Javorová dolina", natural: "valley" } },
      { type: "node", lat: 48.96, lon: 20.42, tags: { name: "Javorová dolinka" } },
      { type: "node", lat: 50.96, lon: 14.42, tags: { name: "Javorová dolina" } },
      { type: "way", center: { lat: 48.96, lon: 20.42 }, tags: { name: "Javorová dolina" } },
    ] }
  ) });
  const results = await search("Javorova dolina");
  assert.deepEqual(results.map((hit) => hit.name), ["Javorová dolina", "Javorová dolina"]);
  assert.deepEqual(results.map((hit) => hit.type), ["valley", "guidepost"]);
});

test("qualified tourist queries keep the region bounding box and the Slovak area filter", async () => {
  let data;
  const search = createLocationSearch({ minIntervalMs: 0, fetchImpl: async (url, options) => {
    if (String(url).includes("nominatim")) {
      return response(new URL(url).searchParams.get("q") === "Slovenský raj" ? [{
        name: "Slovenský raj", lat: "48.9", lon: "20.4", category: "boundary",
        address: { country_code: "sk" }, boundingbox: ["48.8", "49.0", "20.3", "20.5"],
      }] : []);
    }
    data = options.body.get("data");
    return response({ elements: [{ ...route, members: [{ type: "way", geometry: [
      { lat: 48.95, lon: 20.39 }, { lat: 49.4, lon: 20.9 }, { lat: 49.5, lon: 21.0 },
    ] }] }] });
  } });
  const [hit] = await search("Javorová cesta, Slovenský raj");
  assert.equal(hit.name, "Javorová cesta");
  assert.equal(hit.lat, 48.95, "a long route marker must remain inside the requested region");
  assert.match(data, /nwr\(area\.sk\)\(48\.8,20\.3,49,20\.5\)/);
});

test("provider errors recover without caching failure or poisoning the queue", async () => {
  let broken = true;
  const search = createLocationSearch({ minIntervalMs: 0, fetchImpl: async (url) => {
    if (String(url).includes("nominatim")) return response([]);
    return response(broken ? { elements: [], remark: "runtime error: timeout" } : { elements: [route] });
  } });
  await assert.rejects(search("Javorová cesta"), /nedokončil/);
  broken = false;
  assert.equal((await search("Javorová cesta"))[0].name, "Javorová cesta");
});

test("Overpass still works if Nominatim is unavailable", async () => {
  const search = createLocationSearch({ minIntervalMs: 0, fetchImpl: async (url) =>
    response(String(url).includes("nominatim") ? {} : { elements: [route] }, String(url).includes("nominatim") ? 503 : 200)
  });
  assert.equal((await search("Javorová cesta"))[0].name, "Javorová cesta");
});

test("empty Overpass results cannot hide a Nominatim outage", async () => {
  const search = createLocationSearch({ minIntervalMs: 0, fetchImpl: async (url) =>
    response(String(url).includes("nominatim") ? {} : { elements: [] }, String(url).includes("nominatim") ? 503 : 200)
  });
  await assert.rejects(search("Javorová cesta"), /Nominatim.*503/);
});

test("a busy Overpass instance fails over to the secondary provider", async () => {
  const calls = [];
  const search = createLocationSearch({ minIntervalMs: 0, fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).includes("nominatim")) return response([]);
    if (String(url).includes("overpass-api.de")) return response({}, 504);
    return response({ elements: [route] });
  } });
  assert.equal((await search("Javorová cesta"))[0].name, "Javorová cesta");
  assert.match(calls[2], /overpass\.kumi\.systems/);
});

test("exact municipalities skip Overpass, concurrent searches share one request, and Nominatim is throttled", async () => {
  let requests = 0;
  let time = 0;
  const waits = [];
  const search = createLocationSearch({ now: () => time, sleep: async (ms) => { waits.push(ms); time += ms; },
    fetchImpl: async (url) => {
      requests++;
      assert.match(String(url), /nominatim/);
      const name = new URL(url).searchParams.get("q");
      return response([{ name, display_name: `${name}, Slovensko`, lat: "48.95", lon: "20.4", address: { country_code: "sk" } }]);
    },
  });
  await Promise.all([search("Hrabušice"), search("Hrabušice")]);
  await search("Letanovce");
  assert.equal(requests, 2);
  assert.deepEqual(waits, [1000]);
});

test("automatic localization never substitutes a municipality matching only part of a tourist name", async () => {
  const gz = { list: [{ name: "Suchá", lat: 48.4, lng: 19.3, type: "village", rank: 1 }] };
  assert.equal(lookupPlaceByName("Suchá Belá", gz, { exactOnly: true }), null);
  assert.equal(lookupPlaceByName("Sucha", gz, { exactOnly: true }).name, "Suchá");
  const resolve = (name) => resolveSlovakLocation(name, { searchLocations: async () => [
    { name: "Suchá", lat: 48.4, lng: 19.3 },
    { name: "Suchá Belá", lat: 48.94, lng: 20.38 },
  ] });
  assert.equal((await resolve("Suchá Belá")).lat, 48.94);
  assert.equal(await resolveSlovakLocation("Neznáma cesta", { searchLocations: async () => [{ name: "Neznáma", lat: 48.9, lng: 20.4 }] }), null);
});

test("article geocoding recognizes the inflected tourist place instead of the reporting municipality", async () => {
  const [item] = await geocodeNews([{
    title: "V Slovenskom raji poranil medveď bežca",
    body: "Jedinca stretol bežec na žltej turistickej trase na Kláštorskej ceste. Obec Hrabušice vyzvala ľudí na opatrnosť.",
  }]);
  assert.equal(item.place, "Kláštorská cesta");
  assert.equal(item.hasCoords, true);
  assert.equal(item.lat, 48.9526744);
  const [unrelated] = await geocodeNews([{ title: "Medvede na Slovensku", body: "Turistický chodník na Kláštorskej ceste vedie lesom." }]);
  assert.equal(unrelated.hasCoords, false);
});
