export const MAPAMEDVEDOV_ATTRIBUTION = Object.freeze({
  label: "mapamedveďov.sk",
  url: "https://mapamedvedov.sk/",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  changes: "Údaje boli spracované: zjednotený formát, prípadne zlúčené duplicitné záznamy.",
});

export const TUMEDVED_ATTRIBUTION = Object.freeze({
  label: "tumedved.sk",
  url: "https://tumedved.sk/",
});

function isSource(link, key, hosts) {
  if (link?.key === key) return true;
  try {
    return hosts.includes(new URL(link?.url).hostname);
  } catch {
    return false;
  }
}

export function isMapamedvedovSource(link) {
  return isSource(link, "mapamedvedov", ["mapamedvedov.sk", "www.mapamedvedov.sk"]);
}

export function attributeSourceLink(link) {
  if (isSource(link, "tumedved", ["tumedved.sk", "www.tumedved.sk"])) {
    return { ...link, label: TUMEDVED_ATTRIBUTION.label };
  }
  if (!isMapamedvedovSource(link)) return link;
  return { ...link, label: MAPAMEDVEDOV_ATTRIBUTION.label,
    license: MAPAMEDVEDOV_ATTRIBUTION.license,
    licenseUrl: MAPAMEDVEDOV_ATTRIBUTION.licenseUrl,
    changes: MAPAMEDVEDOV_ATTRIBUTION.changes };
}

function attributionsForSource(item, source, key, hosts) {
  const matches = link => isSource(link, key, hosts);
  const storedLinks = item?.sourceLinks || item?.payload?.sourceLinks;
  const links = Array.isArray(storedLinks) ? [...storedLinks] : [];
  if (item?.url) links.push({ key: item.sourceKey, url: item.url });
  const sourceName = String(item?.source || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (item?.sourceKey === key || hosts.includes(sourceName)) {
    if (!links.some(matches)) links.push({ key });
  }
  if (!links.some(matches)) return [];
  const urls = new Set();
  for (const link of links.filter(matches)) {
    try {
      const url = new URL(link.url);
      if (["http:", "https:"].includes(url.protocol)
        && hosts.includes(url.hostname)) urls.add(url.href);
    } catch { /* Use the source homepage if no original link is available. */ }
  }
  if (!urls.size) urls.add(source.url);
  return [...urls].map(url => ({ ...source, url }));
}

export function mapamedvedovAttributions(item) {
  return attributionsForSource(item, MAPAMEDVEDOV_ATTRIBUTION, "mapamedvedov", ["mapamedvedov.sk", "www.mapamedvedov.sk"]);
}

export function tumedvedAttributions(item) {
  return attributionsForSource(item, TUMEDVED_ATTRIBUTION, "tumedved", ["tumedved.sk", "www.tumedved.sk"]);
}

function sourceAttributions(item) {
  return [...mapamedvedovAttributions(item), ...tumedvedAttributions(item)];
}

export function sourceAttributionText(item) {
  return sourceAttributions(item).map(source =>
    `Zdroj: ${source.label} — ${source.url}${source.license ? ` — licencia ${source.license} (${source.licenseUrl}). ${source.changes}` : ""}`
  ).join("\n");
}

export function sourceAttributionHtml(item) {
  const escape = value => String(value).replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  return sourceAttributions(item).map(source =>
    `<p class="source-attribution">Zdroj: <a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${source.label}</a>${source.license ? ` · <a href="${source.licenseUrl}" target="_blank" rel="license noopener noreferrer">${source.license}</a>. ${source.changes}` : ""}</p>`
  ).join("");
}
