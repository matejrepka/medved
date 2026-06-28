// Medvede na Slovensku — frontend.
// Načíta dáta z vlastného API (/api/sightings, /api/news), vykreslí mapu
// (Leaflet) a zoznamy hlásení a správ. Podporuje svetlý/tmavý režim.

const SK_CENTER = [48.7, 19.5]; // približný stred Slovenska
const API_VERSION = "news-map-v5";
const MAP_LAYER_IDS = ["standard", "tourist", "satellite"];
const state = {
  sightings: [],
  news: [],
  sightingsUpdatedAt: null,
  newsUpdatedAt: null,
  updatedAt: null,
  markers: new Map(), // id -> Leaflet marker
  filters: {
    startDate: "",
    endDate: "",
    query: "",
  },
  mapLayer: readStoredMapLayer(),
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
  standard: {
    urls: {
      light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    },
    options: {
      maxZoom: 19,
      subdomains: "abcd",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  tourist: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 17,
      attribution:
        'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, style &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
    },
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      maxZoom: 19,
      attribution:
        "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
};
let tileLayer = null;

function setTiles(layerId) {
  const id = TILES[layerId] ? layerId : "standard";
  const layer = TILES[id];
  const url = layer.urls ? layer.urls[currentTheme()] || layer.urls.light : layer.url;

  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(url, layer.options).addTo(map);
  state.mapLayer = id;
  try {
    localStorage.setItem("mapLayer", id);
  } catch (e) {}
  syncMapLayerControls();
}

// Čisté značky namiesto emoji. Kruhová = hlásenie (tumedved), hranatá inej farby
// = medvedie varovanie zo správ — vizuálne odlíšené od hlásení.
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
  setTiles(state.mapLayer);
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

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
}

function isSameLocalDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return isSameLocalDate(d, new Date());
}

function latestIso(...values) {
  return values.reduce((latest, iso) => {
    const time = itemTime(iso);
    if (time === null) return latest;
    if (!latest || time > latest.time) return { iso, time };
    return latest;
  }, null)?.iso || null;
}

function updatedText(iso) {
  if (!iso) return "";
  const time = fmtTime(iso);
  if (!time) return "";
  return isToday(iso) ? `dnes ${time}` : fmtDate(iso, true);
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

function normalizeNewsLink(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.hostname !== "news.google.com") return url;
    const match = parsed.pathname.match(/^\/rss\/articles\/([^/?#]+)/);
    if (!match) return url;
    return `https://news.google.com/articles/${match[1]}?hl=sk&gl=SK&ceid=SK:sk`;
  } catch (e) {
    return url;
  }
}

function newsUrl(n) {
  return n.articleUrl || n.googleNewsUrl || normalizeNewsLink(n.link) || "#";
}

function newsMapPoint(n) {
  if (n?.category !== "warning") return null;
  const lat = mapCoord(n.lat);
  const lng = mapCoord(n.lng);
  return lat === null || lng === null ? null : { lat, lng };
}

function newsPlaceLabel(n) {
  if (n?.place) return n.place;
  const point = newsMapPoint(n);
  return point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : "";
}

function focusMapMarker(id, lat, lng) {
  const marker = state.markers.get(id);
  if (!marker) return;
  map.flyTo([lat, lng], 12, { duration: 0.6 });
  marker.openPopup();
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
}

function readStoredMapLayer() {
  try {
    const stored = localStorage.getItem("mapLayer");
    return MAP_LAYER_IDS.includes(stored) ? stored : "standard";
  } catch (e) {
    return "standard";
  }
}

function skeletons(n) {
  return Array.from({ length: n }, () => '<div class="skeleton"></div>').join("");
}

function revealStyle(i) {
  return `--i:${Math.min(i, 14)}`;
}

// --- Filtre mapy ---
const filterStart = $("filterStart");
const filterEnd = $("filterEnd");
const clearFiltersBtn = $("clearFiltersBtn");
const contentSearch = $("contentSearch");
const layerInputs = Array.from(document.querySelectorAll('input[name="mapLayer"]'));

function dateInputToTime(value, endOfDay = false) {
  if (!value) return null;
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [year, month, day] = parts;
  const date = new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  );
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function itemTime(iso) {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? null : time;
}

function hasDateFilter() {
  return Boolean(state.filters.startDate || state.filters.endDate);
}

function hasSearchFilter() {
  return Boolean(state.filters.query.trim());
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sightingDedupeTime(iso) {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  return new Date(Math.floor(time / 60000) * 60000).toISOString();
}

function sightingCoordKey(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(5) : "";
}

function mapCoord(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sightingDedupeKey(s) {
  return [
    normalizeSearchText(s.location).replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
    normalizeSearchText(s.note).replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
    sightingDedupeTime(s.reportedAt),
    sightingCoordKey(s.lat),
    sightingCoordKey(s.lng),
  ].join("|");
}

function dedupeSightings(items) {
  const seenIds = new Set();
  const seenContent = new Set();
  const unique = [];

  for (const item of items || []) {
    const id = item?.id ? String(item.id) : "";
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);

    const contentKey = sightingDedupeKey(item || {});
    if (contentKey && seenContent.has(contentKey)) continue;
    if (contentKey) seenContent.add(contentKey);

    unique.push(item);
  }

  return unique;
}

function matchesSearchQuery(fields) {
  const q = normalizeSearchText(state.filters.query.trim());
  if (!q) return true;
  return fields.some((field) => normalizeSearchText(field).includes(q));
}

function matchesDateRange(iso) {
  if (!hasDateFilter()) return true;
  const time = itemTime(iso);
  if (time === null) return false;

  const start = dateInputToTime(state.filters.startDate);
  const end = dateInputToTime(state.filters.endDate, true);
  if (start !== null && time < start) return false;
  if (end !== null && time > end) return false;
  return true;
}

function filteredSightings() {
  return state.sightings.filter(
    (s) =>
      matchesDateRange(s.reportedAt) &&
      matchesSearchQuery([s.location, s.note, s.source])
  );
}

function filteredNews() {
  return state.news.filter(
    (n) =>
      matchesDateRange(n.date) &&
      matchesSearchQuery([n.title, n.snippet, n.source, n.place])
  );
}

function syncDateFilterLimits() {
  const datedItems = [
    ...state.sightings.map((s) => s.reportedAt),
    ...state.news.map((n) => n.date),
  ]
    .map(itemTime)
    .filter((time) => time !== null);

  if (datedItems.length === 0) return;

  const toInputDate = (time) => {
    const date = new Date(time);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  };

  const min = toInputDate(Math.min(...datedItems));
  const max = toInputDate(Math.max(...datedItems));

  filterStart.min = min;
  filterStart.max = state.filters.endDate || max;
  filterEnd.min = state.filters.startDate || min;
  filterEnd.max = max;
}

function updateDateFilters(changedInput) {
  if (filterStart.value && filterEnd.value && filterStart.value > filterEnd.value) {
    if (changedInput === "start") {
      filterEnd.value = filterStart.value;
    } else {
      filterStart.value = filterEnd.value;
    }
  }

  state.filters.startDate = filterStart.value;
  state.filters.endDate = filterEnd.value;
  syncDateFilterLimits();
  renderFilteredViews();
}

function renderFilteredViews() {
  renderMarkers();
  renderSightings();
  renderNews();
}

function syncMapLayerControls() {
  for (const input of layerInputs) {
    input.checked = input.value === state.mapLayer;
  }
}

filterStart.addEventListener("change", () => updateDateFilters("start"));
filterEnd.addEventListener("change", () => updateDateFilters("end"));
clearFiltersBtn.addEventListener("click", () => {
  filterStart.value = "";
  filterEnd.value = "";
  updateDateFilters();
});

for (const input of layerInputs) {
  input.addEventListener("change", () => {
    if (input.checked) setTiles(input.value);
  });
}

// --- Vykreslenie hlásení ---
function renderSightings() {
  const items = filteredSightings();
  if (items.length === 0) {
    elSightings.innerHTML = `<div class="empty"><i class="ph ph-binoculars"></i>${
      hasSearchFilter() || hasDateFilter()
        ? "Žiadne hlásenia nezodpovedajú filtrom."
        : "Zatiaľ žiadne hlásenia."
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
      if (s && s.hasCoords) focusMapMarker(s.id, s.lat, s.lng);
    });
  });
}

// --- Značky na mape ---
function renderMarkers() {
  state.markers.forEach((m) => map.removeLayer(m));
  state.markers.clear();

  const bounds = [];
  for (const s of filteredSightings()) {
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

  // Medvedie varovania zo správ — admin im priradil lokalitu. Na mape majú
  // vlastnú (hranatú, inak sfarbenú) značku, odlíšenú od hlásení z tumedved.
  // Bežné články (category !== "warning") sa na mape nezobrazujú.
  let warningsOnMap = 0;
  for (const n of filteredNews()) {
    const point = newsMapPoint(n);
    if (!point) continue;
    const href = newsUrl(n);
    const marker = L.marker([point.lat, point.lng], { icon: newsPinIcon }).addTo(map);
    marker.bindPopup(`
      <p class="popup-loc">${esc(newsPlaceLabel(n) || "Varovanie zo správ")}</p>
      <p class="popup-meta">${esc(n.source || "")}${n.source ? " · " : ""}${esc(fmtDate(n.date))}</p>
      <p class="popup-note">${esc(n.title)}</p>
      <a class="popup-link" href="${esc(href)}" target="_blank" rel="noopener">Link na článok →</a>
    `);
    state.markers.set(n.id, marker);
    bounds.push([point.lat, point.lng]);
    warningsOnMap++;
  }

  const mapMeta = $("mapMeta");
  if (mapMeta) {
    const sightOnMap = bounds.length - warningsOnMap;
    mapMeta.textContent = `${sightOnMap} hlásení · ${warningsOnMap} zo správ${
      hasDateFilter() || hasSearchFilter() ? " podľa filtrov" : " na mape"
    }`;
  }

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9 });
  } else if (hasDateFilter() || hasSearchFilter()) {
    map.setView(SK_CENTER, 7);
  }
}

// --- Vykreslenie správ ---
// Varovania zo správ ostávajú v zozname s lokalitou a preklikom na mapu.
// Bežné články sa na mapu neviažu.
function renderNews() {
  const items = filteredNews();
  if (items.length === 0) {
    elNews.innerHTML = `<div class="empty"><i class="ph ph-newspaper"></i>${
      hasDateFilter() || hasSearchFilter()
        ? "Žiadne správy nezodpovedajú filtrom."
        : "Momentálne žiadne správy."
    }</div>`;
    return;
  }
  elNews.innerHTML = items
    .map(
      (n, i) => {
        const point = newsMapPoint(n);
        const isWarning = n.category === "warning";
        const place = isWarning ? newsPlaceLabel(n) : "";
        const href = newsUrl(n);
        const articleLink =
          href && href !== "#"
            ? `<a class="card-link" href="${esc(href)}" target="_blank" rel="noopener">
                Link na článok <i class="ph ph-arrow-up-right" aria-hidden="true"></i>
              </a>`
            : "";
        return `
      <article class="card news reveal${point ? " has-place" : ""}${
          isWarning ? " is-warning" : ""
        }" style="${revealStyle(i)}" data-id="${esc(n.id)}">
        <p class="card-title">${esc(n.title)}</p>
        <div class="card-meta">
          ${n.source ? `<span class="meta-source">${esc(n.source)}</span>` : ""}
          ${
            place
              ? `<span class="meta-place"><i class="ph ph-map-pin" aria-hidden="true"></i>${esc(place)}</span>`
              : ""
          }
          <span class="meta-date">${esc(fmtDate(n.date))}</span>
          ${relativeDate(n.date) ? `<span>${esc(relativeDate(n.date))}</span>` : ""}
        </div>
        ${
          n.snippet
            ? `<p class="card-note">${esc(n.snippet.slice(0, 175))}${
                n.snippet.length > 175 ? "…" : ""
              }</p>`
            : ""
        }
        ${articleLink}
      </article>`
      }
    )
    .join("");

  elNews.querySelectorAll(".card.news.has-place").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const n = state.news.find((x) => x.id === card.dataset.id);
      const point = newsMapPoint(n);
      if (n && point) focusMapMarker(n.id, point.lat, point.lng);
    });
  });
}

// --- Štatistiky ---
function renderStats() {
  $("statSightings").textContent = state.sightings.filter((s) =>
    isToday(s.reportedAt)
  ).length;
  $("statNews").textContent = state.news.filter(
    (n) => n.category !== "warning" && isToday(n.date)
  ).length;
  $("statUpdated").textContent = fmtTime(state.updatedAt) || "-";
}

function setUpdated(iso) {
  $("updated").textContent = iso ? "Aktualizované " + updatedText(iso) : "";
}

// --- Načítanie dát ---
async function loadData() {
  // News načítavame bez cache, aby sa moderácia kategórie/lokality hneď
  // prejavila aj na mape.
  const [sRes, nRes] = await Promise.allSettled([
    fetch("/api/sightings").then((r) => r.json()),
    fetch(`/api/news?v=${API_VERSION}`, { cache: "no-store" }).then((r) => r.json()),
  ]);

  if (sRes.status === "fulfilled" && sRes.value.items) {
    state.sightings = dedupeSightings(sRes.value.items);
    state.sightingsUpdatedAt = sRes.value.updatedAt;
    renderMarkers();
    renderSightings();
  } else {
    elSightings.innerHTML = `<div class="error-box">Nepodarilo sa načítať hlásenia. Skúste to znova.</div>`;
  }

  if (nRes.status === "fulfilled" && nRes.value.items) {
    state.news = nRes.value.items;
    state.newsUpdatedAt = nRes.value.updatedAt;
    renderNews();
    renderMarkers(); // správy môžu mať súradnice -> značky na mape
  } else {
    elNews.innerHTML = `<div class="error-box">Nepodarilo sa načítať správy. Skúste to znova.</div>`;
  }

  state.updatedAt = latestIso(state.sightingsUpdatedAt, state.newsUpdatedAt);
  setUpdated(state.updatedAt);
  syncDateFilterLimits();
  renderStats();
}

contentSearch.addEventListener("input", (e) => {
  state.filters.query = e.target.value;
  renderFilteredViews();
});

// --- Upozorni ma (email subscription) ---
(function () {
  const form = document.getElementById("notifyForm");
  if (!form) return;

  const typeRadios = form.querySelectorAll('input[name="notifyType"]');
  const areaWrap = document.getElementById("notifyAreaWrap");
  const areaInput = document.getElementById("notifyArea");
  const msg = document.getElementById("notifyMessage");
  const btn = document.getElementById("notifyBtn");

  typeRadios.forEach((r) =>
    r.addEventListener("change", () => {
      const isArea = form.notifyType.value === "area";
      areaWrap.hidden = !isArea;
      if (isArea) areaInput.focus();
    })
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.className = "form-message";
    msg.textContent = "";

    const email = form.email.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msg.textContent = "Zadajte platnú emailovú adresu.";
      msg.className = "form-message error";
      form.email.focus();
      return;
    }

    const notifyType = form.notifyType.value;
    const areaName = notifyType === "area" ? areaInput.value.trim() : null;

    if (notifyType === "area" && !areaName) {
      msg.textContent = "Zadajte názov oblasti.";
      msg.className = "form-message error";
      areaInput.focus();
      return;
    }

    btn.disabled = true;
    btn.querySelector("span").textContent = "Odosielam...";

    try {
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, notifyType, areaName }),
      });
      const data = await res.json();

      if (res.ok && data.ok) {
        msg.textContent = "Odber bol úspešne zaregistrovaný.";
        msg.className = "form-message success";
        form.reset();
        areaWrap.hidden = true;
      } else {
        msg.textContent = data.error || "Nepodarilo sa zaregistrovať odber.";
        msg.className = "form-message error";
      }
    } catch (err) {
      msg.textContent = "Chyba siete: " + err.message;
      msg.className = "form-message error";
    } finally {
      btn.disabled = false;
      btn.querySelector("span").textContent = "Prihlásiť sa na odber";
    }
  });
})();

// --- Štart ---
syncThemeButton(currentTheme());
setTiles(state.mapLayer);
elSightings.innerHTML = skeletons(5);
elNews.innerHTML = skeletons(5);
loadData();
// Automatická obnova zobrazenia každých 15 minút (dáta sa scrapujú cez externý cron job).
setInterval(loadData, 15 * 60 * 1000);

