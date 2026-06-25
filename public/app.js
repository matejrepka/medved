// Medveď Sledovač — frontend.
// Načíta dáta z vlastného API (/api/sightings, /api/news), vykreslí mapu
// (Leaflet) a zoznamy hlásení a správ. Podporuje svetlý/tmavý režim.

const SK_CENTER = [48.7, 19.5]; // približný stred Slovenska
const state = {
  sightings: [],
  news: [],
  markers: new Map(), // id -> Leaflet marker
};

const $ = (id) => document.getElementById(id);
const elSightings = $("sightingsList");
const elNews = $("newsList");

// --- Mapa ---
const map = L.map("map", { scrollWheelZoom: true, zoomControl: true }).setView(
  SK_CENTER,
  7
);

const TILES = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
};
let tileLayer = null;

function setTiles(theme) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILES[theme] || TILES.light, {
    maxZoom: 19,
    subdomains: "abcd",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
}

// Čisté značky namiesto emoji. Kruhová = hlásenie, hranatá (iná farba) = správa.
const pinIcon = L.divIcon({
  className: "",
  html: '<div class="pin"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  popupAnchor: [0, -8],
});
const newsPinIcon = L.divIcon({
  className: "",
  html: '<div class="pin pin-news"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  popupAnchor: [0, -8],
});

// --- Téma (svetlá / tmavá) ---
const themeBtn = $("themeBtn");

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

function syncThemeButton(theme) {
  themeBtn.innerHTML = `<i class="ph ph-${
    theme === "dark" ? "sun" : "moon"
  }" aria-hidden="true"></i>`;
  themeBtn.setAttribute(
    "aria-label",
    theme === "dark" ? "Prepnúť svetlý režim" : "Prepnúť tmavý režim"
  );
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("theme", theme);
  } catch (e) {}
  syncThemeButton(theme);
  setTiles(theme);
}

themeBtn.addEventListener("click", () => {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
});

// --- Pomocné funkcie ---
function fmtDate(iso, withTime = false) {
  if (!iso) return "neznámy dátum";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "neznámy dátum";
  const opts = withTime
    ? { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "long", year: "numeric" };
  return d.toLocaleDateString("sk-SK", opts);
}

function relativeDate(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < 0) return "";
  if (diff < day) return "dnes";
  if (diff < 2 * day) return "včera";
  const days = Math.floor(diff / day);
  if (days < 31) return `pred ${days} dňami`;
  const months = Math.floor(days / 30);
  return `pred ${months} ${months === 1 ? "mesiacom" : "mesiacmi"}`;
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function skeletons(n) {
  return Array.from({ length: n }, () => '<div class="skeleton"></div>').join("");
}

function revealStyle(i) {
  return `--i:${Math.min(i, 14)}`;
}

// --- Vykreslenie hlásení ---
function renderSightings(filter = "") {
  const q = filter.trim().toLowerCase();
  const items = q
    ? state.sightings.filter(
        (s) =>
          s.location.toLowerCase().includes(q) ||
          (s.note || "").toLowerCase().includes(q)
      )
    : state.sightings;

  if (items.length === 0) {
    elSightings.innerHTML = `<div class="empty"><i class="ph ph-binoculars"></i>${
      q ? "Žiadne hlásenia nezodpovedajú hľadaniu." : "Zatiaľ žiadne hlásenia."
    }</div>`;
    return;
  }

  elSightings.innerHTML = items
    .map(
      (s, i) => `
      <article class="card sighting reveal" style="${revealStyle(i)}" data-id="${esc(s.id)}">
        <p class="card-title">${esc(s.location)}</p>
        <div class="card-meta">
          <span class="meta-date">${esc(fmtDate(s.reportedAt, true))}</span>
          ${
            relativeDate(s.reportedAt)
              ? `<span>${esc(relativeDate(s.reportedAt))}</span>`
              : ""
          }
        </div>
        ${s.note ? `<p class="card-note">${esc(s.note)}</p>` : ""}
        <a class="card-link" href="${esc(s.url)}" target="_blank" rel="noopener">
          Detail na tumedved.sk <i class="ph ph-arrow-up-right"></i>
        </a>
      </article>`
    )
    .join("");

  elSightings.querySelectorAll(".card.sighting").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const s = state.sightings.find((x) => x.id === card.dataset.id);
      const marker = state.markers.get(card.dataset.id);
      if (s && s.hasCoords && marker) {
        map.flyTo([s.lat, s.lng], 12, { duration: 0.6 });
        marker.openPopup();
        document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });
}

// --- Značky na mape ---
function renderMarkers() {
  state.markers.forEach((m) => map.removeLayer(m));
  state.markers.clear();

  const bounds = [];
  for (const s of state.sightings) {
    if (!s.hasCoords) continue;
    const marker = L.marker([s.lat, s.lng], { icon: pinIcon }).addTo(map);
    marker.bindPopup(`
      <p class="popup-loc">${esc(s.location)}</p>
      <p class="popup-meta">${esc(fmtDate(s.reportedAt, true))}</p>
      ${s.note ? `<p class="popup-note">${esc(s.note)}</p>` : ""}
      <a class="popup-link" href="${esc(s.url)}" target="_blank" rel="noopener">Detail na tumedved.sk →</a>
    `);
    state.markers.set(s.id, marker);
    bounds.push([s.lat, s.lng]);
  }

  // Geokódované správy — hranatá značka inej farby.
  let newsOnMap = 0;
  for (const n of state.news) {
    if (!n.hasCoords) continue;
    const marker = L.marker([n.lat, n.lng], { icon: newsPinIcon }).addTo(map);
    marker.bindPopup(`
      <p class="popup-loc">${esc(n.place || "")}</p>
      <p class="popup-meta">${esc(n.source || "")}${n.source ? " · " : ""}${esc(fmtDate(n.date))}</p>
      <p class="popup-note">${esc(n.title)}</p>
      <a class="popup-link" href="${esc(n.link)}" target="_blank" rel="noopener">Čítať článok →</a>
    `);
    state.markers.set(n.id, marker);
    bounds.push([n.lat, n.lng]);
    newsOnMap++;
  }

  const mapMeta = $("mapMeta");
  if (mapMeta) {
    const sightOnMap = bounds.length - newsOnMap;
    mapMeta.textContent = `${sightOnMap} hlásení · ${newsOnMap} správ na mape`;
  }

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9 });
  }
}

// --- Vykreslenie správ ---
function renderNews() {
  if (state.news.length === 0) {
    elNews.innerHTML = `<div class="empty"><i class="ph ph-newspaper"></i>Momentálne žiadne správy.</div>`;
    return;
  }
  elNews.innerHTML = state.news
    .map(
      (n, i) => `
      <article class="card news reveal${n.hasCoords ? " has-place" : ""}" style="${revealStyle(i)}" data-id="${esc(n.id)}">
        <p class="card-title"><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></p>
        <div class="card-meta">
          ${n.source ? `<span class="meta-source">${esc(n.source)}</span>` : ""}
          <span class="meta-date">${esc(fmtDate(n.date))}</span>
          ${relativeDate(n.date) ? `<span>${esc(relativeDate(n.date))}</span>` : ""}
          ${
            n.hasCoords
              ? `<span class="meta-place"><i class="ph ph-map-pin" aria-hidden="true"></i> ${esc(n.place)}</span>`
              : ""
          }
        </div>
        ${
          n.snippet
            ? `<p class="card-note">${esc(n.snippet.slice(0, 175))}${
                n.snippet.length > 175 ? "…" : ""
              }</p>`
            : ""
        }
      </article>`
    )
    .join("");

  // Klik na správu s lokalitou vycentruje mapu na jej značku.
  elNews.querySelectorAll(".card.news.has-place").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const n = state.news.find((x) => x.id === card.dataset.id);
      const marker = state.markers.get(card.dataset.id);
      if (n && n.hasCoords && marker) {
        map.flyTo([n.lat, n.lng], 11, { duration: 0.6 });
        marker.openPopup();
        document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });
}

// --- Štatistiky ---
function renderStats() {
  $("statSightings").textContent = state.sightings.length || "-";
  $("statNews").textContent = state.news.length || "-";
  const latest = state.sightings[0];
  $("statLatest").textContent = latest
    ? relativeDate(latest.reportedAt) || fmtDate(latest.reportedAt)
    : "-";
}

function setUpdated(iso) {
  $("updated").textContent = iso ? "Aktualizované " + relativeDate(iso) : "";
}

// --- Načítanie dát ---
async function loadData() {
  const [sRes, nRes] = await Promise.allSettled([
    fetch("/api/sightings").then((r) => r.json()),
    fetch("/api/news").then((r) => r.json()),
  ]);

  if (sRes.status === "fulfilled" && sRes.value.items) {
    state.sightings = sRes.value.items;
    setUpdated(sRes.value.updatedAt);
    renderMarkers();
    renderSightings($("sightingSearch").value);
  } else {
    elSightings.innerHTML = `<div class="error-box">Nepodarilo sa načítať hlásenia. Skúste to znova.</div>`;
  }

  if (nRes.status === "fulfilled" && nRes.value.items) {
    state.news = nRes.value.items;
    renderNews();
    renderMarkers(); // správy môžu mať súradnice -> značky na mape
  } else {
    elNews.innerHTML = `<div class="error-box">Nepodarilo sa načítať správy. Skúste to znova.</div>`;
  }

  renderStats();
}

// --- Obnova ---
const refreshBtn = $("refreshBtn");
refreshBtn.addEventListener("click", async () => {
  refreshBtn.classList.add("loading");
  try {
    await fetch("/api/refresh", { method: "POST" });
    await loadData();
  } catch (_) {
    /* loadData ošetrí chyby */
  } finally {
    refreshBtn.classList.remove("loading");
  }
});

$("sightingSearch").addEventListener("input", (e) => renderSightings(e.target.value));

// --- Štart ---
syncThemeButton(currentTheme());
setTiles(currentTheme());
elSightings.innerHTML = skeletons(5);
elNews.innerHTML = skeletons(5);
loadData();
// Obnova zobrazenia každých 15 minút (dáta drží cache na serveri).
setInterval(loadData, 15 * 60 * 1000);
