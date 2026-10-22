import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 32768;
const MAX_RESPONSE_BYTES = 65536;
const WINDOW_MS = 600000;
const ORIGINS = new Set(["https://bms-ir.org", "https://www.bms-ir.org"]);

function apiError(code, message, retryAfterMs) {
  return { ok: false, request_id: "", error: {
    code, message, retryable: false,
    ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
  } };
}

function response(body, origin = "", status = 200) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", Vary: "Origin" };
  if (ORIGINS.has(origin)) Object.assign(headers, {
    "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedText(body, maximum, sizeError = "BODY_TOO_LARGE") {
  if (!body) return "";
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error(sizeError);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// Each source has its own durable actor. Raw IPs and claimed player names/IDs
// are neither stored here nor used to select a different quota.
export class SourceRateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, bucket INTEGER NOT NULL, count INTEGER NOT NULL)");
  }

  consume(kind, md5 = "") {
    const now = Date.now();
    const bucket = Math.floor(now / WINDOW_MS);
    const rules = kind === "submit" ? [["submit", 60], ["md5:" + md5, 10]] : [["lookup", 180]];
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM counters WHERE bucket < ?", bucket);
      for (const [key, limit] of rules) {
        const rows = this.ctx.storage.sql.exec("SELECT count FROM counters WHERE key = ? AND bucket = ?", key, bucket).toArray();
        if ((rows[0]?.count || 0) >= limit) return { allowed: false, retryAfterMs: WINDOW_MS - now % WINDOW_MS };
      }
      for (const [key] of rules) this.ctx.storage.sql.exec(
        "INSERT INTO counters (key, bucket, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket, count=counters.count+1", key, bucket);
      return { allowed: true };
    });
  }
}

function gasUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "script.google.com" || url.username || url.password ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) || url.search || url.hash) throw new Error("CONFIG");
  return url;
}

async function upstream(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    let options = { ...init, redirect: "manual", signal: controller.signal };
    for (let redirect = 0; redirect <= 3; redirect++) {
      const result = await fetch(url.toString(), options);
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers.get("Location");
        if (!location || redirect === 3) throw new Error("UPSTREAM_REDIRECT");
        const next = new URL(location, url);
        if (next.protocol !== "https:" || next.username || next.password ||
            !["script.google.com", "script.googleusercontent.com"].includes(next.hostname)) throw new Error("UPSTREAM_REDIRECT");
        await result.body?.cancel();
        if (result.status === 303 || ((result.status === 301 || result.status === 302) && options.method === "POST")) {
          options = { method: "GET", redirect: "manual", signal: controller.signal };
        }
        url = next;
        continue;
      }
      if (!result.ok) { await result.body?.cancel(); throw new Error("UPSTREAM_STATUS"); }
      const parsed = JSON.parse(await boundedText(result.body, MAX_RESPONSE_BYTES, "UPSTREAM_TOO_LARGE"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean" ||
          (!parsed.ok && typeof parsed.error?.code !== "string")) throw new Error("UPSTREAM_JSON");
      return parsed;
    }
    throw new Error("UPSTREAM_REDIRECT");
  } finally { clearTimeout(timer); }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (origin && !ORIGINS.has(origin)) return response(apiError("ORIGIN_NOT_ALLOWED", "Origin is not allowed"), "", 403);
    const url = new URL(request.url);
    if (url.pathname !== "/api") return response(apiError("NOT_FOUND", "API not found"), origin, 404);
    if (request.method === "OPTIONS") return response(null, origin, 204);
    if (!["GET", "POST"].includes(request.method)) return response(apiError("METHOD_NOT_ALLOWED", "Method is not allowed"), origin, 405);
    let target;
    try {
      target = gasUrl(env.GAS_API_URL);
      if (typeof env.GATEWAY_SHARED_SECRET !== "string" || env.GATEWAY_SHARED_SECRET.length < 32 || !env.SOURCE_LIMITER) throw new Error("CONFIG");
    } catch { return response(apiError("GATEWAY_NOT_CONFIGURED", "Submission gateway is not configured"), origin, 503); }
    // Cloudflare overwrites this header on public ingress. Never trust X-Forwarded-For
    // or a caller-supplied source hash. Local tests use only dummy addresses.
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) return response(apiError("GATEWAY_SOURCE_REQUIRED", "Submission source is unavailable"), origin, 503);
    try {
      const sourceHash = await hmac(env.GATEWAY_SHARED_SECRET, "appamada-source-v1\n" + ip);
      let payload;
      let body;
      if (request.method === "GET") {
        if ([...url.searchParams.keys()].sort().join(",") !== "action,md5" || url.searchParams.get("action") !== "lookup" ||
            !/^[0-9a-f]{32}$/i.test(url.searchParams.get("md5") || "")) return response(apiError("BAD_REQUEST", "Lookup parameters are invalid"), origin);
      } else {
        // Even requests with invalid JSON consume the source attempt budget.
        body = await boundedText(request.body, MAX_BODY_BYTES);
        try { payload = JSON.parse(body); } catch { payload = null; }
      }
      const md5 = typeof payload?.md5 === "string" && /^[0-9a-f]{32}$/i.test(payload.md5) ? payload.md5.toLowerCase() : "invalid";
      const limit = await env.SOURCE_LIMITER.getByName(sourceHash).consume(request.method === "POST" ? "submit" : "lookup", md5);
      if (!limit.allowed) return response(apiError("RATE_LIMITED", "Submission rate limit exceeded", limit.retryAfterMs), origin);
      if (request.method === "GET") {
        target.search = url.search;
        return response(await upstream(target, { method: "GET" }), origin);
      }
      if (url.search || !payload || typeof payload !== "object" || Array.isArray(payload)) return response(apiError("BAD_REQUEST", "POST body must be a JSON object"), origin);
      const issuedAt = Date.now();
      const signature = await hmac(env.GATEWAY_SHARED_SECRET, "appamada-gateway-v1\n" + issuedAt + "\n" + sourceHash + "\n" + body);
      const envelope = { gateway_version: 1, issued_at: issuedAt, source_hash: sourceHash, payload: body, signature };
      return response(await upstream(target, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(envelope),
      }), origin);
    } catch (error) {
      if (error.message === "BODY_TOO_LARGE") return response(apiError("BAD_REQUEST", "Request body is too large"), origin);
      console.error("[submission-gateway] request failed", { stage: "forward", code: "GATEWAY_UNAVAILABLE" });
      return response(apiError("GATEWAY_UNAVAILABLE", "Submission gateway is temporarily unavailable"), origin, 503);
    }
  },
};
