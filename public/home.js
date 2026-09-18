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

  async function sendFeedback(payload) {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Odoslanie sa nepodarilo. Skúste to prosím znova.");
    }
    return data;
  }

  const pollForm = document.getElementById("newsletterPollForm");
  const pollStatus = document.getElementById("newsletterPollStatus");
  const pollStorageKey = "newsletter-poll-vote-2026";

  function setPollComplete(message) {
    pollForm?.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    if (pollStatus) pollStatus.textContent = message;
  }

  try {
    if (localStorage.getItem(pollStorageKey)) {
      setPollComplete("Ďakujeme, váš hlas už máme.");
    }
  } catch (error) {}

  pollForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    const choice = submitter?.value;
    if (!choice) return;

    const buttons = pollForm.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    submitter.setAttribute("aria-busy", "true");
    if (pollStatus) pollStatus.textContent = "Odosielam váš hlas…";

    try {
      const data = await sendFeedback({ kind: "newsletter_poll", choice });
      try { localStorage.setItem(pollStorageKey, choice); } catch (error) {}
      setPollComplete(data.message || "Ďakujeme za váš hlas.");
    } catch (error) {
      buttons.forEach((button) => { button.disabled = false; });
      if (pollStatus) pollStatus.textContent = error.message;
    } finally {
      submitter.removeAttribute("aria-busy");
    }
  });

  const feedbackToggle = document.getElementById("feedbackToggle");
  const feedbackPanel = document.getElementById("feedbackPanel");
  const feedbackClose = document.getElementById("feedbackClose");
  const feedbackForm = document.getElementById("feedbackForm");
  const feedbackMessage = document.getElementById("feedbackMessage");
  const feedbackEmail = document.getElementById("feedbackEmail");
  const feedbackStatus = document.getElementById("feedbackStatus");
  const feedbackSubmit = document.getElementById("feedbackSubmit");
  const feedbackSubmitLabel = feedbackSubmit?.querySelector("span");

  function setFeedbackOpen(open, { restoreFocus = false } = {}) {
    if (!feedbackPanel || !feedbackToggle) return;
    feedbackPanel.hidden = !open;
    feedbackToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      requestAnimationFrame(() => feedbackMessage?.focus());
    } else if (restoreFocus) {
      feedbackToggle.focus();
    }
  }

  feedbackToggle?.addEventListener("click", () => {
    setFeedbackOpen(Boolean(feedbackPanel?.hidden));
  });
  feedbackClose?.addEventListener("click", () => setFeedbackOpen(false, { restoreFocus: true }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && feedbackPanel && !feedbackPanel.hidden) {
      setFeedbackOpen(false, { restoreFocus: true });
    }
  });

  feedbackForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = feedbackMessage.value.trim();
    const email = feedbackEmail.value.trim();
    feedbackStatus.textContent = "";
    feedbackStatus.className = "form-message feedback-status";

    if (message.length < 3) {
      feedbackStatus.textContent = "Napíšte prosím aspoň krátku správu.";
      feedbackStatus.classList.add("error");
      feedbackMessage.focus();
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      feedbackStatus.textContent = "E-mail nie je platný. Opravte ho alebo pole nechajte prázdne.";
      feedbackStatus.classList.add("error");
      feedbackEmail.focus();
      return;
    }

    feedbackSubmit.disabled = true;
    feedbackSubmit.setAttribute("aria-busy", "true");
    feedbackSubmitLabel.textContent = "Odosielam…";

    try {
      const data = await sendFeedback({
        kind: "message",
        message,
        email: email || null,
        website: feedbackForm.website.value,
      });
      feedbackForm.reset();
      feedbackStatus.textContent = data.message || "Ďakujeme. Vaša správa bola odoslaná.";
      feedbackStatus.classList.add("success");
    } catch (error) {
      feedbackStatus.textContent = error.message;
      feedbackStatus.classList.add("error");
    } finally {
      feedbackSubmit.disabled = false;
      feedbackSubmit.removeAttribute("aria-busy");
      feedbackSubmitLabel.textContent = "Odoslať správu";
    }
  });
})();
