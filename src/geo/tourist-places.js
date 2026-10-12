// Miestne názvy, ktoré mapové služby neindexujú pod názvom používaným v správach.
// Súradnice označujú overený bod na trase, nie presné miesto incidentu.
export const TOURIST_PLACES = Object.freeze([
  {
    name: "Kláštorská cesta",
    aliases: ["Kláštorskej ceste", "Kláštorskú cestu", "Kláštorskou cestou"],
    region: "Slovenský raj",
    regionAliases: ["Slovenskom raji", "Slovenského raja"],
    lat: 48.9526744,
    lng: 20.3988546,
    type: "hiking",
    precision: "route",
    // Žltý úsek 8886, Nad Podleskom – Pod Kláštoriskom, ktorý je súčasťou
    // spojenia Podlesok – Kláštorisko. Bod je priamo na OSM way 66919768.
    osmUrl: "https://www.openstreetmap.org/relation/1706003",
    referenceUrl: "https://www.npslovenskyraj.sk/turistika/",
    nameSourceUrl: "https://www.kosicak.sk/clanky/14466/vo-vyhladavanej-turistickej-lokalite-v-slovenskom-raji-poranil-medved-bezca-po-selme-patra-zasahovy-tim",
  },
]);

export function normalizePlaceQuery(value) {
  return String(value || "").toLocaleLowerCase("sk").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function asResult(place) {
  return {
    name: place.name,
    label: `${place.name}, ${place.region}, Slovensko — orientačný bod na trase`,
    lat: place.lat,
    lng: place.lng,
    type: place.type,
    precision: place.precision,
    source: "tourist-gazetteer",
  };
}

export function searchTouristPlaces(query) {
  const normalized = normalizePlaceQuery(query);
  return TOURIST_PLACES.filter((place) => {
    const names = [place.name, ...place.aliases].map(normalizePlaceQuery);
    const regions = [place.region, ...place.regionAliases].map(normalizePlaceQuery);
    return names.some((name) => normalized === name || regions.some((region) =>
      [" ", " v ", " vo "].some((separator) => normalized === name + separator + region)
    ));
  }).map(asResult);
}

// Presnú turistickú lokalitu uprednostníme pred obcou spomenutou ako kontext.
// Vyžadujeme miestnu predložku aj zmienku o výskyte v bezprostrednom okolí.
export function findTouristPlace(title, body) {
  const mentionsBear = /\b(?:medved\w*|selm\w*)\b/.test(normalizePlaceQuery(`${title || ""} ${body || ""}`));
  if (!mentionsBear) return null;
  for (const text of [title, body]) {
    const normalized = normalizePlaceQuery(text);
    for (const place of TOURIST_PLACES) {
      for (const alias of [place.name, ...place.aliases]) {
        const name = normalizePlaceQuery(alias);
        const re = new RegExp(`\\b(?:na|pri|po|v|vo) ${name}\\b`, "g");
        for (const match of normalized.matchAll(re)) {
          const nearby = normalized.slice(Math.max(0, match.index - 140), match.index + match[0].length + 140);
          if (/\b(?:stret\w*|napad\w*|poran\w*|zran\w*|vyskyt\w*|pohyb\w*|spozor\w*|videl\w*|varov\w*)\b/.test(nearby)) {
            return asResult(place);
          }
        }
      }
    }
  }
  return null;
}
