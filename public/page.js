(function () {
  if (window.__kdeJeMedvedShellReady) return;
  window.__kdeJeMedvedShellReady = true;

  const root = document.documentElement;
  const body = document.body;
  const header = document.querySelector(".site-header");
  if (!header) return;

  const primaryLinks = [
    { href: "/", label: "Mapa", icon: "map-trifold" },
    { href: "/domov", label: "Domov", icon: "house" },
    { href: "/stats", label: "Štatistiky", icon: "chart-bar" },
    { href: "/nahlas", label: "Nahlásiť", icon: "map-pin-plus" },
  ];

  const currentPath = window.location.pathname.replace(/\/$/, "") || "/";
  const isCurrent = (href) => currentPath === href;

  function navLink({ href, label, icon }, className = "") {
    const current = isCurrent(href);
    return `<a href="${href}"${className ? ` class="${className}"` : ""}${
      current ? ' aria-current="page"' : ""
    }>
      <i class="ph ph-${icon}" aria-hidden="true"></i>
      <span>${label}</span>
    </a>`;
  }

  let mainNav = header.querySelector(".main-nav");
  if (!mainNav) {
    mainNav = document.createElement("nav");
    mainNav.className = "main-nav";
    mainNav.setAttribute("aria-label", "Hlavné menu");
    const insertionPoint = header.querySelector(".header-actions, .legal-back");
    header.insertBefore(mainNav, insertionPoint || null);
  }
  mainNav.innerHTML = primaryLinks.map((link) => navLink(link)).join("");

  const brand = header.querySelector(".brand");
  if (brand) {
    brand.href = "/domov";
    brand.setAttribute("aria-label", "Kde je Medveď, domov");
  }
  document.querySelectorAll(".footer-identity").forEach((identity) => {
    identity.href = "/domov";
    identity.setAttribute("aria-label", "Kde je Medveď, domov");
  });

  const main = document.querySelector("main");
  if (main && !main.id) main.id = "mainContent";
  if (!document.querySelector(".skip-link")) {
    const skipLink = document.createElement("a");
    skipLink.className = "skip-link";
    skipLink.href = "#mainContent";
    skipLink.textContent = "Preskočiť na obsah";
    body.prepend(skipLink);
  }

  let headerActions = header.querySelector(".header-actions");
  if (!headerActions) {
    headerActions = document.createElement("div");
    headerActions.className = "header-actions";
    header.append(headerActions);
  }

  const menuButton = document.createElement("button");
  menuButton.className = "icon-btn menu-btn";
  menuButton.id = "menuBtn";
  menuButton.type = "button";
  menuButton.setAttribute("aria-label", "Otvoriť menu");
  menuButton.setAttribute("aria-haspopup", "dialog");
  menuButton.setAttribute("aria-controls", "siteMenuDialog");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.innerHTML = '<i class="ph ph-list" aria-hidden="true"></i>';
  headerActions.append(menuButton);

  const drawer = document.createElement("dialog");
  drawer.className = "site-drawer";
  drawer.id = "siteMenuDialog";
  drawer.setAttribute("aria-labelledby", "siteMenuTitle");
  drawer.innerHTML = `
    <div class="site-drawer-panel">
      <div class="site-drawer-heading">
        <div>
          <p>Kde je Medveď</p>
          <h2 id="siteMenuTitle">Menu</h2>
        </div>
        <button class="dialog-close" type="button" data-menu-close aria-label="Zavrieť menu">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>

      <nav class="drawer-nav drawer-nav-primary" aria-label="Hlavné stránky">
        <h3>Hlavné</h3>
        ${primaryLinks.map((link) => navLink(link)).join("")}
      </nav>

      <nav class="drawer-nav" aria-label="Informácie">
        <h3>Informácie</h3>
        ${navLink({ href: "/bezpecnost", label: "Bezpečnosť", icon: "shield-check" })}
        ${navLink({ href: "/o-mape", label: "O mape", icon: "info" })}
        ${navLink({ href: "/spomenuli-nas", label: "Spomenuli nás", icon: "newspaper" })}
      </nav>

      <div class="drawer-settings">
        <h3>Nastavenia</h3>
        <button type="button" id="drawerThemeBtn">
          <i class="ph ph-moon" aria-hidden="true"></i>
          <span>Prepnúť tmavý režim</span>
        </button>
      </div>

      <nav class="drawer-nav drawer-nav-legal" aria-label="Právne informácie">
        <h3>Právne</h3>
        ${navLink({ href: "/privacy", label: "Ochrana súkromia", icon: "lock-key" })}
        ${navLink({ href: "/terms", label: "Podmienky používania", icon: "file-text" })}
      </nav>
    </div>`;
  body.append(drawer);

  const proxyThemeButton = document.getElementById("themeBtn");
  const drawerThemeButton = document.getElementById("drawerThemeBtn");

  function currentTheme() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function syncThemeControls(theme) {
    const isDark = theme === "dark";
    const iconName = isDark ? "sun" : "moon";
    const label = isDark ? "Prepnúť svetlý režim" : "Prepnúť tmavý režim";

    if (proxyThemeButton) {
      proxyThemeButton.setAttribute("aria-label", label);
      const proxyIcon = proxyThemeButton.querySelector("i");
      if (proxyIcon) proxyIcon.className = `ph ph-${iconName}`;
    }
    drawerThemeButton.setAttribute("aria-label", label);
    drawerThemeButton.querySelector("i").className = `ph ph-${iconName}`;
    drawerThemeButton.querySelector("span").textContent = label;
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {}
    syncThemeControls(theme);
    window.dispatchEvent(new CustomEvent("site:themechange", { detail: { theme } }));
  }

  drawerThemeButton.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  });
  syncThemeControls(currentTheme());

  function openDrawer() {
    menuButton.setAttribute("aria-expanded", "true");
    root.classList.add("dialog-open");
    if (typeof drawer.showModal === "function") drawer.showModal();
    else drawer.setAttribute("open", "");
    requestAnimationFrame(() => drawer.querySelector("[data-menu-close]")?.focus());
  }

  function closeDrawer() {
    if (drawer.open && typeof drawer.close === "function") drawer.close();
    else drawer.removeAttribute("open");
  }

  menuButton.addEventListener("click", openDrawer);
  drawer.querySelector("[data-menu-close]").addEventListener("click", closeDrawer);
  drawer.addEventListener("click", (event) => {
    if (event.target === drawer) closeDrawer();
  });
  drawer.addEventListener("close", () => {
    root.classList.remove("dialog-open");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.focus();
  });
  drawer.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeDrawer));

  root.classList.add("site-shell-ready");
})();
