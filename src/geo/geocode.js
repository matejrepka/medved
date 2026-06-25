// Lokálne geokódovanie správ — z nadpisu a tela článku zistí, o akú slovenskú
// obec/mesto ide, a vráti jej súradnice. Žiadne sieťové dopyty: porovnávame len
// s gazetteerom (sk-places.json), ktorý obsahuje všetky obce SR a zostaví sa
// vopred (build-gazetteer.mjs).
//
// Výzvy a ako ich riešime:
//  • Skloňovanie ("v Ružomberku", "pri Brezne") — neporovnávame presne, ale
//    tolerujeme zmenu koncovky (zhoda podľa kmeňa).
//  • Falošné zhody (obce ako "Lúka", "Háj", "Brod" splývajú s bežnými slovami)
//    — vyžadujeme veľké začiatočné písmeno (vlastné meno) a skórujeme zhody:
//    "v obci X", "starosta X" či výskyt v tele článku majú prednosť.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PLACES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sk-places.json"
);

const RANK = { city: 3, town: 2, village: 1 };

// Slová, ktoré pred názvom signalizujú konkrétnu obec (nie širší región).
// Zámerne BEZ "okres" — ten označuje väčší celok než samotnú obec.
const CUE_WORDS = new Set([
  "obec", "obce", "obci", "obcou", "obcami",
  "dedina", "dedine", "dediny", "dedinka", "dedinke",
  "mesto", "meste", "mesta", "mestom", "mestecko", "mesteku",
  "kataster", "katastri", "chotar", "chotari",
  "starosta", "starostka", "starostu", "starostom", "primator", "primatora",
  "obyvatelia", "obyvatelov", "obyvatelmi",
]);

/** Text -> malé písmená, bez diakritiky. */
function denorm(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Medvedie výrazy NIKDY nie sú lokalita — v tejto appke sú takmer v každom
// titulku a inak by splývali s obcami ako Medvedie, Medvedzie, Medveďov.
function isBearWord(w) {
  return w.startsWith("medved") || w.startsWith("grizl") || w.startsWith("ursus");
}

/**
 * Rozdelí text na slová so zachovaním informácie o veľkom začiatočnom písmene.
 * @returns {Array<{w:string, cap:boolean}>}
 */
function tokenize(text) {
  const tokens = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(text || ""))) {
    const orig = m[0];
    tokens.push({ w: denorm(orig), cap: /\p{Lu}/u.test(orig[0]) });
  }
  return tokens;
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Dĺžka spoločného kmeňa, ak sa textové slovo `txt` zhoduje s názvom obce `gaz`
 * aj pri inom skloňovaní; inak -1. Vyžadujeme aspoň ~75 % spoločného začiatku
 * (pomer, nie pevný počet) — to prepustí "Košiciach", "Ružomberku", "Tatrách",
 * ale zamietne náhodné slová ako "poľovníka" (vs obec "Poloma"/"Polomka").
 */
function nounMatchLen(gaz, txt) {
  if (txt.length < 4 || gaz.length < 4) return -1;
  if (Math.abs(txt.length - gaz.length) > 3) return -1;
  const cp = commonPrefixLen(gaz, txt);
  return cp >= Math.max(4, Math.ceil(gaz.length * 0.75)) ? cp : -1;
}

/** Prídavné meno / prvé slovo viacslovného názvu — stačí zhoda kmeňa. */
function headMatch(gaz, txt) {
  const stem = gaz.slice(0, Math.min(4, gaz.length));
  return txt.length >= stem.length && txt.startsWith(stem);
}

let placesPromise = null;

/** Načíta gazetteer, predspracuje a vytvorí index podľa prvých 4 znakov názvu. */
function loadPlaces() {
  if (!placesPromise) {
    placesPromise = readFile(PLACES_PATH, "utf8")
      .then((raw) => JSON.parse(raw))
      .then((arr) => {
        const list = arr.map((p) => {
          const parts = denorm(p.name).split(/[^a-z0-9]+/).filter(Boolean);
          return { ...p, parts, rank: RANK[p.type] || 1 };
        });
        // index: prvé 4 znaky posledného slova (podstatného mena) -> obce
        const index = new Map();
        for (const p of list) {
          if (!p.parts.length) continue;
          const noun = p.parts[p.parts.length - 1];
          if (noun.length < 4) continue; // priveľmi krátke = nespoľahlivé
          const key = noun.slice(0, 4);
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(p);
        }
        return { list, index };
      })
      .catch((err) => {
        console.warn(`geocode: gazetteer sa nepodarilo načítať — ${err.message}`);
        return { list: [], index: new Map() };
      });
  }
  return placesPromise;
}

/**
 * Nájde v texte (nadpis + telo článku) slovenskú obec.
 * Telo má prednosť pred nadpisom; "v obci X"/"starosta X" silno boostuje zhodu.
 *
 * @param {string} title  nadpis článku
 * @param {string} body   text článku (bez reklám/odkazov), môže byť prázdny
 * @param {{index:Map}} gz  predspracovaný gazetteer
 * @returns {{name,lat,lng,type}|null}
 */
export function findPlace(title, body, gz) {
  const { index } = gz;
  if (!index || index.size === 0) return null;

  // Telo dáme prvé (skoršie pozície = vyššia priorita), nadpis za neho.
  const bodyTokens = tokenize(body || "");
  const titleTokens = tokenize(title || "");
  const tokens = bodyTokens.concat(titleTokens);
  const bodyLen = bodyTokens.length;

  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.cap || tok.w.length < 4) continue; // názov obce je vlastné meno
    if (isBearWord(tok.w)) continue; // "Medveď" nie je obec Medvedie
    const candidates = index.get(tok.w.slice(0, 4));
    if (!candidates) continue;

    for (const place of candidates) {
      const parts = place.parts;
      const noun = parts[parts.length - 1];
      const cp = nounMatchLen(noun, tok.w);
      if (cp < 0) continue;

      // Skontroluj prídavné mená pred podstatným menom (viacslovné názvy).
      const start = i - (parts.length - 1);
      if (start < 0) continue;
      let ok = true;
      for (let j = 0; j < parts.length - 1; j++) {
        const t = tokens[start + j];
        if (!t || !t.cap || !headMatch(parts[j], t.w)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const cueBefore = start > 0 && CUE_WORDS.has(tokens[start - 1].w);
      const inBody = i < bodyLen;
      // Presnosť zhody (cp − rozdiel dĺžok) rozhodne medzi podobnými obcami
      // (napr. exaktné "Stráňavy" vs blízke "Stráňany").
      const exactness = cp * 1.5 - Math.abs(noun.length - tok.w.length) * 2;
      const score =
        (cueBefore ? 1000 : 0) +
        (parts.length > 1 ? 60 : 0) +
        (inBody ? 120 : 0) +
        exactness +
        place.rank -
        start * 0.02;

      if (score > bestScore) {
        bestScore = score;
        best = place;
      }
    }
  }

  if (!best) return null;
  return { name: best.name, lat: best.lat, lng: best.lng, type: best.type };
}

/**
 * Doplní k zoznamu článkov geo údaje na základe nadpisu a (voliteľne) tela.
 * @param {Array} items  články; každý môže mať { title, snippet, body }
 * @returns {Promise<Array>} tie isté články doplnené o { place, lat, lng, hasCoords }
 */
export async function geocodeNews(items) {
  const gz = await loadPlaces();
  if (!gz.list.length) return items.map((it) => ({ ...it, hasCoords: false }));

  return items.map((it) => {
    const body = it.body || it.snippet || "";
    const hit = findPlace(it.title, body, gz);
    if (!hit) return { ...it, place: null, lat: null, lng: null, hasCoords: false };
    return { ...it, place: hit.name, lat: hit.lat, lng: hit.lng, hasCoords: true };
  });
}

export { loadPlaces };
