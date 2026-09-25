export function buildReportModerationEmail(row, config) {
  const payload = row.payload || {};
  const adminUrl = absoluteUrl(config.siteOrigin, "/admin");
  const subject = `Na schválenie: ${headerText(payload.location, "Nové hlásenie medveďa")}`;
  const details = [
    `Hlásenie #${row.aggregate_id} čaká na schválenie.`,
    `Lokalita: ${payload.location || "neuvedená"}`,
    `Kedy: ${formatDate(payload.reported_date || payload.created_at)}`,
    `Popis: ${payload.description || "neuvedený"}`,
  ];
  return {
    subject,
    text: `${details.join("\n")}\n\nSchváliť alebo zamietnuť v administrácii (po prihlásení): ${adminUrl}`,
    html: layout({
      title: subject,
      preheader: "Nové používateľské varovanie čaká na kontrolu.",
      body: `<h1>Varovanie na schválenie</h1>${details.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}${button(adminUrl, "Skontrolovať a schváliť")}`,
      footer: "Po prihlásení otvorte čakajúce hlásenia. Varovanie sa zverejní až po schválení.",
    }),
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function absoluteUrl(origin, pathname, token) {
  const url = new URL(pathname, `${origin}/`);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function safeHttpUrl(value, fallback) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function headerText(value, fallback) {
  const clean = String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean || fallback;
}

function formatDate(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "čas neuvedený";
  return new Intl.DateTimeFormat("sk-SK", {
    timeZone: "Europe/Bratislava",
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function layout({ preheader, title, body, footer }) {
  return `<!doctype html>
<html lang="sk">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f3f0e8;color:#18221b;font-family:Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f0e8;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border:1px solid #d9ded8;border-radius:18px;overflow:hidden">
        <tr><td style="padding:22px 28px;background:#173f2a;color:#fff;font-size:20px;font-weight:700">Kde je Medveď</td></tr>
        <tr><td style="padding:30px 28px">${body}</td></tr>
        <tr><td style="padding:20px 28px;background:#f8f7f2;color:#667068;font-size:12px;line-height:1.6">${footer}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(url, label) {
  return `<p style="margin:26px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 20px;border-radius:10px;background:#d66a24;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(label)}</a></p>`;
}

export function buildConfirmationEmail({ subscription, token, config }) {
  const confirmUrl = absoluteUrl(config.siteOrigin, "/api/subscriptions/confirm", token);
  const scope = subscription.notify_type === "area"
    ? `oblasť ${subscription.area_name}`
    : "všetky oblasti Slovenska";
  const body = `
    <h1 style="margin:0 0 14px;font-size:26px;line-height:1.25">Potvrďte odber upozornení</h1>
    <p style="font-size:16px;line-height:1.65;margin:0">Po potvrdení vám budeme posielať súhrny nových varovaní a správ o medveďoch pre <strong>${escapeHtml(scope)}</strong>.</p>
    ${button(confirmUrl, "Potvrdiť odber")}
    <p style="font-size:13px;line-height:1.6;color:#667068">Ak ste o odber nežiadali, tento e-mail môžete ignorovať. Odkaz platí 24 hodín.</p>`;
  return {
    subject: "Potvrďte odber upozornení – Kde je Medveď",
    text: `Potvrďte odber upozornení pre ${scope}:\n\n${confirmUrl}\n\nAk ste o odber nežiadali, e-mail ignorujte. Odkaz platí 24 hodín.`,
    html: layout({
      preheader: "Potvrďte svoju e-mailovú adresu.",
      title: "Potvrdenie odberu",
      body,
      footer: "Tento e-mail ste dostali po žiadosti o odber na kdejemedved.sk.",
    }),
  };
}

export function buildFeedbackEmail({ kind, choice, message, email, receivedAt }) {
  const isPoll = kind === "newsletter_poll";
  const title = isPoll ? "Nový hlas v ankete" : "Nová spätná väzba";
  const subject = isPoll
    ? `Anketa o upozorneniach: ${headerText(choice, "Nový hlas")} – Kde je Medveď`
    : "Spätná väzba z webu – Kde je Medveď";
  const content = isPoll
    ? `<p style="margin:0;font-size:18px;line-height:1.65">Odpoveď: <strong>${escapeHtml(choice)}</strong></p>`
    : `<p style="margin:0;font-size:16px;line-height:1.7;white-space:pre-wrap">${escapeHtml(message)}</p>`;
  const contact = email
    ? `<p style="margin:22px 0 0;color:#667068;font-size:13px">Kontakt na odosielateľa: <strong>${escapeHtml(email)}</strong></p>`
    : "";
  const time = formatDate(receivedAt);

  return {
    subject,
    text: isPoll
      ? `NOVÝ HLAS V ANKETE\n\nOdpoveď: ${choice}\nČas: ${time}`
      : `NOVÁ SPÄTNÁ VÄZBA\n\n${message}\n\nKontakt: ${email || "neuvedený"}\nČas: ${time}`,
    html: layout({
      preheader: isPoll ? `Odpoveď v ankete: ${choice}` : "Nová správa od návštevníka webu.",
      title,
      body: `<h1 style="margin:0 0 18px;font-size:26px;line-height:1.25">${title}</h1>${content}${contact}`,
      footer: `Odoslané cez domovskú stránku Kde je Medveď · ${escapeHtml(time)}`,
    }),
  };
}

export function buildWarningEmail({ row, subscription, unsubscribeToken, config }) {
  const payload = row.payload || {};
  const location = payload.location || "Lokalita neuvedená";
  const note = payload.note || payload.description || "Bez doplňujúceho popisu.";
  const reportedAt = payload.reported_at || payload.reported_date || payload.created_at;
  const source = payload.source || (row.aggregate_type === "bear_report" ? "Schválené komunitné hlásenie" : "Verejný zdroj");
  const sourceUrl = safeHttpUrl(payload.url, config.siteOrigin);
  const mapUrl = `${config.siteOrigin}/`;
  const unsubscribeUrl = absoluteUrl(config.siteOrigin, "/api/subscriptions/unsubscribe", unsubscribeToken);
  const scope = subscription.notify_type === "area" ? `Oblasť odberu: ${subscription.area_name}.` : "Odber: všetky oblasti.";
  const body = `
    <p style="margin:0 0 8px;color:#a54b17;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Nové hlásenie</p>
    <h1 style="margin:0 0 18px;font-size:28px;line-height:1.2">${escapeHtml(location)}</h1>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:15px;line-height:1.6">
      <tr><td style="padding:5px 12px 5px 0;color:#667068;width:105px">Čas</td><td style="padding:5px 0;font-weight:600">${escapeHtml(formatDate(reportedAt))}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#667068">Zdroj</td><td style="padding:5px 0;font-weight:600">${escapeHtml(source)}</td></tr>
    </table>
    <p style="margin:20px 0;font-size:16px;line-height:1.65">${escapeHtml(note)}</p>
    ${button(mapUrl, "Otvoriť aktuálnu mapu")}
    <p style="font-size:13px;line-height:1.6;color:#667068">Údaj je orientačný a nepotvrdzuje aktuálnu polohu zvieraťa. Detail si overte v <a href="${escapeHtml(sourceUrl)}" style="color:#365f43">pôvodnom zdroji</a>.</p>`;
  return {
    subject: `Nové hlásenie: ${headerText(location, "Lokalita neuvedená")} – Kde je Medveď`,
    messageId: `<warning-${row.id}@${new URL(config.siteOrigin).hostname}>`,
    text: `NOVÉ HLÁSENIE\n\nLokalita: ${location}\nČas: ${formatDate(reportedAt)}\nZdroj: ${source}\n\n${note}\n\nMapa: ${mapUrl}\nZdroj: ${sourceUrl}\n\nÚdaj je orientačný a nepotvrdzuje aktuálnu polohu zvieraťa.\n${scope}\nOdhlásenie: ${unsubscribeUrl}`,
    html: layout({
      preheader: `Nové hlásenie v lokalite ${location}.`,
      title: `Nové hlásenie: ${location}`,
      body,
      footer: `${escapeHtml(scope)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#365f43">Zmeniť alebo zrušiť tento odber</a>.`,
    }),
    unsubscribeUrl,
  };
}

function rowKind(row) {
  if (row.aggregate_type !== "news_log") return "warning";
  return row.payload?.category === "warning" || row.event_type === "news_warning"
    ? "warning"
    : "news";
}

function rowContent(row, config) {
  const payload = row.payload || {};
  const kind = rowKind(row);
  const location = payload.location || payload.place || "Lokalita neuvedená";
  const title = kind === "news"
    ? payload.title || "Nová správa o medveďoch"
    : payload.title || location;
  const note = payload.summary || payload.note || payload.description || payload.snippet || "Bez doplňujúceho popisu.";
  const reportedAt = payload.reported_at || payload.reported_date || payload.published_at || payload.created_at;
  const source = payload.source || (row.aggregate_type === "bear_report" ? "Schválené komunitné hlásenie" : "Verejný zdroj");
  const sourceUrl = safeHttpUrl(payload.url || payload.article_url || payload.link, config.siteOrigin);
  return { kind, location, title, note, reportedAt, source, sourceUrl };
}

function digestItemHtml(item) {
  const location = item.kind === "warning"
    ? `<p style="margin:5px 0 0;color:#667068;font-size:13px">${escapeHtml(item.location)}</p>`
    : "";
  return `
    <div style="padding:17px 0;border-top:1px solid #e6e8e3">
      <h3 style="margin:0;font-size:18px;line-height:1.35">${escapeHtml(item.title)}</h3>
      ${location}
      <p style="margin:8px 0;font-size:15px;line-height:1.55">${escapeHtml(item.note)}</p>
      <p style="margin:0;color:#667068;font-size:12px;line-height:1.5">${escapeHtml(formatDate(item.reportedAt))} · ${escapeHtml(item.source)} · <a href="${escapeHtml(item.sourceUrl)}" style="color:#365f43">Otvoriť zdroj</a></p>
    </div>`;
}

function digestSectionHtml(title, items, emptyText) {
  const content = items.length
    ? items.map(digestItemHtml).join("")
    : `<p style="margin:0;color:#667068;font-size:14px">${escapeHtml(emptyText)}</p>`;
  return `
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px;line-height:1.3">${escapeHtml(title)} <span style="color:#667068;font-size:15px">(${items.length})</span></h2>
      ${content}
    </section>`;
}

function digestSectionText(title, items, emptyText) {
  if (!items.length) return `${title.toUpperCase()} (0)\n${emptyText}`;
  return `${title.toUpperCase()} (${items.length})\n\n${items.map((item) => {
    const place = item.kind === "warning" ? `\nLokalita: ${item.location}` : "";
    return `${item.title}${place}\nČas: ${formatDate(item.reportedAt)}\nZdroj: ${item.source}\n${item.note}\n${item.sourceUrl}`;
  }).join("\n\n")}`;
}

export function buildDigestEmail({ rows, subscription, unsubscribeToken, config }) {
  const items = rows.map((row) => rowContent(row, config));
  const warnings = items.filter((item) => item.kind === "warning");
  const news = items.filter((item) => item.kind === "news");
  const mapUrl = `${config.siteOrigin}/`;
  const unsubscribeUrl = absoluteUrl(config.siteOrigin, "/api/subscriptions/unsubscribe", unsubscribeToken);
  const scope = subscription.notify_type === "area" ? `Oblasť odberu: ${subscription.area_name}.` : "Odber: všetky oblasti.";
  const body = `
    <p style="margin:0 0 8px;color:#a54b17;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Nový súhrn</p>
    <h1 style="margin:0 0 24px;font-size:28px;line-height:1.2">${items.length} nových položiek</h1>
    ${digestSectionHtml("Varovania", warnings, "V tomto súhrne nie sú nové varovania.")}
    ${digestSectionHtml("Správy", news, "V tomto súhrne nie sú nové správy.")}
    ${button(mapUrl, "Otvoriť aktuálnu mapu")}
    <p style="font-size:13px;line-height:1.6;color:#667068">Varovania sú orientačné a nepotvrdzujú aktuálnu polohu zvieraťa. Detaily si overte v pôvodných zdrojoch.</p>`;
  const ids = rows.map((row) => row.id).sort((a, b) => String(a).localeCompare(String(b)));
  return {
    subject: headerText(`Súhrn: ${warnings.length} varovaní, ${news.length} správ – Kde je Medveď`, "Nový súhrn – Kde je Medveď"),
    messageId: `<digest-${ids[0]}-${ids.at(-1)}@${new URL(config.siteOrigin).hostname}>`,
    text: `${digestSectionText("Varovania", warnings, "V tomto súhrne nie sú nové varovania.")}\n\n${digestSectionText("Správy", news, "V tomto súhrne nie sú nové správy.")}\n\nMapa: ${mapUrl}\n\nVarovania sú orientačné a nepotvrdzujú aktuálnu polohu zvieraťa.\n${scope}\nOdhlásenie: ${unsubscribeUrl}`,
    html: layout({
      preheader: `${warnings.length} nových varovaní a ${news.length} nových správ.`,
      title: "Nový súhrn",
      body,
      footer: `${escapeHtml(scope)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#365f43">Zmeniť alebo zrušiť tento odber</a>.`,
    }),
    unsubscribeUrl,
  };
}
