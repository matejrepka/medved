// Automatický štatistický report pre stránku /stats.
//
// Report sa počíta zo VŠETKÝCH dát (hlásenia z tumedved.sk + správy), nie len
// z toho, čo je pripnuté na mape. Vďaka gazetteeru (findPlaceMentions) nájdeme
// aj obce spomenuté v texte správ, ktoré mapa nepinla — napr. Klenovec sa tak
// objaví v štatistike, aj keď na mape značku nemá.

import { findPlaceMentions } from "./geo/geocode.js";

const TIMEZONE = "Europe/Bratislava";

const todInTimeZone = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
});

/** ISO reťazec -> { year, month, day, hour } v slovenskom časovom pásme. */
function localParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = todInTimeZone.formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return {
    year: Number(g("year")),
    month: Number(g("month")),
    day: Number(g("day")),
    hour: Number(g("hour")) % 24,
  };
}

/** Z používateľskej lokality vytiahne čistý názov obce ("Klenovec - okolie" -> "Klenovec"). */
function cleanLocation(text) {
  return String(text || "")
    .split(",")[0]
    .split(" - ")[0]
    .split("-")[0]
    .trim();
}

function addTimeOfDay(acc, hour) {
  if (hour >= 6 && hour < 10) acc["Ráno (06:00 - 09:59)"]++;
  else if (hour >= 10 && hour < 18) acc["Deň (10:00 - 17:59)"]++;
  else if (hour >= 18 && hour < 22) acc["Večer (18:00 - 21:59)"]++;
  else acc["Noc (22:00 - 05:59)"]++;
}

/**
 * Zostaví štatistický report z hlásení a správ.
 * @param {{sightings:Array, news:Array, gz:{index:Map}}} input
 */
export function buildStatsReport({ sightings, news, gz }) {
  const today = localParts(new Date().toISOString());

  const timeline = new Map(); // "YYYY-MM" -> { sightings, news }
  const timeOfDay = {
    "Noc (22:00 - 05:59)": 0,
    "Ráno (06:00 - 09:59)": 0,
    "Deň (10:00 - 17:59)": 0,
    "Večer (18:00 - 21:59)": 0,
  };
  const places = new Map(); // názov -> { name, lat, lng, sightings, news }
  let todaySightings = 0;

  const bumpTimeline = (key, type) => {
    if (!timeline.has(key)) timeline.set(key, { sightings: 0, news: 0 });
    timeline.get(key)[type]++;
  };

  const monthKey = (lp) => `${lp.year}-${String(lp.month).padStart(2, "0")}`;

  const place = (name, lat, lng) => {
    let p = places.get(name);
    if (!p) {
      p = { name, lat: lat ?? null, lng: lng ?? null, sightings: 0, news: 0 };
      places.set(name, p);
    } else if (p.lat == null && lat != null) {
      p.lat = lat;
      p.lng = lng;
    }
    return p;
  };

  // --- Hlásenia (tumedved.sk) ---
  for (const s of sightings) {
    const lp = localParts(s.reportedAt);
    if (lp) {
      bumpTimeline(monthKey(lp), "sightings");
      addTimeOfDay(timeOfDay, lp.hour);
      if (today && lp.year === today.year && lp.month === today.month && lp.day === today.day) {
        todaySightings++;
      }
    }

    const cleaned = cleanLocation(s.location);
    if (cleaned.length > 2) {
      // Lokalita hlásenia je smerodajná. Skúsime ju zladiť s gazetteerom kvôli
      // kanonickému názvu (aby sa hlásenia a správy o tej istej obci zlúčili),
      // inak započítame vyčistený text tak, ako je.
      const matches = findPlaceMentions(cleaned, "", gz);
      if (matches.length) place(matches[0].name, matches[0].lat, matches[0].lng).sightings++;
      else place(cleaned, null, null).sightings++;
    }
  }

  // --- Správy (Google News + pozormedved.sk) ---
  for (const n of news) {
    const lp = localParts(n.date);
    if (lp) bumpTimeline(monthKey(lp), "news");

    const mentions = findPlaceMentions(n.title, n.snippet || "", gz);
    for (const m of mentions) {
      place(m.name, m.lat, m.lng).news++;
    }
  }

  const timelineArr = [...timeline.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, sightings: v.sightings, news: v.news }));

  const topLocations = [...places.values()]
    .map((p) => ({ ...p, total: p.sightings + p.news }))
    .sort((a, b) => b.total - a.total || b.sightings - a.sightings);

  return {
    totals: {
      sightings: sightings.length,
      news: news.length,
      todaySightings,
      places: places.size,
    },
    topPlace: topLocations.length ? topLocations[0].name : null,
    topLocations: topLocations.slice(0, 12),
    timeline: timelineArr,
    timeOfDay,
  };
}
