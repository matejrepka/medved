import { dedupeSightings } from "./sightings-dedupe.js";

/**
 * Zlučuje iba hlásenia z máp a schválené používateľské hlásenia. Spravodajské
 * články patria výhradne do /api/news a nikdy sa nepripájajú ako zdroj hlásenia.
 */
export function mergeWarnings({ sightings = [], reports = [] }) {
  return dedupeSightings([...sightings, ...reports]);
}
