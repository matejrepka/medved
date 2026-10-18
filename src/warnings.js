import { sightingSourceLinks } from "./sightings-dedupe.js";

export const warningRecordKey = item => item.sourceType === "report"
  ? `report:${String(item.id).replace(/^report-/, "")}` : `sighting:${item.id}`;

/**
 * Zlučuje iba hlásenia z máp a schválené používateľské hlásenia. Spravodajské
 * články patria výhradne do /api/news a nikdy sa nepripájajú ako zdroj hlásenia.
 */
export function mergeWarnings({ sightings = [], reports = [], buckets = [] }) {
  const items = [...sightings, ...reports];
  const byKey = new Map(items.map(item => [warningRecordKey(item), item]));
  const grouped = new Map();
  const consumed = new Set();
  // Only explicit persisted links are projected. No dates, coordinates or text
  // are compared. Rejected/deleted members are absent from the approved inputs.
  for (const bucket of buckets) {
    const members = bucket.memberKeys.map(key => byKey.get(key)).filter(Boolean);
    if (!members.length) continue;
    const primary = members.find(item => warningRecordKey(item) === bucket.primaryKey) || members[0];
    const sourceLinks = sightingSourceLinks({ ...primary, sourceLinks: members.flatMap(sightingSourceLinks) });
    grouped.set(warningRecordKey(primary), { ...primary, bucketId: bucket.id,
      bucketMemberIds: members.map(item => item.id), sourceLinks,
      mergedSourceCount: new Set(sourceLinks.map(link => link.key)).size });
    for (const member of members) consumed.add(warningRecordKey(member));
  }
  return items.flatMap(item => {
    const key = warningRecordKey(item);
    return grouped.has(key) ? [grouped.get(key)] : consumed.has(key) ? [] : [item];
  }).sort((a, b) => new Date(b.reportedAt || 0) - new Date(a.reportedAt || 0));
}
