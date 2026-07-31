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
    <p style="font-size:16px;line-height:1.65;margin:0">Po potvrdení vám budeme posielať nové hlásenia o výskyte medveďa pre <strong>${escapeHtml(scope)}</strong>.</p>
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
