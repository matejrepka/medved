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

// Časté slová v správach o medveďoch, ktoré (s veľkým písmenom na začiatku vety)
// splývajú s názvami obcí: lesník→Lesné, brutálny→Bruty, turista→Turie…
const STOPWORD_STEMS = [
  "lesnik", "brutal", "turist", "senior", "horar", "zachranar", "polovn",
  "obyvatel", "starost", "primator", "hovorky", "riadit", "minist", "zoolog",
  "hasic", "policia", "ochranar", "zasahovy", "spravca", "rodina", "clovek",
];
function isStopword(w) {
  return STOPWORD_STEMS.some((s) => w.startsWith(s));
}

// Kmene slov (jednoslovné), ktoré pri OBCI naznačujú skutočný výskyt/incident
// s medveďom — nie všeobecný článok/rozhovor. Kontrolujú sa LOKÁLNE, v okne
// okolo názvu obce, aby "letný tábor pri Prešove" neprešlo ako výskyt v Prešove.
const OCCURRENCE_STEMS = [
  "napad", "zautoc", "utoc", "utok", "zran", "usmrt", "roztrh", "dolap",
  "vid", "spozor", "pozor", "zbad", "zazr", "zahliad", "pohyb",
  "prechadz", "zatul", "vosiel", "vbehol", "vtrhol", "potul", "vyskyt",
  "stretn", "stret", "naraz", "nahan", "sidlisk", "obydl", "zahrad", "dvor",
  "kontajner", "ovc", "ulik", "ulic", "vcel", "stado", "mlad", "brloh",
  "zastrel", "strel", "odstrel", "zabil", "ulov", "zahryz", "dohryz",
  "vystras", "vydes", "prelak", "spanik", "pobeh", "pribliz", "blizil",
  "zablud", "objav", "premav", "skod", "napach", "varov", "vystrah",
  "hroz", "zasah", "odchyt", "usp", "plasil",
];

function isOccurrenceToken(w) {
  return OCCURRENCE_STEMS.some((s) => w.startsWith(s));
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
  const diff = Math.abs(txt.length - gaz.length);
  if (diff > 3) return -1;
  const cp = commonPrefixLen(gaz, txt);
  if (cp < Math.max(4, Math.ceil(gaz.length * 0.75))) return -1;
  if (txt.endsWith("ak") && txt !== gaz) return -1;
  // Ak je celý názov len prefixom dlhšieho slova, povoľ len bežné pádové
  // koncovky. Tým odfiltrujeme zdroje/demonyma typu "Prešovak" -> Prešov.
  if (cp === gaz.length && txt.length > gaz.length) {
    const extra = txt.slice(gaz.length);
    if (
      !["a", "e", "i", "u", "y", "m", "mi"].includes(extra) &&
      !/(om|ou|ej|och|ach|iach)$/.test(txt)
    ) {
      return -1;
    }
  }
  // Rozdiel dĺžok 3 povolíme len pri množných lokatívoch (-ach/-iach/-och) ako
  // "Košiciach", "Leviciach" — inak by "Brutálny"→Bruty, "Turistom"→Turie prešli.
  if (diff === 3 && !/(iach|ach|och)$/.test(txt)) return -1;
  return cp;
}

function nounInflectionBonus(gaz, txt) {
  const variants = new Set([txt]);

  if (txt.endsWith("ovej")) variants.add(`${txt.slice(0, -4)}ova`);
  if (txt.endsWith("ovou")) variants.add(`${txt.slice(0, -4)}ova`);
  if (txt.endsWith("ou") && txt.length > 5) variants.add(`${txt.slice(0, -2)}a`);
  if (txt.endsWith("om") && txt.length > 5) variants.add(txt.slice(0, -1));
  if (txt.endsWith("ke") && txt.length > 5) variants.add(`${txt.slice(0, -2)}ka`);
  if (txt.endsWith("ici") && txt.length > 6) variants.add(`${txt.slice(0, -3)}ica`);
  if (txt.endsWith("ni") && txt.length > 5) variants.add(`${txt.slice(0, -1)}a`);
  if (txt.endsWith("i") && txt.length > 5) variants.add(txt.slice(0, -1));
  if (txt.endsWith("e") && txt.length > 5) variants.add(`${txt.slice(0, -1)}a`);

  return variants.has(gaz) ? 24 : 0;
}

// Obce, ktorých názov je zároveň bežné krstné meno — vyžadujeme cue ("v meste
// Martin"), inak by "lesníka Martina napadol medveď" pinlo mesto Martin.
const NAME_TOWNS = new Set(["martin", "michal", "vlasta", "stara"]);

// "v okrese X" a "X okrese" nie je presná obec. Ak článok nemá nič lepšie,
// radšej ho necháme bez pinu než mapovať stred okresného mesta.
const REGION_BEFORE = new Set([
  "okres", "okrese", "okresu", "okresom",
  "kraj", "kraji", "kraja", "krajom",
  "region", "regione", "regionu", "vuc",
]);

// Slová za názvom, ktoré z neho robia prídavné meno kraja/okresu, nie obec.
const REGION_AFTER = /^(kraj|okres|region|samospr|vuc)/;

// Slabší lokálny signál než "v obci X", ale silnejší než obyčajná zmienka.
const LOCAL_PREPOSITIONS = new Set([
  "v", "vo", "na", "pri", "nad", "pod", "za", "medzi",
  "nedaleko", "blizko", "okolo", "popri",
]);

const COMMON_FIRST_NAMES = new Set([
  "jan", "jana", "martin", "michal", "peter", "pavol", "jozef", "juraj",
  "marek", "lukas", "tomas", "igor", "roman", "andrej", "milan", "miroslav",
  "frantisek", "maria", "zuzana", "katarina", "eva", "anna", "monika",
]);

const PERSON_ROLE_STEMS = [
  // "minist" (nie "minister") aj kvôli skloňovaniu "ministrom", "ministra".
  "minist", "poslan", "riadit", "hovorc", "policajt", "hasic", "ochranar",
  "lesnik", "horar", "polovn", "turist", "muz", "zena",
];

const SPEECH_STEMS = [
  "poved", "uvied", "dodal", "informov", "vysvetl", "konstat", "pribliz",
  "reagov", "napisal", "ozrejm", "tvrd",
];

function hasStem(w, stems) {
  return stems.some((s) => w.startsWith(s));
}

function isPersonContext(tokens, start, end, segmentStart, segmentEnd) {
  const prev = start > segmentStart ? tokens[start - 1] : null;
  const prev2 = start - 2 >= segmentStart ? tokens[start - 2] : null;
  const next = end + 1 <= segmentEnd ? tokens[end + 1] : null;
  const next2 = end + 2 <= segmentEnd ? tokens[end + 2] : null;

  if (prev?.cap && COMMON_FIRST_NAMES.has(prev.w)) return true;
  if (prev2?.cap && COMMON_FIRST_NAMES.has(prev2.w) && prev?.cap) return true;
  if (prev && hasStem(prev.w, PERSON_ROLE_STEMS)) return true;
  if (prev2 && hasStem(prev2.w, PERSON_ROLE_STEMS) && prev?.cap) return true;
  if (next && hasStem(next.w, SPEECH_STEMS)) return true;
  if (next2 && hasStem(next2.w, SPEECH_STEMS)) return true;
  if (prev && hasStem(prev.w, SPEECH_STEMS)) return true;
  return false;
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

  // Nadpis dáme prvý — lokalita v titulku je zvyčajne tá hlavná. Telo nasleduje
  // a presnejšiu obec presadí cez cue ("v obci X"), ktoré má najvyššiu váhu.
  const titleTokens = tokenize(title || "");
  const bodyTokens = tokenize(body || "");
  const tokens = titleTokens.concat(bodyTokens);
  const titleLen = titleTokens.length;

  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.cap || tok.w.length < 4) continue; // názov obce je vlastné meno
    if (isBearWord(tok.w) || isStopword(tok.w)) continue;
    const candidates = index.get(tok.w.slice(0, 4));
    if (!candidates) continue;

    for (const place of candidates) {
      const parts = place.parts;
      const noun = parts[parts.length - 1];
      const cp = nounMatchLen(noun, tok.w);
      if (cp < 0) continue;

      const inTitle = i < titleLen;
      const segmentStart = inTitle ? 0 : titleLen;
      const segmentEnd = inTitle ? titleLen - 1 : tokens.length - 1;

      // "Bystrickom kraji", "Žilinskom okrese" — prídavné meno kraja, nie obec.
      const next = i + 1 <= segmentEnd ? tokens[i + 1] : null;
      if (next && REGION_AFTER.test(next.w)) continue;

      // Skontroluj prídavné mená pred podstatným menom (viacslovné názvy).
      const start = i - (parts.length - 1);
      if (start < 0) continue;
      if (start < segmentStart) continue;

      let ok = true;
      for (let j = 0; j < parts.length - 1; j++) {
        const t = tokens[start + j];
        if (!t || !t.cap || !headMatch(parts[j], t.w)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const prev = start > segmentStart ? tokens[start - 1] : null;
      if (prev && REGION_BEFORE.has(prev.w)) continue;

      const cueBefore = !!prev && CUE_WORDS.has(prev.w);
      const prepBefore = !!prev && LOCAL_PREPOSITIONS.has(prev.w);
      if (!cueBefore && isPersonContext(tokens, start, i, segmentStart, segmentEnd))
        continue;

      // Názov = krstné meno (Martin…) berieme ako obec len s cue pred ním.
      if (parts.length === 1 && NAME_TOWNS.has(noun) && !cueBefore) continue;

      // Veľmi krátke názvy dedín (≤4 znaky: Háj, Lúka, Brod…) bez cue sú priveľmi
      // rizikové — berieme ich len s cue ("v obci Háj").
      if (parts.length === 1 && place.rank === 1 && noun.length < 5 && !cueBefore)
        continue;

      // LOKÁLNY kontext výskytu: v okne okolo názvu obce musí byť buď cue slovo
      // ("v obci/meste X"), alebo incidentné slovo (napadol, videli, pohyboval…).
      // Bez toho je zmienka obce len mimochodom (napr. "tábor pri Prešove").
      let contextOk = cueBefore;
      let occurrenceNear = false;
      let bearBefore = false;
      if (!contextOk) {
        const lo = Math.max(segmentStart, start - 5);
        const hi = Math.min(segmentEnd, i + 8);
        for (let k = lo; k <= hi; k++) {
          if (k < start && isBearWord(tokens[k].w)) bearBefore = true;
          if (isOccurrenceToken(tokens[k].w)) {
            occurrenceNear = true;
            contextOk = true;
            break;
          }
          if (CUE_WORDS.has(tokens[k].w)) contextOk = true;
        }
        if (!contextOk && inTitle && prepBefore && bearBefore) contextOk = true;
      }
      if (!contextOk) continue;

      // Presnosť zhody (cp − rozdiel dĺžok) rozhodne medzi podobnými obcami
      // (napr. exaktné "Stráňavy" vs blízke "Stráňany").
      const exactness =
        cp * 1.5 -
        Math.abs(noun.length - tok.w.length) * 2 +
        nounInflectionBonus(noun, tok.w);
      // Poradie váh: cue "v obci X" (telo aj titulok) > lokalita v titulku >
      // presnosť/typ. Titulok tak prebije šum v tele, no explicitné "v obci X"
      // v tele prebije všeobecný titulok.
      const score =
        (cueBefore ? 1000 : 0) +
        (prepBefore ? (inTitle ? 60 : 340) : 0) +
        (inTitle ? 220 : 0) +
        (occurrenceNear ? 40 : 0) +
        (parts.length > 1 ? 60 : 0) +
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
 * Priame vyhľadanie obce podľa NÁZVU — pre administráciu, kde lokalitu zadáva
 * človek (nie scraper). Na rozdiel od findPlace neskenuje kontext výskytu, len
 * porovná zadaný názov s gazetteerom (bez diakritiky). Pri zhode na začiatok
 * (napr. "Banská" → "Banská Bystrica") uprednostní vyšší rank (mesto > obec) a
 * najkratší zodpovedajúci názov.
 *
 * @param {string} name  zadaný názov obce/mesta
 * @param {{list:Array}} gz  predspracovaný gazetteer
 * @returns {{name,lat,lng,type}|null}
 */
export function lookupPlaceByName(name, gz) {
  const list = gz?.list;
  if (!list || !list.length || !name) return null;

  const q = denorm(String(name)).replace(/\s+/g, " ").trim();
  if (!q) return null;

  let exact = null;
  let prefix = null;
  for (const p of list) {
    const pn = denorm(p.name).replace(/\s+/g, " ").trim();
    if (pn === q) {
      if (!exact || p.rank > exact.rank) exact = p;
    } else if (pn.startsWith(q) || q.startsWith(pn)) {
      const better =
        !prefix ||
        p.rank > prefix.rank ||
        (p.rank === prefix.rank && p.name.length < prefix.name.length);
      if (better) prefix = p;
    }
  }

  const best = exact || prefix;
  if (!best) return null;
  return { name: best.name, lat: best.lat, lng: best.lng, type: best.type };
}

/**
 * Nájde v texte VŠETKY spomenuté slovenské obce — voľnejšie ako findPlace.
 *
 * Kým findPlace vyberie JEDNU najpravdepodobnejšiu obec pre značku na mape (a
 * preto vyžaduje kontext skutočného výskytu medveďa), tu zbierame všetky zmienky
 * pre štatistiku. Vďaka tomu sa do reportu dostane aj obec ako Klenovec, ktorú
 * mapa nepinla, lebo si ňou nebola dosť istá. Stačí, že je obec v titulku, po
 * predložke ("v Klenovci") alebo pri cue slove. Falošné zhody (priezviská,
 * kraje, bežné slová) naďalej filtrujeme rovnakými strážami ako findPlace.
 *
 * @param {string} title  nadpis / hlavný text
 * @param {string} body   doplnkový text (snippet/telo), môže byť prázdny
 * @param {{index:Map}} gz  predspracovaný gazetteer
 * @returns {Array<{name,lat,lng,type}>} unikátne obce v poradí prvého výskytu
 */
export function findPlaceMentions(title, body, gz) {
  const { index } = gz;
  if (!index || index.size === 0) return [];

  const titleTokens = tokenize(title || "");
  const bodyTokens = tokenize(body || "");
  const tokens = titleTokens.concat(bodyTokens);
  const titleLen = titleTokens.length;

  const found = new Map(); // názov obce -> {name,lat,lng,type}

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.cap || tok.w.length < 4) continue; // názov obce je vlastné meno
    if (isBearWord(tok.w) || isStopword(tok.w)) continue;
    const candidates = index.get(tok.w.slice(0, 4));
    if (!candidates) continue;

    // Pre danú pozíciu vyberieme JEDNU najlepšiu obec — inak by "Brezno" zhltlo
    // aj "Breza" a "Klenovec" aj "Klenová". Skórujeme presnosťou zhody rovnako
    // ako findPlace, len bez globálneho víťaza — víťaz je lokálny pre pozíciu.
    let bestPlace = null;
    let bestScore = -Infinity;

    for (const place of candidates) {
      const parts = place.parts;
      const noun = parts[parts.length - 1];
      const cp = nounMatchLen(noun, tok.w);
      if (cp < 0) continue;

      const inTitle = i < titleLen;
      const segmentStart = inTitle ? 0 : titleLen;
      const segmentEnd = inTitle ? titleLen - 1 : tokens.length - 1;

      const next = i + 1 <= segmentEnd ? tokens[i + 1] : null;
      if (next && REGION_AFTER.test(next.w)) continue;

      const start = i - (parts.length - 1);
      if (start < 0 || start < segmentStart) continue;

      let ok = true;
      for (let j = 0; j < parts.length - 1; j++) {
        const t = tokens[start + j];
        if (!t || !t.cap || !headMatch(parts[j], t.w)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const prev = start > segmentStart ? tokens[start - 1] : null;
      if (prev && REGION_BEFORE.has(prev.w)) continue;

      const cueBefore = !!prev && CUE_WORDS.has(prev.w);
      const prepBefore = !!prev && LOCAL_PREPOSITIONS.has(prev.w);

      if (!cueBefore && isPersonContext(tokens, start, i, segmentStart, segmentEnd)) continue;
      if (parts.length === 1 && NAME_TOWNS.has(noun) && !cueBefore) continue;
      if (parts.length === 1 && place.rank === 1 && noun.length < 5 && !cueBefore) continue;

      // Kontext zmienky je voľnejší než pri findPlace: stačí titulok, predložka,
      // cue slovo, alebo incidentné slovo v okolí. Plytké zmienky v tele bez
      // žiadneho z týchto signálov ignorujeme (znižuje šum).
      let contextOk = cueBefore || prepBefore || inTitle;
      if (!contextOk) {
        const lo = Math.max(segmentStart, start - 5);
        const hi = Math.min(segmentEnd, i + 8);
        for (let k = lo; k <= hi; k++) {
          if (isOccurrenceToken(tokens[k].w) || CUE_WORDS.has(tokens[k].w)) {
            contextOk = true;
            break;
          }
        }
      }
      if (!contextOk) continue;

      const score =
        cp * 1.5 -
        Math.abs(noun.length - tok.w.length) * 2 +
        nounInflectionBonus(noun, tok.w) +
        (parts.length > 1 ? 60 : 0) +
        place.rank;

      if (score > bestScore) {
        bestScore = score;
        bestPlace = place;
      }
    }

    if (bestPlace && !found.has(bestPlace.name)) {
      found.set(bestPlace.name, {
        name: bestPlace.name,
        lat: bestPlace.lat,
        lng: bestPlace.lng,
        type: bestPlace.type,
      });
    }
  }

  return [...found.values()];
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
    const noPlace = { ...it, place: null, lat: null, lng: null, hasCoords: false };
    // findPlace dá výsledok len ak je obec v kontexte skutočného výskytu.
    const hit = findPlace(it.title, body, gz);
    if (!hit) return noPlace;
    return { ...it, place: hit.name, lat: hit.lat, lng: hit.lng, hasCoords: true };
  });
}

export { loadPlaces };
