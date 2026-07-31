import { readFile } from "node:fs/promises";

for (const file of ["public/admin.html"]) {
  const html = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, source] of scripts) {
    // Parsing only. The function is never invoked and therefore cannot touch
    // browser globals during the repository check.
    Function(source);
  }
}

console.log("Inline script kontrola OK.");
