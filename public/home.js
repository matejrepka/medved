(function () {
  const themeBtn = document.getElementById("themeBtn");

  function syncThemeButton(theme) {
    if (!themeBtn) return;
    themeBtn.innerHTML = `<i class="ph ph-${theme === "dark" ? "sun" : "moon"}" aria-hidden="true"></i>`;
    themeBtn.setAttribute(
      "aria-label",
      theme === "dark" ? "Prepnúť svetlý režim" : "Prepnúť tmavý režim"
    );
  }

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  themeBtn?.addEventListener("click", () => {
    const theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch (error) {}
    syncThemeButton(theme);
  });

  syncThemeButton(currentTheme());

  const form = document.getElementById("notifyForm");
  if (!form) return;

  const typeRadios = form.querySelectorAll('input[name="notifyType"]');
  const areaWrap = document.getElementById("notifyAreaWrap");
  const areaInput = document.getElementById("notifyArea");
  const message = document.getElementById("notifyMessage");
  const button = document.getElementById("notifyBtn");
  const buttonLabel = button.querySelector("span");

  function syncAreaField({ focus = false } = {}) {
    const isArea = form.notifyType.value === "area";
    areaWrap.hidden = !isArea;
    areaInput.required = isArea;
    if (isArea && focus) areaInput.focus();
  }

  function showMessage(text, type = "") {
    message.textContent = text;
    message.className = `form-message${type ? ` ${type}` : ""}`;
  }

  typeRadios.forEach((radio) => {
    radio.addEventListener("change", () => syncAreaField({ focus: true }));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("");

    const email = form.email.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMessage("Zadajte platnú e-mailovú adresu.", "error");
      form.email.focus();
      return;
    }

    const notifyType = form.notifyType.value;
    const areaName = notifyType === "area" ? areaInput.value.trim() : null;
    if (notifyType === "area" && !areaName) {
      showMessage("Zadajte názov oblasti, ktorú chcete sledovať.", "error");
      areaInput.focus();
      return;
    }

    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    buttonLabel.textContent = "Odosielam...";

    try {
      const response = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, notifyType, areaName }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Odber sa nepodarilo uložiť.");
      }

      showMessage("Odber bol uložený. Ďakujeme.", "success");
      form.reset();
      syncAreaField();
    } catch (error) {
      showMessage(error.message || "Odber sa nepodarilo uložiť. Skúste to znova.", "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      buttonLabel.textContent = "Prihlásiť sa na odber";
    }
  });

  syncAreaField();
})();
