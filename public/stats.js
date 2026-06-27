// Medvede na Slovensku — štatistiky.

const state = {
  sightings: [],
  news: [],
  sightingsUpdatedAt: null,
  newsUpdatedAt: null,
  updatedAt: null,
};

const $ = (id) => document.getElementById(id);

// --- Téma (svetlá / tmavá) ---
const themeBtn = $("themeBtn");

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function syncThemeButton(theme) {
  themeBtn.innerHTML = `<i class="ph ph-${theme === "dark" ? "sun" : "moon"}" aria-hidden="true"></i>`;
  themeBtn.setAttribute("aria-label", theme === "dark" ? "Prepnúť svetlý režim" : "Prepnúť tmavý režim");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("theme", theme);
  } catch (e) {}
  syncThemeButton(theme);
  
  // Re-render chart colors
  updateChartTheme();
}

themeBtn.addEventListener("click", () => {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
});

// Chart instances
let timelineChart;
let topLocationsChart;
let timeOfDayChart;

const getChartColors = () => {
  const isDark = currentTheme() === "dark";
  return {
    textColor: isDark ? "#a1a1aa" : "#52525b",
    gridColor: isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
    sightingsColor: isDark ? "#fb923c" : "#f97316", // orange
    newsColor: isDark ? "#38bdf8" : "#0ea5e9", // sky blue
    locationsColors: isDark 
      ? ['#fb923c', '#f87171', '#fbbf24', '#a3e635', '#34d399', '#2dd4bf', '#38bdf8', '#818cf8', '#c084fc', '#f472b6']
      : ['#f97316', '#ef4444', '#f59e0b', '#84cc16', '#10b981', '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899']
  };
};

Chart.defaults.font.family = "'Hanken Grotesk', system-ui, sans-serif";

function updateChartTheme() {
  const colors = getChartColors();
  
  if (timelineChart) {
    timelineChart.options.scales.x.ticks.color = colors.textColor;
    timelineChart.options.scales.y.ticks.color = colors.textColor;
    timelineChart.options.scales.x.grid.color = colors.gridColor;
    timelineChart.options.scales.y.grid.color = colors.gridColor;
    timelineChart.options.plugins.legend.labels.color = colors.textColor;
    timelineChart.data.datasets[0].backgroundColor = colors.sightingsColor;
    timelineChart.data.datasets[1].backgroundColor = colors.newsColor;
    timelineChart.update();
  }

  if (topLocationsChart) {
    topLocationsChart.options.scales.x.ticks.color = colors.textColor;
    topLocationsChart.options.scales.y.ticks.color = colors.textColor;
    topLocationsChart.options.scales.x.grid.color = colors.gridColor;
    topLocationsChart.options.scales.y.grid.color = colors.gridColor;
    topLocationsChart.options.plugins.legend.labels.color = colors.textColor;
    topLocationsChart.data.datasets[0].backgroundColor = colors.locationsColors;
    topLocationsChart.update();
  }

  if (timeOfDayChart) {
    timeOfDayChart.options.plugins.legend.labels.color = colors.textColor;
    timeOfDayChart.data.datasets[0].backgroundColor = colors.locationsColors.slice(0, 4);
    timeOfDayChart.update();
  }
}

// --- Pomocné funkcie ---
function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function fmtDate(iso, withTime = false) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
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

function latestIso(...values) {
  return values.reduce((latest, iso) => {
    if (!iso) return latest;
    const time = new Date(iso).getTime();
    if (Number.isNaN(time)) return latest;
    if (!latest || time > latest.time) return { iso, time };
    return latest;
  }, null)?.iso || null;
}

function updatedText(iso) {
  if (!iso) return "";
  return isToday(iso) ? `dnes ${fmtTime(iso)}` : fmtDate(iso, true);
}

function setUpdated(iso) {
  const el = $("updated");
  if (!el) return;
  el.textContent = iso ? `Aktualizované ${updatedText(iso)}` : "";
}

function setStatus(message, isError = false) {
  const existing = document.getElementById("statsStatus");
  if (!message) {
    if (existing) existing.remove();
    return;
  }

  const host = document.querySelector(".stats-page .masthead");
  if (!host) return;
  const el = existing || document.createElement("p");
  el.id = "statsStatus";
  el.className = `stats-status${isError ? " error" : ""}`;
  el.textContent = message;
  if (!existing) host.appendChild(el);
}

function processStats() {
  // 1. Zohľadniť základné štatistiky
  const totalSightings = state.sightings.length;
  const totalNews = state.news.length;
  const todaySightings = state.sightings.filter(s => isToday(s.reportedAt)).length;
  
  // 2. Najčastejšie lokality hlásení
  const locationsCount = {};
  state.sightings.forEach(s => {
    if (s.location) {
      // Vyčistíme názov lokality pre lepšie zoskupovanie (napr. odstránime " - okolie")
      const loc = s.location.split(',')[0].split('-')[0].trim();
      if(loc.length > 2) {
        locationsCount[loc] = (locationsCount[loc] || 0) + 1;
      }
    }
  });

  const sortedLocations = Object.entries(locationsCount)
    .sort((a, b) => b[1] - a[1]);
  
  const topPlace = sortedLocations.length > 0 ? sortedLocations[0][0] : "Neznáma";
  
  $("statTotalSightings").textContent = totalSightings.toLocaleString("sk-SK");
  $("statTotalNews").textContent = totalNews.toLocaleString("sk-SK");
  $("statTodaySightings").textContent = todaySightings.toLocaleString("sk-SK");
  $("statTopPlace").textContent = topPlace;

  // 3. Pripraviť dáta pre časovú os (Zoskupenie po mesiacoch)
  const timelineData = {};
  
  const addDateToTimeline = (isoDate, type) => {
    if (!isoDate) return;
    const d = new Date(isoDate);
    if(Number.isNaN(d.getTime())) return;
    
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!timelineData[monthKey]) timelineData[monthKey] = { sightings: 0, news: 0 };
    timelineData[monthKey][type]++;
  };

  state.sightings.forEach(s => addDateToTimeline(s.reportedAt, 'sightings'));
  state.news.forEach(n => addDateToTimeline(n.date, 'news'));

  const sortedMonths = Object.keys(timelineData).sort();
  const timelineLabels = sortedMonths.map(m => {
    const [year, month] = m.split('-');
    return new Date(year, month - 1).toLocaleDateString('sk-SK', { month: 'short', year: 'numeric' });
  });
  
  const timelineSightings = sortedMonths.map(m => timelineData[m].sightings);
  const timelineNews = sortedMonths.map(m => timelineData[m].news);

  // 4. Čas dňa (Ráno, Deň, Večer, Noc)
  const timeOfDay = {
    "Noc (22:00 - 05:59)": 0,
    "Ráno (06:00 - 09:59)": 0,
    "Deň (10:00 - 17:59)": 0,
    "Večer (18:00 - 21:59)": 0,
  };

  state.sightings.forEach(s => {
    if (!s.reportedAt) return;
    const d = new Date(s.reportedAt);
    if(Number.isNaN(d.getTime())) return;
    const h = d.getHours();
    
    if (h >= 6 && h < 10) timeOfDay["Ráno (06:00 - 09:59)"]++;
    else if (h >= 10 && h < 18) timeOfDay["Deň (10:00 - 17:59)"]++;
    else if (h >= 18 && h < 22) timeOfDay["Večer (18:00 - 21:59)"]++;
    else timeOfDay["Noc (22:00 - 05:59)"]++;
  });

  renderCharts(timelineLabels, timelineSightings, timelineNews, sortedLocations.slice(0, 10), timeOfDay);
}

function renderCharts(timelineLabels, timelineSightings, timelineNews, topLocations, timeOfDay) {
  const colors = getChartColors();
  
  // Zničenie starých grafov ak existujú
  if (timelineChart) timelineChart.destroy();
  if (topLocationsChart) topLocationsChart.destroy();
  if (timeOfDayChart) timeOfDayChart.destroy();

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: colors.textColor } }
    },
    scales: {
      x: { ticks: { color: colors.textColor }, grid: { color: colors.gridColor } },
      y: { ticks: { color: colors.textColor }, grid: { color: colors.gridColor } }
    }
  };

  // Timeline graf
  const ctxTimeline = document.getElementById('timelineChart').getContext('2d');
  timelineChart = new Chart(ctxTimeline, {
    type: 'bar',
    data: {
      labels: timelineLabels,
      datasets: [
        {
          label: 'Hlásenia',
          data: timelineSightings,
          backgroundColor: colors.sightingsColor,
          borderRadius: 4
        },
        {
          label: 'Správy',
          data: timelineNews,
          backgroundColor: colors.newsColor,
          borderRadius: 4
        }
      ]
    },
    options: {
      ...commonOptions,
      plugins: {
        ...commonOptions.plugins,
        tooltip: {
          mode: "index",
          intersect: false,
        },
      },
    }
  });

  // Top Locations graf
  const locLabels = topLocations.map(l => l[0]);
  const locData = topLocations.map(l => l[1]);
  
  const ctxLocations = document.getElementById('topLocationsChart').getContext('2d');
  topLocationsChart = new Chart(ctxLocations, {
    type: 'bar',
    data: {
      labels: locLabels,
      datasets: [{
        label: 'Počet hlásení',
        data: locData,
        backgroundColor: colors.locationsColors,
        borderRadius: 4
      }]
    },
    options: {
      ...commonOptions,
      indexAxis: 'y', // horizontálny bar chart
      scales: {
        x: { ...commonOptions.scales.x, beginAtZero: true },
        y: { ...commonOptions.scales.y }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });

  // Time of Day graf (Doughnut)
  const ctxTime = document.getElementById('timeOfDayChart').getContext('2d');
  timeOfDayChart = new Chart(ctxTime, {
    type: 'doughnut',
    data: {
      labels: Object.keys(timeOfDay),
      datasets: [{
        data: Object.values(timeOfDay),
        backgroundColor: colors.locationsColors.slice(0, 4),
        borderWidth: 0,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { 
          position: window.innerWidth < 900 ? 'bottom' : 'right',
          labels: { color: colors.textColor }
        }
      }
    }
  });
}

async function loadData() {
  const cacheBust = Date.now();
  try {
    const [sRes, nRes] = await Promise.all([
      fetch(`/api/sightings?t=${cacheBust}`, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`Hlásenia HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`/api/news?t=${cacheBust}`, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`Správy HTTP ${r.status}`);
        return r.json();
      })
    ]);

    if (sRes.items) state.sightings = sRes.items;
    if (nRes.items) state.news = nRes.items;
    state.sightingsUpdatedAt = sRes.updatedAt || null;
    state.newsUpdatedAt = nRes.updatedAt || null;
    state.updatedAt = latestIso(state.sightingsUpdatedAt, state.newsUpdatedAt);
    setUpdated(state.updatedAt);
    setStatus("");

    processStats();

  } catch (err) {
    console.error("Nepodarilo sa načítať dáta pre štatistiky:", err);
    setStatus("Nepodarilo sa načítať dáta pre štatistiky. Skúste obnoviť stránku.", true);
  }
}

// Inicializácia
syncThemeButton(currentTheme());
setStatus("Načítavam štatistiky…");
loadData();

window.addEventListener("resize", () => {
  if (!timeOfDayChart) return;
  const nextPos = window.innerWidth < 900 ? "bottom" : "right";
  if (timeOfDayChart.options.plugins.legend.position !== nextPos) {
    timeOfDayChart.options.plugins.legend.position = nextPos;
    timeOfDayChart.update();
  }
});
