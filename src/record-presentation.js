const OFFICIAL_SOURCE_PATTERNS = [
  /šop\s*sr/i,
  /štátna ochrana prírody/i,
  /pozor\s*medveď/i,
  /pozormedved\.sk/i,
  /zásahov[ýy]\s+tím/i,
];

function containsOfficialSource(value) {
  const text = String(value || "");
  return OFFICIAL_SOURCE_PATTERNS.some((pattern) => pattern.test(text));
}

function sourceText(item) {
  return [
    item?.source,
    item?.articleUrl,
    item?.link,
    item?.googleNewsUrl,
  ].filter(Boolean).join(" ");
}

export function warningRecordKind(item) {
  const isCommunity = item?.sourceType === "report" || item?.sourceKey === "report";
  if (isCommunity) {
    return {
      key: "community",
      label: "Komunitné hlásenie",
      explanation: "Skontrolované moderátorom, nie overené v teréne.",
    };
  }

  return {
    key: "sourced",
    label: "Záznam z verejného zdroja",
    explanation: "Prevzaté z prepojeného verejného zdroja; podrobnosti overte v pôvodnom zázname.",
  };
}

export function newsRecordKind(item) {
  if (containsOfficialSource(sourceText(item))) {
    return {
      key: "official",
      label: "Oficiálne upozornenie",
      explanation: "Zdrojom je ŠOP SR alebo jej verejný informačný kanál.",
    };
  }

  if (item?.category === "warning") {
    return {
      key: "media-warning",
      label: "Verejné varovanie v správe",
      explanation: "Lokalitu a okolnosti overte v pôvodnom článku alebo ozname.",
    };
  }

  return {
    key: "news",
    label: "Súvisiaca správa",
    explanation: "Spravodajský kontext, nie potvrdenie aktuálnej polohy medveďa.",
  };
}

export function recordFreshness(value, now = new Date()) {
  const date = new Date(value || 0);
  const current = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) {
    return { key: "unknown", label: "Vek záznamu neznámy" };
  }

  const ageMs = Math.max(0, current.getTime() - date.getTime());
  const ageDays = ageMs / 86400000;
  if (ageDays < 1) return { key: "today", label: "Menej ako 24 hodín" };
  if (ageDays < 7) return { key: "week", label: "Posledných 7 dní" };
  if (ageDays < 30) return { key: "month", label: "Posledných 30 dní" };
  return { key: "older", label: "Starší záznam" };
}

export function correctionMailto(item, recordType = "záznam") {
  const id = String(item?.id || "neuvedené");
  const location = String(item?.location || item?.place || item?.title || "neuvedená");
  const subject = `Oprava záznamu Kde je Medveď: ${id}`;
  const body = [
    `Typ: ${recordType}`,
    `ID: ${id}`,
    `Lokalita alebo názov: ${location}`,
    "",
    "Čo je podľa vás nepresné?",
    "",
    "Odkaz alebo podklad k oprave:",
  ].join("\n");
  return `mailto:kontakt@kdejemedved.sk?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
