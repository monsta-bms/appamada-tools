export const DEFAULT_RATE_RETRY_MS = 600_000;

export function validRetryDelay(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= Number.MAX_SAFE_INTEGER
    ? Math.ceil(milliseconds) : null;
}

export function rateRetryDelay(value) {
  return Math.max(30_000, validRetryDelay(value) ?? DEFAULT_RATE_RETRY_MS);
}

export function retryAfterHeader(responseHeaders, now) {
  if (typeof responseHeaders !== "string") return null;
  const delays = [];
  for (const line of responseHeaders.split(/\r?\n/)) {
    const match = /^Retry-After\s*:\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const value = match[1];
    if (/^\d+$/.test(value)) {
      const delay = validRetryDelay(Number(value) * 1000);
      if (delay !== null) delays.push(delay);
    } else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
      const date = Date.parse(value);
      if (Number.isFinite(date)) delays.push(Math.max(0, date - now));
    }
  }
  return delays.length ? Math.max(...delays) : null;
}
