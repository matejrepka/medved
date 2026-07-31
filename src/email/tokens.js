import crypto from "node:crypto";

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createEmailToken({ subscription, purpose, secret, ttlSeconds = null, now = Date.now() }) {
  if (!subscription?.id || !subscription?.email || !subscription?.confirmation_nonce) {
    throw new Error("Subscription is missing token fields");
  }
  if (!secret || String(secret).length < 32) throw new Error("Newsletter token secret is invalid");
  if (!['confirm', 'unsubscribe'].includes(purpose)) throw new Error("Unsupported email token purpose");

  const body = {
    v: 1,
    p: purpose,
    i: Number(subscription.id),
    e: String(subscription.email).toLowerCase(),
    n: String(subscription.confirmation_nonce),
  };
  if (ttlSeconds) body.x = Math.floor(now / 1000) + Number(ttlSeconds);
  const payload = encode(JSON.stringify(body));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyEmailToken(token, { purpose, secret, now = Date.now() }) {
  const [payload, supplied, extra] = String(token || "").split(".");
  if (!payload || !supplied || extra || !secret) return null;
  const expected = signature(payload, secret);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;

  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      body?.v !== 1 || body?.p !== purpose || !Number.isInteger(body?.i) || body.i < 1 ||
      typeof body?.e !== "string" || typeof body?.n !== "string" || !body.n
    ) return null;
    if (body.x && Math.floor(now / 1000) > body.x) return null;
    return { id: body.i, email: body.e, nonce: body.n };
  } catch {
    return null;
  }
}
