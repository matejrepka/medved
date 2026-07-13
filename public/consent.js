(function () {
  "use strict";

  const STORAGE_KEY = "privacyConsent";
  const CONSENT_VERSION = 1;
  let analyticsLoaded = false;

  function readConsent() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return value && value.version === CONSENT_VERSION ? value : null;
    } catch (_err) {
      return null;
    }
  }

  function saveConsent(analytics) {
    const value = {
      version: CONSENT_VERSION,
      analytics: Boolean(analytics),
      savedAt: new Date().toISOString(),
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (_err) {
      // Ak je lokálne úložisko blokované, voľba platí aspoň počas tejto návštevy.
    }

    return value;
  }

  async function loadAnalytics() {
    if (analyticsLoaded) return;
    analyticsLoaded = true;

    try {
      const { inject } = await import("/vendor/analytics/index.mjs");
      inject();
    } catch (err) {
      analyticsLoaded = false;
      console.warn("Vercel Analytics sa nepodarilo načítať:", err);
    }
  }

  function createBanner() {
    const banner = document.createElement("section");
    banner.id = "privacyBanner";
    banner.className = "privacy-banner";
    banner.hidden = true;
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-labelledby", "privacyBannerTitle");
    banner.setAttribute("aria-describedby", "privacyBannerText");
    banner.innerHTML = `
      <div class="privacy-banner__inner">
        <div class="privacy-banner__copy">
          <h2 id="privacyBannerTitle">Nastavenie súkromia</h2>
          <p id="privacyBannerText">
            Nevyhnutné lokálne úložisko používame na zapamätanie vašich nastavení.
            S vaším súhlasom zapneme aj anonymnú návštevnostnú analytiku Vercel.
            <a href="/privacy#cookies">Viac informácií</a>
          </p>
        </div>
        <div class="privacy-banner__actions">
          <button type="button" class="privacy-choice privacy-choice--secondary" data-consent="necessary">
            Len nevyhnutné
          </button>
          <button type="button" class="privacy-choice privacy-choice--primary" data-consent="analytics">
            Súhlasím s analytikou
          </button>
        </div>
      </div>`;

    banner.addEventListener("click", (event) => {
      const button = event.target.closest("[data-consent]");
      if (!button) return;

      const allowAnalytics = button.dataset.consent === "analytics";
      saveConsent(allowAnalytics);
      banner.hidden = true;
      if (allowAnalytics) {
        loadAnalytics();
      } else if (analyticsLoaded) {
        // Už vložený analytický skript nemožno spoľahlivo odobrať; obnovenie stránky
        // okamžite uplatní novú voľbu bez ďalšieho načítania analytiky.
        location.reload();
      }
    });

    document.body.appendChild(banner);
    return banner;
  }

  function addSettingsLink() {
    const footerLinks = document.querySelector(".footer-links");
    if (!footerLinks || footerLinks.querySelector("[data-open-privacy-settings]")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "footer-privacy-button";
    button.dataset.openPrivacySettings = "";
    button.textContent = "Nastavenie súkromia";
    footerLinks.appendChild(button);
  }

  function init() {
    const banner = createBanner();
    addSettingsLink();

    document.addEventListener("click", (event) => {
      if (!event.target.closest("[data-open-privacy-settings]")) return;
      banner.hidden = false;
      banner.querySelector("[data-consent='necessary']")?.focus();
    });

    const consent = readConsent();
    if (!consent) {
      banner.hidden = false;
    } else if (consent.analytics) {
      loadAnalytics();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
