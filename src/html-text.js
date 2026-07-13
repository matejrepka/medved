const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

export function decodeHtmlEntities(value) {
  let decoded = String(value ?? "");

  // Dva prechody pokryjú aj hodnoty, ktoré WordPress zakódoval viackrát,
  // napr. &amp;#8230;.
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded
      .replace(/&([a-z][a-z0-9]+);/giu, (entity, name) => {
        const replacement = NAMED_ENTITIES[name.toLowerCase()];
        return replacement === undefined ? entity : replacement;
      })
      .replace(/&#(x[0-9a-f]+|[0-9]+);/giu, (entity, rawCodePoint) => {
        const hexadecimal = rawCodePoint[0].toLowerCase() === "x";
        const codePoint = Number.parseInt(hexadecimal ? rawCodePoint.slice(1) : rawCodePoint, hexadecimal ? 16 : 10);
        const valid =
          Number.isInteger(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff);
        return valid ? String.fromCodePoint(codePoint) : entity;
      });

    if (next === decoded) break;
    decoded = next;
  }

  return decoded;
}

export function htmlToText(value) {
  if (!value) return "";
  return decodeHtmlEntities(String(value).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
