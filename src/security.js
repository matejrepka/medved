import { createHash, timingSafeEqual } from "node:crypto";
import { isSlovakCoordinate } from "./geo/coordinates.js";

export function secretMatches(expected, supplied) {
  if (typeof expected !== "string" || !expected || typeof supplied !== "string") return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(supplied));
}

export function basicAdminMatches(header, password) {
  if (typeof header !== "string" || header.length > 4096) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return false;
  const credentials = Buffer.from(match[1], "base64").toString("utf8");
  const colon = credentials.indexOf(":");
  return colon !== -1 && credentials.slice(0, colon) === "admin" &&
    secretMatches(password, credentials.slice(colon + 1));
}

// Bounded fixed windows: repeated rejected requests cannot grow an array or
// consume unbounded memory. A full table fails closed for new clients.
export function createAttemptLimiter({ limit, windowMs = 900_000, maxKeys = 10_000, now = Date.now }) {
  const entries = new Map();
  function entry(key) {
    const time = now();
    let value = entries.get(key);
    if (value && value.expiresAt <= time) {
      entries.delete(key);
      value = null;
    }
    if (!value && entries.size >= maxKeys) {
      for (const [candidate, item] of entries) {
        if (item.expiresAt <= time) entries.delete(candidate);
      }
    }
    return { time, value };
  }
  return {
    blocked(key) {
      const { value } = entry(key);
      return value ? value.count >= limit : entries.size >= maxKeys;
    },
    consume(key) {
      const { time, value } = entry(key);
      if (value) {
        if (value.count >= limit) return true;
        value.count += 1;
        return false;
      }
      if (entries.size >= maxKeys) return true;
      entries.set(key, { count: 1, expiresAt: time + windowMs });
      return false;
    },
  };
}

export function clientKey(req) {
  return String(req.ip || req.socket.remoteAddress || "unknown");
}

export function rateLimit(limiter) {
  return (req, res, next) => {
    if (!limiter.consume(clientKey(req))) return next();
    res.set("Retry-After", "900");
    return res.status(429).json({ ok: false, error: "Priveľa pokusov. Skúste to znova o 15 minút." });
  };
}

export function sameOriginMutation(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  let foreign = req.get("sec-fetch-site") === "cross-site";
  if (origin) {
    try {
      const url = new URL(origin);
      foreign ||= !["http:", "https:"].includes(url.protocol) || url.host !== req.get("host");
    } catch {
      foreign = true;
    }
  }
  if (foreign) return res.status(403).json({ ok: false, error: "Cross-origin request denied" });
  return next();
}

export function isEmail(value) {
  return typeof value === "string" && value.length <= 254 &&
    /^[^\s@<>(),:;"\\]+@[^\s@<>(),:;"\\]+\.[^\s@<>(),:;"\\]+$/.test(value);
}

export function validatePublicReport(body, now = Date.now()) {
  const invalid = (error) => ({ error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("Neplatné hlásenie.");
  const { location, description, reporterName, reporterEmail, lat, lng, reportedDate } = body;
  if (typeof location !== "string" || !location.trim() || location.trim().length > 200) {
    return invalid("Zadajte lokalitu v rozsahu 1 až 200 znakov.");
  }
  for (const [value, max] of [[description, 2000], [reporterName, 120], [reporterEmail, 254]]) {
    if (value != null && (typeof value !== "string" || value.length > max)) return invalid("Neplatné alebo príliš dlhé údaje hlásenia.");
  }
  const email = reporterEmail?.trim() || null;
  if (email && !isEmail(email)) return invalid("Zadajte platnú e-mailovú adresu.");
  const missing = (value) => value == null || value === "";
  let latitude = null;
  let longitude = null;
  if (!missing(lat) || !missing(lng)) {
    const numeric = (value) => typeof value === "number" || (typeof value === "string" && value.trim() !== "");
    if (!numeric(lat) || !numeric(lng) || !isSlovakCoordinate(Number(lat), Number(lng))) {
      return invalid("Vyberte platné miesto na Slovensku.");
    }
    latitude = Number(lat);
    longitude = Number(lng);
  }
  let date = new Date(now);
  if (reportedDate != null && reportedDate !== "") {
    if (typeof reportedDate !== "string" || reportedDate.length > 40) return invalid("Neplatný dátum hlásenia.");
    date = new Date(reportedDate);
    if (!Number.isFinite(date.getTime()) || date.getTime() > now + 5 * 60_000 || date.getUTCFullYear() < 2000) {
      return invalid("Zadajte platný dátum pozorovania, ktorý nie je v budúcnosti.");
    }
  }
  return { report: {
    location: location.trim(), description: description?.trim() || null,
    reporterName: reporterName?.trim() || null, reporterEmail: email,
    lat: latitude, lng: longitude, reportedDate: date.toISOString(),
  } };
}
