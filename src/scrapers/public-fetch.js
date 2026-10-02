import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16]]) {
  blocked.addSubnet(address, prefix, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
  return false;
}

export async function publicTarget(value, lookup = dnsLookup) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))) {
    throw new Error("Article URL is not a public HTTP endpoint");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  // Reject mixed public/private answers as well as literal and encoded IPs.
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Article URL resolves to a non-public address");
  }
  const pinned = addresses.find(({ family }) => family === 4) || addresses[0];
  return { url, pinned };
}

function requestTarget({ url, pinned }, options) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: options.method, headers: options.headers, signal: options.signal,
      agent: false,
      // Use the validated address for the connection; a second DNS lookup must
      // not let a rebinding host move the request onto a private network.
      lookup(_host, settings, callback) {
        if (settings.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, resolve);
    request.on("error", reject);
    request.end(options.body);
  });
}

async function boundedBody(response, maxBytes) {
  let rawBytes = 0;
  response.on("data", (chunk) => {
    rawBytes += chunk.length;
    if (rawBytes > maxBytes) response.destroy(new Error("Article response is too large"));
  });
  const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() :
    encoding === "br" ? createBrotliDecompress() : null;
  const stream = decoder ? response.pipe(decoder) : response;
  if (decoder) response.on("error", error => decoder.destroy(error));
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("Article response is too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    response.destroy();
  }
}

// Only public, pinned HTTP targets, including every redirect hop. Both wire
// bytes and decompressed bytes are bounded before HTML parsing starts.
export async function fetchPublicArticle(value, {
  signal = AbortSignal.timeout(12_000), headers = {}, method = "GET", body,
  maxBytes = 2 * 1024 * 1024, maxRedirects = 5,
  lookup = dnsLookup, request = requestTarget,
} = {}) {
  let target = value;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    signal.throwIfAborted();
    const resolved = await publicTarget(target, lookup);
    signal.throwIfAborted();
    const response = await request(resolved, { signal, headers: { "Accept-Encoding": "identity", ...headers }, method, body });
    const status = response.statusCode;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.destroy();
      target = new URL(response.headers.location, resolved.url).href;
      if (status === 303 || ([301, 302].includes(status) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    const content = await boundedBody(response, maxBytes);
    const resultHeaders = new Headers();
    for (const [name, values] of Object.entries(response.headers)) {
      if (values != null && !["content-encoding", "content-length", "transfer-encoding"].includes(name)) {
        resultHeaders.set(name, Array.isArray(values) ? values.join(", ") : values);
      }
    }
    return new Response([204, 205, 304].includes(status) ? null : content, { status, headers: resultHeaders });
  }
  throw new Error("Too many article redirects");
}
