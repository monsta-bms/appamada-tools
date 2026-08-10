export const API_CLIENT_ERRORS = Object.freeze({
  API_NETWORK_ERROR: "API_NETWORK_ERROR",
  API_TIMEOUT: "API_TIMEOUT",
  API_INVALID_RESPONSE: "API_INVALID_RESPONSE",
  API_NOT_CONFIGURED: "API_NOT_CONFIGURED",
});

const MD5_PATTERN = /^[0-9a-f]{32}$/i;
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
      url.protocol !== "https:" ||
      url.hostname !== "script.google.com" ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) ||
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

function parseApiResponse(response) {
  const status = Number(response?.status ?? 0);
  if (status < 200 || status >= 300) {
    throw new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, `API returned HTTP ${status}`);
  }

  const text = String(response?.responseText ?? response?.response ?? "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API returned invalid JSON", {
      cause: error,
    });
  }

  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
    throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API response shape is invalid");
  }
  if (!parsed.ok && (!parsed.error || typeof parsed.error.code !== "string")) {
    throw new ApiClientError(API_CLIENT_ERRORS.API_INVALID_RESPONSE, "API error shape is invalid");
  }
  return parsed;
}

function gmRequestAsPromise(gmRequest, details) {
  return new Promise((resolve, reject) => {
    try {
      gmRequest({
        ...details,
        anonymous: true,
        responseType: "text",
        onload: resolve,
        onerror() {
          reject(
            new ApiClientError(API_CLIENT_ERRORS.API_NETWORK_ERROR, "API request failed"),
          );
        },
        ontimeout() {
          reject(new ApiClientError(API_CLIENT_ERRORS.API_TIMEOUT, "API request timed out"));
        },
      });
    } catch (error) {
      reject(
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

  async function requestJson(details) {
    return parseApiResponse(
      await gmRequestAsPromise(gmRequest, {
        timeout: timeoutMs,
        ...details,
      }),
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
    for (let attempt = 0; ; attempt += 1) {
      const result = await requestJson({
        method: "POST",
        url: configuredUrl,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        data: JSON.stringify(payload),
      });

      if (
        result.ok &&
        (typeof result.request_id !== "string" || typeof result.deduplicated !== "boolean")
      ) {
        throw new ApiClientError(
          API_CLIENT_ERRORS.API_INVALID_RESPONSE,
          "submit response shape is invalid",
        );
      }

      const isLockTimeout = !result.ok && result.error?.code === "LOCK_TIMEOUT";
      if (!isLockTimeout || attempt >= LOCK_RETRY_RANGES.length) {
        return result;
      }
      await sleep(jitteredDelay(LOCK_RETRY_RANGES[attempt], random));
    }
  }

  return Object.freeze({ lookup, submit });
}
