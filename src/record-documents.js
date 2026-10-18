import { createHash } from "node:crypto";

export function recordToken(id) {
  return createHash("sha256").update(String(id || "record")).digest("hex").slice(0, 10);
}

const placeSlug = value => String(value || "").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replaceAll("ľ", "l").replaceAll("ĺ", "l")
  .replaceAll("ŕ", "r").replace(/[^a-z0-9]+/g, " ").trim().replaceAll(" ", "-");

// Runs only in the background publisher. Public detail requests receive one
// indexed document, including a bounded set of related cards and location links.
export function buildRecordDocuments({ warnings = [], news = [], locations = [] }) {
  const locationSlugs = new Set(locations.map(location => location.slug));
  const warningPool = warnings.map(item => ({ ...item, archiveType: "warning" }))
    .concat(news.filter(item => item.category === "warning").map(item => ({ ...item, archiveType: "news" })))
    .sort((a, b) => new Date(b.reportedAt || b.date || 0) - new Date(a.reportedAt || a.date || 0));
  const documents = {};
  const document = (record, recordType, pool) => {
    const places = recordType === "warning" ? [record.location] :
      record.locations?.length ? record.locations.map(location => location.place) : [record.place];
    return { record, recordType,
      related: pool.filter(item => String(item.id) !== String(record.id)).slice(0, 4),
      locations: [...new Set(places.map(placeSlug))].filter(slug => locationSlugs.has(slug)).map(slug => ({ slug })),
    };
  };
  for (const item of news) {
    documents[`news:${recordToken(item.id)}`] = document(item, "news", news);
    if (item.category === "warning") documents[`warning:${recordToken(item.id)}`] = document(item, "news", warningPool);
  }
  for (const item of warnings) {
    const saved = document(item, "warning", warningPool);
    for (const id of new Set([item.id, ...(item.bucketMemberIds || [])])) {
      documents[`warning:${recordToken(id)}`] = saved;
    }
  }
  return documents;
}
