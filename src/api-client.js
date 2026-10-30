import { DEFAULT_RATE_RETRY_MS, retryAfterHeader, validRetryDelay } from "./retry-policy.js";

export const API_CLIENT_ERRORS = Object.freeze({
  API_NETWORK_ERROR: "API_NETWORK_ERROR",
  API_TIMEOUT: "API_TIMEOUT",
  API_INVALID_RESPONSE: "API_INVALID_RESPONSE",
  API_NOT_CONFIGURED: "API_NOT_CONFIGURED",
});

const MD5_PATTERN = /^[0-9a-f]{32}$/i;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function matchesRequestId(actual, expected) {
  return actual === expected || (typeof actual === "string" && typeof expected === "string" &&
    REQUEST_ID_PATTERN.test(actual) && REQUEST_ID_PATTERN.test(expected) && actual.toLowerCase() === expected.toLowerCase());
}
const LOCK_RETRY_RANGES = Object.freeze([
  [300, 500],
  [900, 1200],
  [1800, 2400],
]);

export class ApiClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ApiClientError";
    this.code = code;
  }
}

function validateApiUrl(apiUrl) {
  if (!apiUrl) {
    throw new ApiClientError(API_CLIENT_ERRORS.API_NOT_CONFIGURED, "API URL is not configured");
  }

  try {
    const url = new URL(apiUrl);
    if (
      url.protocol !== "https:" || url.username || url.password ||
      !((url.hostname === "script.google.com" && /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname)) ||
        (/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) && url.pathname === "/api")) ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid URL");
    }
    return url.toString();
  } catch (error) {
    throw new ApiClientError(API_CLIENT_ERRORS.API_NOT_CONFIGURED, "API URL is invalid", {
      cause: error,
    });
  }
}

function parseApiResponse(response, now) {
  const status = Number(response?.status ?? 0);
  const successfulHttp = status >= 200 && status < 300;
  const text = String(response?.responseText ?? response?.response ?? "");
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* HTTP 429 can also contain HTML. */ }
  const headerDelay = retryAfterHeader(response?.responseHeaders, now);
  const errorResponse = parsed?.ok === false && parsed.error &&
    typeof parsed.error.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.error.code);
  if (status === 429 || errorResponse) {
    const code = status === 429 ? "RATE_LIMITED" : parsed.error.code;
    const bodyDelay = errorResponse ? validRetryDelay(parsed.error.retry_after_ms) : null;
    const delays = [bodyDelay, headerDelay].filter(value => value !== null);
    const retryDelay = delays.length ? Math.max(...delays) : code === "RATE_LIMITED" ? DEFAULT_RATE_RETRY_MS : null;
    return { ...(errorResponse ? parsed : {}), ok: false, error: {
      ...(errorResponse ? parsed.error : {}), code,
      ...(retryDelay === null ? {} : { retry_after_ms: retryDelay }),
    } };
  }
  // A success body on an unsuccessful transport is not an acknowledgement.
  if (!successfulHttp) throw new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, `API returned HTTP ${status}`);
  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
    throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API response shape is invalid");
  }
  if (!parsed.ok && (!parsed.error || typeof parsed.error.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.error.code))) {
    throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API error shape is invalid");
  }
  return parsed;
}

function gmRequestAsPromise(gmRequest, details) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    }
    // Some extension/browser failures never call ontimeout. Bound the wait locally too.
    const timer = setTimeout(() => {
      finish(reject, new ApiClientError(API_CLIENT_ERRORS.API_TIMEOUT, "API request timed out"));
      try { request?.abort?.(); } catch { /* already timed out */ }
    }, details.timeout);
    try {
      request = gmRequest({
        ...details,
        anonymous: true,
        responseType: "text",
        onload(response) { finish(resolve, response); },
        onerror() {
          finish(reject,
            new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, "API request failed"),
          );
        },
        ontimeout() {
          finish(reject, new ApiClientError(API_CLIENT_ERRORS.API_TIMEOUT, "API request timed out"));
        },
      });
    } catch (error) {
      finish(reject,
        new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, "API request could not start", {
          cause: error,
        }),
      );
    }
  });
}

function jitteredDelay([minimum, maximum], random) {
  return Math.floor(minimum + random() * (maximum - minimum + 1));
}

export function createApiClient({
  apiUrl,
  gmRequest,
  timeoutMs = 15_000,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random = Math.random,
} = {}) {
  if (typeof gmRequest !== "function") {
    throw new TypeError("gmRequest must be a function");
  }

  const configuredUrl = validateApiUrl(apiUrl);
  const lookupCache = new Map();
  const lookupInFlight = new Map();
  let submitPause;

  async function requestJson(details) {
    return parseApiResponse(
      await gmRequestAsPromise(gmRequest, {
        timeout: timeoutMs,
        ...details,
      }), now(),
    );
  }

  async function lookup(md5) {
    const normalizedMd5 = String(md5 ?? "").toLowerCase();
    if (!MD5_PATTERN.test(normalizedMd5)) {
      throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "lookup MD5 is invalid");
    }

    const cached = lookupCache.get(normalizedMd5);
    if (cached && cached.expiresAt > now()) {
      return cached.value;
    }
    if (lookupInFlight.has(normalizedMd5)) {
      return lookupInFlight.get(normalizedMd5);
    }

    const requestUrl = new URL(configuredUrl);
    requestUrl.searchParams.set("action", "lookup");
    requestUrl.searchParams.set("md5", normalizedMd5);

    const request = requestJson({ method: "GET", url: requestUrl.toString() })
      .then((result) => {
        if (result.ok && typeof result.exists !== "boolean") {
          throw new ApiClientError(
            API_CLIENT_ERRORS.API_INVALID_RESPONSE,
            "lookup response shape is invalid",
          );
        }
        if (
          result.ok &&
          result.exists &&
          (!result.chart ||
            typeof result.chart.title !== "string" ||
            typeof result.chart.artist !== "string" ||
            typeof result.chart.current_level !== "string")
        ) {
          throw new ApiClientError(
            API_CLIENT_ERRORS.API_INVALID_RESPONSE,
            "lookup chart shape is invalid",
          );
        }
        if (result.ok) {
          lookupCache.set(normalizedMd5, {
            value: result,
            expiresAt: now() + (result.exists ? 120_000 : 30_000),
          });
        }
        return result;
      })
      .finally(() => lookupInFlight.delete(normalizedMd5));

    lookupInFlight.set(normalizedMd5, request);
    return request;
  }

  async function submit(payload) {
    if (submitPause?.until > now()) return { ...submitPause.result, request_id: payload?.request_id,
      error: { ...submitPause.result.error, retry_after_ms: submitPause.until - now() } };
    for (let attempt = 0; ; attempt += 1) {
      const result = await requestJson({
        method: "POST",
        url: configuredUrl,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        data: JSON.stringify(payload),
      });

      if (
        result.ok &&
        (typeof result.request_id !== "string" || !matchesRequestId(result.request_id, payload?.request_id) || typeof result.deduplicated !== "boolean")
      ) {
        throw new ApiClientError(
          API_CLIENT_ERRORS.API_INVALID_RESPONSE,
          "submit response shape is invalid",
        );
      }

      const isLockTimeout = !result.ok && result.error?.code === "LOCK_TIMEOUT";
      const serverDelay = result.ok ? null : validRetryDelay(result.error.retry_after_ms);
      if (serverDelay !== null && serverDelay > 0) {
        const until = Math.min(Number.MAX_SAFE_INTEGER, now() + serverDelay);
        if (!submitPause || until > submitPause.until) submitPause = { until, result };
      }
      // Long instructions belong in the durable outbox instead of an extended
      // in-memory sleep with an expiring sending lease.
      if (isLockTimeout && serverDelay >= 30_000) return result;
      if (!isLockTimeout || attempt >= LOCK_RETRY_RANGES.length) {
        return result;
      }
      await sleep(Math.max(jitteredDelay(LOCK_RETRY_RANGES[attempt], random),
        validRetryDelay(result.error.retry_after_ms) ?? 0));
    }
  }

  return Object.freeze({ lookup, submit });
}
