const MAX_TEXT = 3900;

export function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function text(value, max = 700) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return escapeTelegramHtml(clean);
  return `${escapeTelegramHtml(clean.slice(0, max - 1))}…`;
}

function date(value) {
  const parsed = new Date(value || 0);
  if (Number.isNaN(parsed.getTime())) return "neuvedené";
  return new Intl.DateTimeFormat("sk-SK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Bratislava",
  }).format(parsed);
}

function link(label, value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.href.length > 700) return null;
    return `<a href="${escapeTelegramHtml(url.href)}">${escapeTelegramHtml(label)}</a>`;
  } catch {
    return null;
  }
}

function completeLines(lines) {
  const kept = [];
  let length = 0;
  for (const line of lines) {
    const extra = (kept.length ? 1 : 0) + line.length;
    if (length + extra > MAX_TEXT) {
      if (length + 2 <= MAX_TEXT) kept.push("…");
      break;
    }
    kept.push(line);
    length += extra;
  }
  return kept.join("\n");
}

function adminLink(config) {
  return link("Otvoriť administráciu", `${config.siteOrigin}/admin`);
}

function moderationKeyboard(outboxId) {
  return {
    inline_keyboard: [[
      { text: "✅ Schváliť", callback_data: `tm:a:${outboxId}` },
      { text: "❌ Zamietnuť", callback_data: `tm:r:${outboxId}` },
    ]],
  };
}

export function confirmationKeyboard(outboxId) {
  return {
    inline_keyboard: [[
      { text: "⚠️ Potvrdiť zamietnutie", callback_data: `tm:c:${outboxId}` },
      { text: "Späť", callback_data: `tm:x:${outboxId}` },
    ]],
  };
}

export function normalKeyboard(outboxId) {
  return moderationKeyboard(outboxId);
}

function sourceIdentities(payload) {
  const identities = [];
  const links = Array.isArray(payload?.payload?.sourceLinks) ? payload.payload.sourceLinks : [];
  for (const source of links) {
    const label = source?.label || source?.key;
    const rendered = link(label, source?.url);
    if (rendered) identities.push(rendered);
    else if (label) identities.push(text(label, 100));
  }
  if (!identities.length && payload?.source) identities.push(text(payload.source, 100));
  return [...new Set(identities)].join(", ") || "neuvedený";
}

export function buildTelegramCard(outbox, config) {
  const payload = outbox.payload || {};
  const lines = [];
  let replyMarkup;

  if (outbox.event_type === "pending_public_report") {
    lines.push("📥 <b>Nové hlásenie čaká na moderáciu</b>");
    lines.push("<b>Zdroj:</b> hlásenie používateľa");
    lines.push(`<b>Kde:</b> ${text(payload.location)}`);
    lines.push(`<b>Kedy:</b> ${date(payload.reported_date || payload.created_at)}`);
    if (payload.description) lines.push(`<b>Čo:</b> ${text(payload.description)}`);
    lines.push(`<b>Prijaté:</b> ${date(payload.created_at)}`);
    replyMarkup = moderationKeyboard(outbox.id);
  } else if (outbox.event_type === "imported_news") {
    const warning = payload.category === "warning";
    lines.push(`${warning ? "⚠️" : "📰"} <b>Nová správa čaká na moderáciu</b>`);
    lines.push(`<b>${warning ? "AI štítok:" : "Typ:"}</b> ${warning ? "medvedie varovanie" : "správa / článok"}`);
    lines.push(`<b>Titulok:</b> ${text(payload.title)}`);
    lines.push(`<b>Zdroj:</b> ${text(payload.source || "neuvedený", 160)}`);
    lines.push(`<b>Publikované:</b> ${date(payload.published_at)}`);
    lines.push(`<b>Importované:</b> ${date(payload.created_at || payload.scraped_at)}`);
    if (payload.place) lines.push(`<b>Lokalita:</b> ${text(payload.place)}`);
    if (payload.snippet) lines.push(`<b>Obsah:</b> ${text(payload.snippet)}`);
    const article = link("Otvoriť článok", payload.article_url || payload.link || payload.google_news_url);
    if (article) lines.push(article);
    replyMarkup = moderationKeyboard(outbox.id);
  } else if (outbox.event_type === "scraper_warning") {
    lines.push("🐻 <b>Nové varovanie zo scraperov</b>");
    lines.push(`<b>Kde:</b> ${text(payload.location || "neuvedené")}`);
    lines.push(`<b>Kedy:</b> ${date(payload.reported_at)}`);
    if (payload.note) lines.push(`<b>Čo:</b> ${text(payload.note)}`);
    lines.push(`<b>Zdroje:</b> ${sourceIdentities(payload)}`);
    lines.push(`<b>Importované:</b> ${date(payload.scraped_at)}`);
    const source = link("Zdrojový záznam", payload.url);
    if (source) lines.push(source);
  } else if (outbox.event_type === "admin_warning") {
    const isNews = outbox.aggregate_type === "news_log";
    lines.push("🛠️ <b>Admin pridal nové varovanie</b>");
    if (isNews) {
      lines.push(`<b>Typ:</b> varovanie zo správ`);
      lines.push(`<b>Čo:</b> ${text(payload.title)}`);
      lines.push(`<b>Kde:</b> ${text(payload.place || "neuvedené")}`);
      lines.push(`<b>Kedy:</b> ${date(payload.published_at || payload.created_at)}`);
      lines.push(`<b>Zdroj:</b> ${text(payload.source || "administrácia", 160)}`);
      const article = link("Zdrojový záznam", payload.article_url || payload.link);
      if (article) lines.push(article);
    } else {
      const isTumedved = outbox.aggregate_type === "tumedved_log";
      lines.push(`<b>Typ:</b> ${isTumedved ? "tumedved" : "všeobecné varovanie"}`);
      lines.push(`<b>Kde:</b> ${text(payload.location || "neuvedené")}`);
      lines.push(`<b>Kedy:</b> ${date(payload.reported_at || payload.reported_date || payload.created_at)}`);
      const description = payload.note || payload.description;
      if (description) lines.push(`<b>Čo:</b> ${text(description)}`);
      lines.push(`<b>Zdroj:</b> ${isTumedved ? "tumedved.sk (admin)" : "administrácia"}`);
      const source = link("Zdrojový záznam", payload.url);
      if (source) lines.push(source);
    }
  } else {
    throw new Error(`Unsupported Telegram event type: ${outbox.event_type}`);
  }

  const admin = adminLink(config);
  if (admin) lines.push(admin);
  return {
    text: completeLines(lines),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
}
