(function () {
  "use strict";

  // Retire the former analytics preference. Hosting diagnostics run on the server
  // and do not require an analytics loader or a browser consent preference.
  try {
    localStorage.removeItem("privacyConsent");
  } catch (_err) {
    // The page also works when browser storage is unavailable.
  }
})();
