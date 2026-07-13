const themeBtn = document.getElementById("themeBtn");

themeBtn?.addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try {
    localStorage.setItem("theme", next);
  } catch {}
  const icon = themeBtn.querySelector("i");
  if (icon) icon.className = next === "dark" ? "ph ph-sun" : "ph ph-moon";
  themeBtn.setAttribute(
    "aria-label",
    next === "dark" ? "Prepnúť svetlý režim" : "Prepnúť tmavý režim"
  );
});

if (themeBtn && document.documentElement.getAttribute("data-theme") === "dark") {
  const icon = themeBtn.querySelector("i");
  if (icon) icon.className = "ph ph-sun";
  themeBtn.setAttribute("aria-label", "Prepnúť svetlý režim");
}
