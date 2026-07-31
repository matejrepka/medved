// Kde je Medveď — frontend.
// Načíta dáta z vlastného API (/api/warnings, /api/news), vykreslí mapu
// (Leaflet) a zoznamy varovaní a správ. Podporuje svetlý/tmavý režim.

const SK_CENTER = [48.7, 19.5]; // približný stred Slovenska
const API_VERSION = "news-map-v9";
const MAP_LAYER_IDS = ["standard", "classic", "tourist", "satellite"];
const state = {
  sightings: [],
  news: [],
  sightingsUpdatedAt: null,
  newsUpdatedAt: null,
  updatedAt: null,
  dataLoading: false,
  dataFailures: [],
  tileError: false,
  markers: new Map(), // id -> Leaflet marker
  loaded: {
    sightings: false,
    news: false,
  },
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
const phoneListMedia = window.matchMedia("(max-width: 760px)");
const tabletListMedia = window.matchMedia("(max-width: 1023px)");
const listVisible = {
  sightings: listPageSize(),
  news: listPageSize(),
};

function listPageSize() {
  if (phoneListMedia.matches) return 3;
  if (tabletListMedia.matches) return 4;
  return 6;
}

function resetListLimits() {
  const pageSize = listPageSize();
  listVisible.sightings = pageSize;
  listVisible.news = pageSize;
}

function visibleListItems(items, listName) {
  return items.slice(0, listVisible[listName]);
}

function loadMoreButtonHtml(listName, shownCount, totalCount) {
  if (shownCount >= totalCount) return "";
  const listId = listName === "sightings" ? "sightingsList" : "newsList";
  const listLabel = listName === "sightings" ? "medvedie varovania" : "správy o medveďoch";
  return `
    <button
      class="list-load-more"
      type="button"
      data-load-more="${listName}"
      aria-controls="${listId}"
      aria-label="Načítať ďalšie ${listLabel}"
    >
      <span>Načítať ďalšie</span>
      <span class="list-load-more-count">${totalCount - shownCount}</span>
      <i class="ph ph-caret-down" aria-hidden="true"></i>
    </button>`;
}

// --- Mapa ---
const map = L.map("map", { scrollWheelZoom: false, zoomControl: false }).setView(
  SK_CENTER,
  7
);
L.control.zoom({ position: "topright" }).addTo(map);
let mapFitFrame = null;

function mapMarkerPoints() {
  const points = [];
  state.markers.forEach((marker) => {
    const point = marker.getLatLng?.();
    if (point) points.push(point);
  });
  return points;
}

function fitMapToPoints(points, { animate = false } = {}) {
  if (!points.length) return;
  if (mapFitFrame !== null) cancelAnimationFrame(mapFitFrame);

  const fit = () => {
    mapFitFrame = null;
    const isMobile = phoneListMedia.matches;
    map.options.zoomSnap = isMobile ? 0.25 : 1;
    map.invalidateSize({ pan: false });
    const options = {
      padding: isMobile ? [24, 24] : [40, 40],
      maxZoom: 9,
      ...(animate ? { duration: 0.6 } : {}),
    };

    if (animate) {
      map.flyToBounds(points, options);
    } else {
      map.fitBounds(points, options);
    }
  };

  if (animate) {
    fit();
  } else {
    // Leaflet dostane finálne rozmery responzívneho mapového kontajnera.
    mapFitFrame = requestAnimationFrame(fit);
  }
}

function refitMapOnVisibleMarkers() {
  const points = mapMarkerPoints();
  if (points.length) fitMapToPoints(points);
}

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
  classic: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      subdomains: "abc",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
  state.tileError = false;
  tileLayer.once("tileerror", () => {
    state.tileError = true;
    syncLoadStatus();
  });
  state.mapLayer = id;
  try {
    localStorage.setItem("mapLayer", id);
  } catch (e) {}
  syncMapLayerControls();
  syncLoadStatus();
}

// Čisté značky namiesto emoji. Kruhová = medvedie varovanie (moderované hlásenie),
// hranatá inej farby = medvedie varovanie zo správ — vizuálne odlíšené.
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

// --- Poloha používateľa ---
// Súradnice sa používajú iba lokálne v prehliadači na vycentrovanie mapy.
let userLocationLayer = null;
let locationMessageTimer = null;

function locationErrorMessage(error) {
  if (error?.code === 1) {
    return "Prístup k polohe bol zamietnutý. Povoľte ho v nastaveniach prehliadača.";
  }
  if (error?.code === 2) {
    return "Vašu polohu sa nepodarilo určiť. Skontrolujte, či máte zapnuté GPS.";
  }
  if (error?.code === 3) {
    return "Zisťovanie polohy trvalo príliš dlho. Skúste to znova.";
  }
  return "Vašu polohu sa nepodarilo zistiť. Skúste to znova.";
}

function addLocationControl() {
  const LocationControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const container = L.DomUtil.create("div", "map-location-control");
      const button = L.DomUtil.create("button", "map-location-button", container);
      const message = L.DomUtil.create("span", "map-location-message", container);

      button.type = "button";
      button.title = "Zobraziť moju polohu";
      button.setAttribute("aria-label", "Zobraziť moju polohu");
      button.setAttribute("aria-describedby", "mapLocationMessage");
      button.innerHTML = '<i class="ph ph-crosshair" aria-hidden="true"></i>';
      message.id = "mapLocationMessage";
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      const resetButton = () => {
        button.disabled = false;
        button.classList.remove("is-loading");
        button.innerHTML = '<i class="ph ph-crosshair" aria-hidden="true"></i>';
      };

      const showMessage = (text, type = "", duration = 5000) => {
        clearTimeout(locationMessageTimer);
        message.textContent = text;
        message.className = `map-location-message is-visible${type ? ` is-${type}` : ""}`;
        if (duration) {
          locationMessageTimer = setTimeout(() => {
            message.className = "map-location-message";
          }, duration);
        }
      };

      L.DomEvent.on(button, "click", () => {
        if (!navigator.geolocation) {
          showMessage("Váš prehliadač nepodporuje zisťovanie polohy.", "error", 7000);
          return;
        }

        button.disabled = true;
        button.classList.add("is-loading");
        button.innerHTML = '<i class="ph ph-spinner" aria-hidden="true"></i>';
        showMessage("Zisťujem vašu polohu…", "", 0);

        navigator.geolocation.getCurrentPosition(
          ({ coords }) => {
            const { latitude, longitude, accuracy } = coords;
            const position = [latitude, longitude];
            const roundedAccuracy = Math.max(1, Math.round(accuracy));

            if (userLocationLayer) map.removeLayer(userLocationLayer);
            userLocationLayer = L.layerGroup([
              L.circle(position, {
                radius: roundedAccuracy,
                className: "user-location-accuracy",
                interactive: false,
              }),
              L.circleMarker(position, {
                radius: 8,
                className: "user-location-marker",
              }).bindPopup(
                `<p class="popup-loc">Vaša poloha</p><p class="popup-meta">Presnosť približne ${roundedAccuracy.toLocaleString("sk-SK")} m</p>`
              ),
            ]).addTo(map);

            map.flyTo(position, Math.max(map.getZoom(), 14), { duration: 0.7 });
            showMessage(`Poloha nájdená s presnosťou približne ${roundedAccuracy.toLocaleString("sk-SK")} m.`, "success");
            resetButton();
          },
          (error) => {
            showMessage(locationErrorMessage(error), "error", 8000);
            resetButton();
          },
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
        );
      });

      return container;
    },
  });

  new LocationControl().addTo(map);
}

function centerMapOnVisibleMarkers() {
  const points = mapMarkerPoints();

  map.closePopup();
  if (points.length > 0) {
    fitMapToPoints(points, { animate: true });
  } else {
    map.flyTo(SK_CENTER, 7, { duration: 0.6 });
  }
}

function addCenterMapControl() {
  const CenterMapControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const container = L.DomUtil.create("div", "map-center-control");
      const button = L.DomUtil.create("button", "map-center-button", container);

      button.type = "button";
      button.title = "Vycentrovať mapu";
      button.setAttribute("aria-label", "Vycentrovať mapu na viditeľné značky");
      button.innerHTML = '<i class="ph ph-corners-in" aria-hidden="true"></i>';

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      L.DomEvent.on(button, "click", centerMapOnVisibleMarkers);

      return container;
    },
  });

  new CenterMapControl().addTo(map);
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

window.addEventListener("site:themechange", () => setTiles(state.mapLayer));

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

function formatNum(value) {
  return Number(value || 0).toLocaleString("sk-SK");
}

function pluralSk(value, one, few, many) {
  const n = Math.abs(Number(value));
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

function countPhrase(value, forms) {
  return `${formatNum(value)} ${pluralSk(value, forms[0], forms[1], forms[2])}`;
}

function joinSk(parts) {
  if (parts.length <= 1) return parts[0] || "";
  return `${parts.slice(0, -1).join(", ")} a ${parts[parts.length - 1]}`;
}

function startOfLocalDay(offsetDays = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.getTime();
}

function countItemsBetween(items, getIso, start, end) {
  return (items || []).filter((item) => {
    const time = itemTime(getIso(item));
    return time !== null && time >= start && time < end;
  }).length;
}

function trendText(current, previous) {
  if (current === 0 && previous === 0) return "bez záznamov aj minulý týždeň";
  if (previous === 0) return "minulý týždeň bez hlásení";
  const delta = current - previous;
  if (delta === 0) return "rovnako ako minulý týždeň";
  const pct = Math.max(1, Math.round((Math.abs(delta) / previous) * 100));
  return delta > 0
    ? `o ${pct} % viac ako min. týždeň`
    : `o ${pct} % menej ako min. týždeň`;
}

function placeLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.split(/[;,|]/)[0].trim();
}

function placeKey(value) {
  return normalizeSearchText(placeLabel(value))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function topSightingPlace(days = 30) {
  const start = startOfLocalDay(-(days - 1));
  const counts = new Map();

  for (const sighting of state.sightings) {
    const label = placeLabel(sighting.location);
    const key = placeKey(label);
    if (!key) continue;

    const time = itemTime(sighting.reportedAt);
    if (time !== null && time < start) continue;

    const entry = counts.get(key) || { label, count: 0, latest: 0 };
    entry.count += 1;
    entry.latest = Math.max(entry.latest, time || 0);
    counts.set(key, entry);
  }

  const top = Array.from(counts.values()).sort(
    (a, b) => b.count - a.count || b.latest - a.latest
  )[0];

  if (!top) return "";
  return top.count > 1 ? `${top.label} (${top.count}x)` : top.label;
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function homeInsightCopy({ todaySightings, todayNews, weekSightings, mapPoints, topPlace }) {
  const todayParts = [];
  if (todaySightings > 0) {
    todayParts.push(countPhrase(todaySightings, ["hlásenie", "hlásenia", "hlásení"]));
  }
  if (todayNews > 0) {
    todayParts.push(countPhrase(todayNews, ["správa", "správy", "správ"]));
  }

  if (todayParts.length > 0) {
    return `Dnes pribudlo ${joinSk(todayParts)}. Mapa teraz pokrýva ${countPhrase(
      mapPoints,
      ["bod", "body", "bodov"]
    )}.`;
  }

  if (weekSightings > 0 && topPlace) {
    return `Za posledných 7 dní evidujeme ${countPhrase(
      weekSightings,
      ["hlásenie", "hlásenia", "hlásení"]
    )}. Najčastejšie sa opakuje ${topPlace}.`;
  }

  if (mapPoints > 0) {
    return `Dáta sú načítané, dnes zatiaľ bez nových hlásení. Na mape zostáva ${countPhrase(
      mapPoints,
      ["bod", "body", "bodov"]
    )}.`;
  }

  return "Dáta sa práve načítavajú. Po obnove tu uvidíte najdôležitejší denný prehľad.";
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
  const now = new Date();
  const date = new Date(iso);
  if (isNaN(date)) return "";
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  if (date >= todayStart) return "dnes";
  if (date >= yesterdayStart) return "včera";
  const days = Math.floor((now - date) / 86400000);
  if (days < 31) return `pred ${days} ${days === 1 ? "dňom" : "dňami"}`;
  const months = Math.floor(days / 30);
  return `pred ${months} ${months === 1 ? "mesiacom" : "mesiacmi"}`;
}

function recordFreshness(iso) {
  const time = itemTime(iso);
  if (time === null) return { key: "unknown", label: "Vek záznamu neznámy" };
  const ageDays = Math.max(0, Date.now() - time) / 86400000;
  if (ageDays < 1) return { key: "today", label: "Menej ako 24 hodín" };
  if (ageDays < 7) return { key: "week", label: "Posledných 7 dní" };
  if (ageDays < 30) return { key: "month", label: "Posledných 30 dní" };
  return { key: "older", label: "Starší záznam" };
}

function warningRecordKind(item) {
  if (item?.sourceType === "report" || item?.sourceKey === "report") {
    return {
      key: "community",
      label: "Komunitné hlásenie",
      explanation: "Skontrolované moderátorom, nie overené v teréne.",
    };
  }
  return {
    key: "sourced",
    label: "Verejný záznam",
    explanation: "Prevzaté z verejného zdroja. Detail overte v pôvodnom zázname.",
  };
}

function newsRecordKind(item) {
  const sourceText = [item?.source, item?.articleUrl, item?.link, item?.googleNewsUrl]
    .filter(Boolean)
    .join(" ");
  const isOfficial = [
    /šop\s*sr/i,
    /štátna ochrana prírody/i,
    /pozor\s*medveď/i,
    /pozormedved\.sk/i,
    /zásahov[ýy]\s+tím/i,
  ].some((pattern) => pattern.test(sourceText));
  if (isOfficial) {
    return {
      key: "official",
      label: "Oficiálne upozornenie",
      explanation: "Zdrojom je ŠOP SR alebo jej informačný kanál.",
    };
  }
  if (item?.category === "warning") {
    return {
      key: "media-warning",
      label: "Varovanie zo správy",
      explanation: "Lokalitu a okolnosti overte v pôvodnom zdroji.",
    };
  }
  return {
    key: "news",
    label: "Súvisiaca správa",
    explanation: "Spravodajský kontext, nie potvrdenie aktuálnej polohy medveďa.",
  };
}

function recordSignalsHtml(kind, iso) {
  const freshness = recordFreshness(iso);
  return `<div class="record-signals">
    <span class="record-kind kind-${esc(kind.key)}">${esc(kind.label)}</span>
    <span class="record-freshness freshness-${esc(freshness.key)}"><span class="sr-only">Aktuálnosť: </span>${esc(freshness.label)}</span>
  </div>`;
}

function correctionHref(item, recordType) {
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

function safeExternalUrl(value) {
  if (!value) return "#";
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
}

function newsUrl(n) {
  return safeExternalUrl(n.articleUrl || n.googleNewsUrl || normalizeNewsLink(n.link));
}

function newsLocations(n) {
  if (!n || (n.category !== "warning" && !n.isIncident)) return [];
  const raw = Array.isArray(n.locations) && n.locations.length
    ? n.locations
    : n.place
      ? [{ place: n.place, lat: n.lat, lng: n.lng }]
      : [];
  const seen = new Set();
  return raw.flatMap((location) => {
    const place = String(location?.place || location?.name || "").trim();
    const key = normalizeSearchText(place);
    if (!place || !key || seen.has(key)) return [];
    seen.add(key);
    const lat = mapCoord(location.lat);
    const lng = mapCoord(location.lng);
    return [{ place, lat, lng, hasCoords: lat !== null && lng !== null }];
  });
}

function newsMapPoints(n) {
  return newsLocations(n).filter((location) => location.hasCoords);
}

function newsMapPoint(n) {
  return newsMapPoints(n)[0] || null;
}

function newsMarkerId(newsId, index) {
  return `${newsId}:location:${index}`;
}

function focusMapMarker(id, lat, lng) {
  const marker = state.markers.get(id);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById("mapViewport").scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start",
  });
  if (reduceMotion) map.setView([lat, lng], 12);
  else map.flyTo([lat, lng], 12, { duration: 0.45 });
  marker?.openPopup();
}

elNews.addEventListener("click", (event) => {
  const link = event.target.closest("[data-news-marker]");
  if (!link) return;
  event.preventDefault();
  const lat = mapCoord(link.dataset.lat);
  const lng = mapCoord(link.dataset.lng);
  if (lat === null || lng === null) return;
  focusMapMarker(link.dataset.newsMarker, lat, lng);
});

document.getElementById("map").addEventListener("click", (event) => {
  const link = event.target.closest("[data-coverage-incident]");
  if (!link) return;
  event.preventDefault();
  const incidentId = link.dataset.coverageIncident;
  const filtered = filteredNews();
  const index = filtered.findIndex((item) => String(item.incidentId) === String(incidentId));
  if (index >= 0 && listVisible.news <= index) {
    listVisible.news = index + 1;
    renderNews();
  }
  const details = document.getElementById(`coverage-${incidentId}`);
  if (!details) return;
  details.open = true;
  details.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "center",
  });
});

function readStoredMapLayer() {
  try {
    const stored = localStorage.getItem("mapLayer");
    return MAP_LAYER_IDS.includes(stored) ? stored : "standard";
  } catch (e) {
    return "standard";
  }
}

function revealStyle(i) {
  return `--i:${Math.min(i, 14)}`;
}

// --- Filtre mapy ---
const filterStart = $("filterStart");
const filterEnd = $("filterEnd");
const contentSearch = $("contentSearch");
const layerInputs = Array.from(document.querySelectorAll('input[name="mapLayer"]'));
const filterDialog = $("filterDialog");
const filterForm = $("mapFilterForm");
const filterOpenBtn = $("filterOpenBtn");
const filterCloseBtn = $("filterCloseBtn");
const filterCancelBtn = $("filterCancelBtn");
const resetFiltersBtn = $("resetFiltersBtn");
const filterCount = $("filterCount");
const legendDialog = $("legendDialog");
const legendOpenBtn = $("legendOpenBtn");
const legendCloseBtn = $("legendCloseBtn");

function todayInputDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

// Predvolene zobrazujeme hlásenia za posledný týždeň vrátane dneška.
filterStart.value = todayInputDate(-7);
filterEnd.value = todayInputDate();
state.filters.startDate = filterStart.value;
state.filters.endDate = filterEnd.value;

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
      matchesSearchQuery([
        s.location,
        s.note,
        s.source,
        ...(Array.isArray(s.sourceLinks) ? s.sourceLinks.map((link) => link.label) : []),
      ])
  );
}

function filteredNews() {
  return state.news.filter(
    (n) =>
      matchesDateRange(n.date) &&
      matchesSearchQuery([
        n.title,
        n.snippet,
        n.source,
        n.place,
        ...newsLocations(n).map((location) => location.place),
        ...(Array.isArray(n.coverage)
          ? n.coverage.flatMap((article) => [article.title, article.source, article.sourceTypeLabel])
          : []),
      ])
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

  const today = todayInputDate();
  const min = toInputDate(Math.min(...datedItems));
  const max = toInputDate(Math.max(...datedItems));
  const maxEnd = max > today ? max : today;

  filterStart.min = min;
  filterStart.max = state.filters.endDate || maxEnd;
  filterEnd.min = state.filters.startDate || min;
  filterEnd.max = maxEnd;
}

function renderFilteredViews() {
  resetListLimits();
  renderMarkers();
  if (state.loaded.sightings) renderSightings();
  if (state.loaded.news) renderNews();
}

function syncMapLayerControls() {
  for (const input of layerInputs) {
    input.checked = input.value === state.mapLayer;
  }
}

function showModal(dialog) {
  document.documentElement.classList.add("dialog-open");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeModal(dialog) {
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    document.documentElement.classList.remove("dialog-open");
  }
}

function syncFilterButton() {
  let count = 0;
  if (
    state.filters.startDate !== todayInputDate(-7) ||
    state.filters.endDate !== todayInputDate()
  ) {
    count += 1;
  }
  if (state.mapLayer !== "standard") count += 1;

  filterCount.textContent = String(count);
  filterCount.hidden = count === 0;
  filterOpenBtn.setAttribute(
    "aria-label",
    count ? `Otvoriť filtre, ${count} aktívne` : "Otvoriť filtre"
  );
}

function syncFilterDraft() {
  filterStart.value = state.filters.startDate;
  filterEnd.value = state.filters.endDate;
  syncMapLayerControls();
  syncDateFilterLimits();
}

function closeFilterDialog() {
  closeModal(filterDialog);
}

filterOpenBtn.addEventListener("click", () => {
  syncFilterDraft();
  showModal(filterDialog);
  requestAnimationFrame(() => filterStart.focus());
});
filterCloseBtn.addEventListener("click", closeFilterDialog);
filterCancelBtn.addEventListener("click", closeFilterDialog);
resetFiltersBtn.addEventListener("click", () => {
  filterStart.value = todayInputDate(-7);
  filterEnd.value = todayInputDate();
  const standardLayer = layerInputs.find((input) => input.value === "standard");
  if (standardLayer) standardLayer.checked = true;
});
filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (filterStart.value && filterEnd.value && filterStart.value > filterEnd.value) {
    filterEnd.value = filterStart.value;
  }

  state.filters.startDate = filterStart.value;
  state.filters.endDate = filterEnd.value;
  const selectedLayer = layerInputs.find((input) => input.checked)?.value || "standard";
  setTiles(selectedLayer);
  syncDateFilterLimits();
  syncFilterButton();
  closeFilterDialog();
  renderFilteredViews();
});
filterDialog.addEventListener("close", () => {
  document.documentElement.classList.remove("dialog-open");
  filterOpenBtn.focus();
});
filterDialog.addEventListener("click", (event) => {
  if (event.target === filterDialog) closeFilterDialog();
});

legendOpenBtn.addEventListener("click", () => {
  showModal(legendDialog);
  requestAnimationFrame(() => legendCloseBtn.focus());
});
legendCloseBtn.addEventListener("click", () => closeModal(legendDialog));
legendDialog.addEventListener("close", () => {
  document.documentElement.classList.remove("dialog-open");
  legendOpenBtn.focus();
});
legendDialog.addEventListener("click", (event) => {
  if (event.target === legendDialog) closeModal(legendDialog);
});

for (const dialog of [filterDialog, legendDialog]) {
  dialog.addEventListener("cancel", () => {
    document.documentElement.classList.remove("dialog-open");
  });
}

syncFilterButton();

// --- Vykreslenie varovaní ---
function warningSourceLinks(s) {
  const links = Array.isArray(s?.sourceLinks) ? s.sourceLinks : [];
  const normalized = links
    .map((link) => {
      try {
        const url = new URL(link?.url || "", window.location.href);
        return ["http:", "https:"].includes(url.protocol) ? { ...link, url: url.href } : null;
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .map((link) => ({
      key: link.key || "source",
      label: link.label || link.key || "Zdroj",
      url: link.url,
      sourceId: link.sourceId || null,
    }));
  if (!normalized.length && s?.url) {
    try {
      const url = new URL(s.url, window.location.href);
      if (["http:", "https:"].includes(url.protocol)) {
        normalized.push({ key: "source", label: s.source || "Zdroj", url: url.href, sourceId: null });
      }
    } catch (e) {
      // Neplatný alebo nebezpečný odkaz sa nezobrazí.
    }
  }
  const seen = new Set();
  return normalized.filter((link) => {
    const key = `${link.label}|${link.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Zlúčené varovanie ukáže všetky weby, ktoré evidujú rovnakú udalosť.
function warningSourceLabel(s) {
  const labels = [...new Set(warningSourceLinks(s).map((link) => link.label))];
  if (labels.length) return labels.join(" · ");
  if (s.sourceType === "tumedved") return "tumedved.sk";
  if (s.sourceType === "report") return "moderované hlásenie";
  return s.source || "";
}

function warningSourceLinksHtml(s, className) {
  const links = warningSourceLinks(s);
  if (!links.length) return "";
  return `<div class="source-links">${links.map((link) => `
    <a class="${className}" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">
      ${esc(link.label)} <i class="ph ph-arrow-up-right" aria-hidden="true"></i>
    </a>`).join("")}</div>`;
}

function renderSightings() {
  const items = filteredSightings();
  setText("sightingsCount", formatNum(items.length));
  if (items.length === 0) {
    elSightings.innerHTML = `<div class="empty"><i class="ph ph-binoculars"></i>${
      hasSearchFilter() || hasDateFilter()
        ? "Žiadne varovania nezodpovedajú filtrom."
        : "Zatiaľ žiadne varovania."
    }</div>`;
    return;
  }

  const visibleItems = visibleListItems(items, "sightings");
  elSightings.innerHTML = visibleItems
    .map(
      (s, i) => {
        const sourceLabel = warningSourceLabel(s);
        const kind = warningRecordKind(s);
        const sourceLinks = warningSourceLinksHtml(s, "card-link");
        const withTime = s.datePrecision !== "date";
        const correction = correctionHref(s, kind.label.toLocaleLowerCase("sk-SK"));
        const mapAction = s.hasCoords
          ? `<button class="card-map-action" type="button" data-map-item="${esc(s.id)}">
              <i class="ph ph-map-pin" aria-hidden="true"></i>
              Zobraziť na mape
            </button>`
          : "";
        return `
      <article class="card sighting reveal" style="${revealStyle(i)}" data-id="${esc(s.id)}">
        ${recordSignalsHtml(kind, s.reportedAt)}
        <h4 class="card-title">${esc(s.location)}</h4>
        <p class="record-explanation">${esc(kind.explanation)}</p>
        <div class="card-meta">
          ${sourceLabel ? `<span class="meta-source"><span class="meta-label">Zdroj:</span>${esc(sourceLabel)}</span>` : ""}
          <time class="meta-date" datetime="${esc(s.reportedAt || "")}"><span class="meta-label">${withTime ? "Hlásené:" : "Dátum:"}</span>${esc(fmtDate(s.reportedAt, withTime))}</time>
        </div>
        ${s.note ? `<p class="card-note">${esc(s.note)}</p>` : ""}
        <div class="card-actions">
          <div class="card-main-actions">${mapAction}${sourceLinks}</div>
          <a class="card-correction" href="${esc(correction)}" aria-label="Nahlásiť chybu v zázname ${esc(s.location)}">Nahlásiť chybu</a>
        </div>
      </article>`;
      }
    )
    .join("") + loadMoreButtonHtml("sightings", visibleItems.length, items.length);

  elSightings.querySelectorAll("[data-map-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const s = state.sightings.find((item) => item.id === button.dataset.mapItem);
      if (s?.hasCoords) focusMapMarker(s.id, s.lat, s.lng);
    });
  });

  const loadMoreButton = elSightings.querySelector('[data-load-more="sightings"]');
  if (loadMoreButton) {
    loadMoreButton.addEventListener("click", () => {
      listVisible.sightings += listPageSize();
      renderSightings();
    });
  }
}

// --- Značky na mape ---
function renderMarkers() {
  state.markers.forEach((m) => map.removeLayer(m));
  state.markers.clear();

  const bounds = [];
  for (const s of filteredSightings()) {
    if (!s.hasCoords) continue;
    const marker = L.marker([s.lat, s.lng], { icon: pinIcon }).addTo(map);
    const sourceLabel = warningSourceLabel(s);
    const kind = warningRecordKind(s);
    const withTime = s.datePrecision !== "date";
    marker.bindPopup(`
      ${recordSignalsHtml(kind, s.reportedAt)}
      <p class="popup-loc">${esc(s.location)}</p>
      <p class="popup-meta"><strong>${esc(sourceLabel || "Zdroj neuvedený")}</strong><br>${withTime ? "Hlásené" : "Dátum záznamu"}: ${esc(fmtDate(s.reportedAt, withTime))}</p>
      ${s.note ? `<p class="popup-note">${esc(s.note)}</p>` : ""}
      ${warningSourceLinksHtml(s, "popup-link")}
    `);
    state.markers.set(s.id, marker);
    bounds.push([s.lat, s.lng]);
  }

  // Medvedie varovania zo správ — admin im priradil lokalitu. Na mape majú
  // vlastnú (hranatú, inak sfarbenú) značku, odlíšenú od moderovaných hlásení.
  // Bežné články (category !== "warning") sa na mape nezobrazujú.
  let warningsOnMap = 0;
  for (const n of filteredNews()) {
    const href = newsUrl(n);
    const kind = newsRecordKind(n);
    newsLocations(n).forEach((point, index) => {
      if (!point.hasCoords) return;
      const marker = L.marker([point.lat, point.lng], { icon: newsPinIcon }).addTo(map);
      marker.bindPopup(`
        ${recordSignalsHtml(kind, n.date)}
        <p class="popup-loc">${esc(point.place || "Varovanie zo správ")}</p>
        <p class="popup-meta">${esc(n.source || "")}${n.source ? ", " : ""}${esc(fmtDate(n.date))}</p>
        <p class="popup-note">${esc(n.title)}</p>
        <a class="popup-link" href="${esc(href)}" target="_blank" rel="noopener">Prečítať zdroj <i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>
        ${n.isIncident && n.sourceCount > 1
          ? `<a class="popup-coverage-link" href="#coverage-${esc(n.incidentId)}" data-coverage-incident="${esc(n.incidentId)}">Ďalšie zdroje (${n.sourceCount - 1})</a>`
          : ""}
      `);
      state.markers.set(newsMarkerId(n.id, index), marker);
      bounds.push([point.lat, point.lng]);
      warningsOnMap++;
    });
  }

  const mapMeta = $("mapMeta");
  if (mapMeta) {
    const sightOnMap = bounds.length - warningsOnMap;
    const sightingLabel = countPhrase(sightOnMap, ["hlásenie", "hlásenia", "hlásení"]);
    const newsLabel = countPhrase(warningsOnMap, ["správa", "správy", "správ"]);
    const fullLabel = `${sightingLabel} · ${newsLabel}${
      hasDateFilter() || hasSearchFilter() ? " podľa filtrov" : " na mape"
    }`;
    const compactLabel = `${sightingLabel} · ${newsLabel}`;
    setText("mapMetaLive", fullLabel);
    setText("mapMetaLong", fullLabel);
    setText("mapMetaCompact", compactLabel);
  }

  if (bounds.length > 0) {
    fitMapToPoints(bounds);
  } else if (hasDateFilter() || hasSearchFilter()) {
    map.setView(SK_CENTER, 7);
  }
}

// --- Vykreslenie správ ---
// Varovania zo správ ostávajú v zozname s lokalitou a preklikom na mapu.
// Bežné články sa na mapu neviažu.
function newsLocationLinksHtml(n) {
  const locations = newsLocations(n);
  if (!locations.length) return "";
  return `<div class="news-location-links" aria-label="Lokality varovania">
    <span class="news-location-label"><i class="ph ph-map-pin" aria-hidden="true"></i> Lokality</span>
    ${locations.map((location, index) => location.hasCoords
      ? `<a href="#mapViewport" data-news-marker="${esc(newsMarkerId(n.id, index))}" data-lat="${location.lat}" data-lng="${location.lng}">${esc(location.place)}</a>`
      : `<span class="news-location-name">${esc(location.place)}</span>`
    ).join("")}
  </div>`;
}

function renderNews() {
  const items = filteredNews();
  setText("newsCount", formatNum(items.length));
  if (items.length === 0) {
    elNews.innerHTML = `<div class="empty"><i class="ph ph-newspaper"></i>${
      hasDateFilter() || hasSearchFilter()
        ? "Žiadne správy nezodpovedajú filtrom."
        : "Momentálne žiadne správy."
    }</div>`;
    return;
  }
  const visibleItems = visibleListItems(items, "news");
  elNews.innerHTML = visibleItems
    .map(
      (n, i) => {
        const point = newsMapPoint(n);
        const isWarning = n.category === "warning";
        const place = n.isIncident || isWarning ? newsPlaceLabel(n) : "";
        const locationLinks = n.isIncident || isWarning ? newsLocationLinksHtml(n) : "";
        const href = newsUrl(n);
        const kind = newsRecordKind(n);
        const correction = correctionHref(n, kind.label.toLocaleLowerCase("sk-SK"));
        const articleLink =
          href && href !== "#"
            ? `<a class="card-link" href="${esc(href)}" target="_blank" rel="noopener">
                Prečítať zdroj <i class="ph ph-arrow-up-right" aria-hidden="true"></i>
              </a>`
            : "";
        const coverage = n.isIncident && Array.isArray(n.coverage)
          ? `<details class="coverage-details" id="coverage-${esc(n.incidentId)}">
              <summary>Všetky zdroje (${n.coverage.length})</summary>
              <ul class="coverage-list">
                ${n.coverage.map((article) => `<li>
                  <div>
                    <strong>${esc(article.source)}</strong>
                    <span>${esc(article.sourceTypeLabel)}${article.publishedAt ? `, ${esc(fmtDate(article.publishedAt, true))}` : ""}</span>
                  </div>
                  ${safeExternalUrl(article.url) !== "#" ? `<a href="${esc(safeExternalUrl(article.url))}" target="_blank" rel="noopener">Otvoriť článok <i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>` : ""}
                </li>`).join("")}
              </ul>
            </details>`
          : "";
        return `
      <article class="card news reveal${point ? " has-place" : ""}${
          isWarning ? " is-warning" : ""
        }" style="${revealStyle(i)}" data-id="${esc(n.id)}"${n.incidentId ? ` id="incident-${esc(n.incidentId)}"` : ""}>
        ${recordSignalsHtml(kind, n.date)}
        <h4 class="card-title">${esc(n.title)}</h4>
        <p class="record-explanation">${esc(kind.explanation)}</p>
        <div class="card-meta">
          ${n.source ? `<span class="meta-source"><span class="meta-label">Zdroj:</span>${esc(n.source)}</span>` : ""}
          ${n.sourceCount > 1 ? `<span class="meta-coverage">${esc(countPhrase(n.sourceCount, ["zdroj", "zdroje", "zdrojov"]))}</span>` : ""}
          ${n.verificationStatus === "official_notice" ? '<span class="meta-official">Obsahuje úradné oznámenie</span>' : ""}
          ${
            place
              ? `<span class="meta-place"><i class="ph ph-map-pin" aria-hidden="true"></i>${esc(place)}</span>`
              : ""
          }
          <time class="meta-date" datetime="${esc(n.date || "")}"><span class="meta-label">Publikované:</span>${esc(fmtDate(n.date))}</time>
        </div>
        ${
          n.snippet
            ? `<p class="card-note">${esc(n.snippet.slice(0, 175))}${
                n.snippet.length > 175 ? "…" : ""
              }</p>`
            : ""
        }
        ${locationLinks}
        <div class="card-actions">
          <div class="card-main-actions">${articleLink}${mapAction}</div>
          <a class="card-correction" href="${esc(correction)}" aria-label="Nahlásiť chybu v správe ${esc(n.title)}">Nahlásiť chybu</a>
        </div>
        ${coverage}
      </article>`
      }
    )
    .join("") + loadMoreButtonHtml("news", visibleItems.length, items.length);

  elNews.querySelectorAll('.coverage-details').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (details.open) details.scrollIntoView({ block: 'nearest' });
    });
  });

  const loadMoreButton = elNews.querySelector('[data-load-more="news"]');
  if (loadMoreButton) {
    loadMoreButton.addEventListener("click", () => {
      listVisible.news += listPageSize();
      renderNews();
    });
  }
}

// --- Štatistiky ---
function renderStats() {
  const todaySightings = state.sightings.filter((s) => isToday(s.reportedAt)).length;
  const todayNews = state.news.filter((n) => isToday(n.date)).length;
  const currentWeekStart = startOfLocalDay(-6);
  const previousWeekStart = startOfLocalDay(-13);
  const now = Date.now() + 1;
  const weekSightings = countItemsBetween(
    state.sightings,
    (s) => s.reportedAt,
    currentWeekStart,
    now
  );
  const previousWeekSightings = countItemsBetween(
    state.sightings,
    (s) => s.reportedAt,
    previousWeekStart,
    currentWeekStart
  );
  const mappedSightings = state.sightings.filter((s) => s.hasCoords).length;
  const warningsOnMap = state.news.reduce((count, item) => count + newsMapPoints(item).length, 0);
  const mapPoints = mappedSightings + warningsOnMap;
  const topPlace = topSightingPlace();

  setText("statSightings", formatNum(todaySightings));
  setText(
    "statSightingsLabel",
    `${pluralSk(todaySightings, "hlásenie", "hlásenia", "hlásení")} dnes`
  );
  setText("statNews", formatNum(todayNews));
  setText("statNewsLabel", `${pluralSk(todayNews, "správa", "správy", "správ")} dnes`);
  setText("statWeekSightings", formatNum(weekSightings));
  setText(
    "statWeekSightingsLabel",
    `${pluralSk(weekSightings, "hlásenie", "hlásenia", "hlásení")} za 7 dní`
  );
  setText("statWeekTrend", trendText(weekSightings, previousWeekSightings));
  setText("statMappedPoints", formatNum(mapPoints));
  setText(
    "statMappedPointsLabel",
    `${pluralSk(mapPoints, "bod", "body", "bodov")} na mape`
  );
  setText(
    "statWarnings",
    warningsOnMap
      ? `${countPhrase(warningsOnMap, ["varovanie", "varovania", "varovaní"])} na mape`
      : "bez varovaní na mape"
  );
  setText("statTopPlace", topPlace ? `najčastejšie: ${topPlace}` : "lokality sa zbierajú");
  setText("statUpdated", fmtTime(state.updatedAt) || "-");
  setText(
    "statHeadline",
    homeInsightCopy({ todaySightings, todayNews, weekSightings, mapPoints, topPlace })
  );
}

function setUpdated(iso) {
  const updated = $("updated");
  if (updated) updated.textContent = iso ? "Aktualizované " + updatedText(iso) : "";
}

// --- Načítanie dát ---
const mapLoadStatus = $("mapLoadStatus");

function showLoadStatus(message, { error = false, retryAction = null } = {}) {
  mapLoadStatus.hidden = false;
  mapLoadStatus.classList.toggle("is-error", error);
  mapLoadStatus.title = message;
  mapLoadStatus.innerHTML = `<span class="map-load-copy">${esc(message)}</span>${
    retryAction
      ? '<button type="button" data-retry-load aria-label="Skúsiť načítať dáta znova"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i><span>Skúsiť znova</span></button>'
      : ""
  }`;
  mapLoadStatus.querySelector("[data-retry-load]")?.addEventListener("click", retryAction);
}

function hideLoadStatus() {
  mapLoadStatus.hidden = true;
  mapLoadStatus.classList.remove("is-error");
  mapLoadStatus.removeAttribute("title");
}

function syncLoadStatus() {
  if (state.dataLoading) {
    showLoadStatus("Načítavam aktuálne dáta...");
    return;
  }
  if (state.tileError) {
    showLoadStatus("Mapové podklady sa nepodarilo načítať. Zoznamy zostávajú dostupné.", {
      error: true,
      retryAction: () => setTiles(state.mapLayer),
    });
    return;
  }
  if (state.dataFailures.length) {
    showLoadStatus(
      `Nepodarilo sa obnoviť: ${state.dataFailures.join(" a ")}. Zobrazený zoznam zostal zachovaný.`,
      { error: true, retryAction: loadData }
    );
    return;
  }
  hideLoadStatus();
}

async function loadData() {
  state.dataLoading = true;
  syncLoadStatus();
  // News načítavame bez cache, aby sa moderácia kategórie/lokality hneď
  // prejavila aj na mape.
  const [sRes, nRes] = await Promise.allSettled([
    fetch(`/api/warnings?v=${API_VERSION}`).then((r) => r.json()),
    fetch(`/api/news?v=${API_VERSION}`, { cache: "no-store" }).then((r) => r.json()),
  ]);

  const failures = [];

  if (sRes.status === "fulfilled" && Array.isArray(sRes.value.items)) {
    state.sightings = dedupeSightings(sRes.value.items);
    state.sightingsUpdatedAt = sRes.value.updatedAt;
    state.loaded.sightings = true;
    renderSightings();
  } else {
    failures.push("hlásenia");
  }

  if (nRes.status === "fulfilled" && Array.isArray(nRes.value.items)) {
    state.news = nRes.value.items;
    state.newsUpdatedAt = nRes.value.updatedAt;
    state.loaded.news = true;
    renderNews();
  } else {
    failures.push("správy");
  }

  renderMarkers();
  state.updatedAt = latestIso(state.sightingsUpdatedAt, state.newsUpdatedAt);
  setUpdated(state.updatedAt);
  syncDateFilterLimits();
  syncFilterButton();

  state.dataFailures = failures;
  state.dataLoading = false;
  syncLoadStatus();
}

let searchDebounce = null;
contentSearch.addEventListener("input", (event) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.filters.query = event.target.value;
    renderFilteredViews();
  }, 220);
});

function handleListModeChange() {
  resetListLimits();
  if (state.loaded.sightings) renderSightings();
  if (state.loaded.news) renderNews();
  refitMapOnVisibleMarkers();
}

for (const media of [phoneListMedia, tabletListMedia]) {
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleListModeChange);
  } else {
    media.addListener(handleListModeChange);
  }
}

let lastMapContainerWidth = map.getContainer().clientWidth;
function handleMapContainerResize() {
  const nextWidth = map.getContainer().clientWidth;
  if (nextWidth === lastMapContainerWidth) return;
  lastMapContainerWidth = nextWidth;
  if (phoneListMedia.matches) refitMapOnVisibleMarkers();
}

if ("ResizeObserver" in window) {
  const mapResizeObserver = new ResizeObserver(handleMapContainerResize);
  mapResizeObserver.observe(map.getContainer());
}
window.addEventListener("resize", handleMapContainerResize);

// --- Štart ---
setTiles(state.mapLayer);
addLocationControl();
addCenterMapControl();
loadData();
// Automatická obnova zobrazenia každých 15 minút (dáta sa scrapujú cez externý cron job).
setInterval(loadData, 15 * 60 * 1000);

