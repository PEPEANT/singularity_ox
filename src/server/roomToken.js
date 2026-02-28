import { createHmac, timingSafeEqual } from "node:crypto";

function toBase64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value ?? "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createRoomJoinToken(payload, secret) {
  const payloadJson = JSON.stringify(payload ?? {});
  const payloadEncoded = toBase64Url(payloadJson);
  const signature = createHmac("sha256", String(secret ?? ""))
    .update(payloadEncoded)
    .digest();
  const signatureEncoded = toBase64Url(signature);
  return `${payloadEncoded}.${signatureEncoded}`;
}

export function verifyRoomJoinToken(token, secret, now = Date.now()) {
  const raw = String(token ?? "").trim();
  if (!raw) {
    return { ok: false, error: "token missing" };
  }

  const parts = raw.split(".");
  if (parts.length !== 2) {
    return { ok: false, error: "token malformed" };
  }

  const [payloadEncoded, signatureEncoded] = parts;
  const expected = createHmac("sha256", String(secret ?? ""))
    .update(payloadEncoded)
    .digest();
  const provided = fromBase64Url(signatureEncoded);

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, error: "token signature mismatch" };
  }

  const payloadBuffer = fromBase64Url(payloadEncoded);
  const payload = safeJsonParse(payloadBuffer.toString("utf8"));
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "token payload invalid" };
  }

  const exp = Number(payload.exp ?? 0);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: false, error: "token exp missing" };
  }
  if (now > exp) {
    return { ok: false, error: "token expired" };
  }

  return { ok: true, payload };
}

