export async function fetchJsonPagesViaBrowser() {
  throw new Error("Chromium scraping runs in the GitHub Actions refresh job, not inside Workers");
}
