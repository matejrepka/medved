import { dedupeSightings } from "../sightings-dedupe.js";
import { fetchMapamedvedov } from "./mapamedvedov.js";
import { fetchSprejnamedveda } from "./sprejnamedveda.js";
import { fetchTumedved } from "./tumedved.js";

const SOURCES = [
  { key: "tumedved", label: "TuMedveď", fetcher: fetchTumedved },
  { key: "mapamedvedov", label: "MapaMedveďov", fetcher: fetchMapamedvedov },
  { key: "sprejnamedveda", label: "SprejNaMedveďa", fetcher: fetchSprejnamedveda },
];

function errorMessage(reason) {
  return reason?.message || String(reason || "Neznáma chyba");
}

/**
 * Zdroje sa načítavajú nezávisle. Výpadok jedného nezahodí dáta z ostatných;
 * výsledné pole nesie diagnostiku sourceOutcomes pre admin rozhranie.
 */
export async function fetchSightings() {
  const settled = await Promise.allSettled(SOURCES.map((source) => source.fetcher()));
  const sourceOutcomes = {};
  const allItems = [];

  settled.forEach((result, index) => {
    const source = SOURCES[index];
    if (result.status === "fulfilled") {
      sourceOutcomes[source.key] = {
        label: source.label,
        ok: true,
        status: "success",
        itemCount: result.value.length,
        stage: null,
        error: null,
      };
      allItems.push(...result.value);
    } else {
      sourceOutcomes[source.key] = {
        label: source.label,
        ok: false,
        status: "error",
        itemCount: null,
        stage: "fetch",
        error: errorMessage(result.reason),
      };
    }
  });

  if (!allItems.length && settled.every((result) => result.status === "rejected")) {
    const failure = new Error("Nepodarilo sa načítať žiadny zdroj hlásení");
    failure.sourceOutcomes = sourceOutcomes;
    throw failure;
  }

  const merged = dedupeSightings(allItems);
  Object.defineProperty(merged, "sourceOutcomes", {
    value: sourceOutcomes,
    enumerable: false,
  });
  return merged;
}
