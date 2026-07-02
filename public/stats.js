// Kde je Medveď — štatistiky.

const state = {
  report: null,
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
    topLocationsChart.data.datasets[0].backgroundColor = colors.sightingsColor;
    topLocationsChart.data.datasets[1].backgroundColor = colors.newsColor;
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

function renderReport(report) {
  // 1. Základné štatistiky (počítané serverom zo všetkých dát)
  $("statTotalSightings").textContent = report.totals.sightings.toLocaleString("sk-SK");
  $("statTotalNews").textContent = report.totals.news.toLocaleString("sk-SK");
  $("statTodaySightings").textContent = report.totals.todaySightings.toLocaleString("sk-SK");
  $("statTopPlace").textContent = report.topPlace || "Neznáma";

  // 2. Časová os — server vracia [{ month: "YYYY-MM", sightings, news }]
  const timelineLabels = report.timeline.map((t) => {
    const [year, month] = t.month.split("-");
    return new Date(year, month - 1).toLocaleDateString("sk-SK", { month: "short", year: "numeric" });
  });
  const timelineSightings = report.timeline.map((t) => t.sightings);
  const timelineNews = report.timeline.map((t) => t.news);

  // 3. Najčastejšie lokality — hlásenia aj zmienky v správach (top 10)
  const topLocations = report.topLocations.slice(0, 10);

  renderCharts(timelineLabels, timelineSightings, timelineNews, topLocations, report.timeOfDay);
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

  // Top Locations graf — stohovaný: hlásenia + zmienky v správach
  const locLabels = topLocations.map((l) => l.name);
  const ctxLocations = document.getElementById('topLocationsChart').getContext('2d');
  topLocationsChart = new Chart(ctxLocations, {
    type: 'bar',
    data: {
      labels: locLabels,
      datasets: [
        {
          label: 'Hlásenia',
          data: topLocations.map((l) => l.sightings),
          backgroundColor: colors.sightingsColor,
          borderRadius: 4
        },
        {
          label: 'Zmienky v správach',
          data: topLocations.map((l) => l.news),
          backgroundColor: colors.newsColor,
          borderRadius: 4
        }
      ]
    },
    options: {
      ...commonOptions,
      indexAxis: 'y', // horizontálny bar chart
      scales: {
        x: { ...commonOptions.scales.x, beginAtZero: true, stacked: true },
        y: { ...commonOptions.scales.y, stacked: true }
      },
      plugins: {
        ...commonOptions.plugins,
        tooltip: { mode: "index", intersect: false }
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
    const report = await fetch(`/api/stats?t=${cacheBust}`, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(`Štatistiky HTTP ${r.status}`);
      return r.json();
    });

    state.report = report;
    state.updatedAt = report.updatedAt || null;
    setUpdated(state.updatedAt);
    setStatus("");

    renderReport(report);
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
