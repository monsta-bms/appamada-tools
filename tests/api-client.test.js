import assert from "node:assert/strict";
import test from "node:test";

import {
  API_CLIENT_ERRORS,
  ApiClientError,
  createApiClient,
} from "../src/api-client.js";

const API_URL = "https://script.google.com/macros/s/test-deployment/exec";
const MD5 = "b89279d026c9d40d0f5eedde2e25b920";

function gmSequence(sequence, calls = []) {
  return (details) => {
    calls.push(details);
    const next = sequence.shift();
    queueMicrotask(() => {
      if (next.type === "load") details.onload(next.response);
      else if (next.type === "timeout") details.ontimeout();
      else details.onerror();
    });
  };
}

function loaded(body, overrides = {}) {
  return {
    type: "load",
    response: { status: 200, responseText: JSON.stringify(body), ...overrides },
  };
}

test("lookup returns an existing chart with anonymous text-mode GET", async () => {
  const calls = [];
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([
      loaded({
        ok: true,
        exists: true,
        chart: { title: "Title", artist: "Artist", current_level: "10" },
      }),
    ], calls),
  });
  const result = await client.lookup(MD5);
  assert.equal(result.exists, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].anonymous, true);
  assert.equal(calls[0].responseType, "text");
  assert.equal(calls[0].timeout, 15_000);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("action"), "lookup");
  assert.equal(url.searchParams.get("md5"), MD5);
});

test("lookup returns a missing chart and caches the response", async () => {
  const calls = [];
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([loaded({ ok: true, exists: false })], calls),
  });
  assert.deepEqual(await client.lookup(MD5), { ok: true, exists: false });
  assert.deepEqual(await client.lookup(MD5), { ok: true, exists: false });
  assert.equal(calls.length, 1);
});

test("simultaneous lookup requests are coalesced", async () => {
  const calls = [];
  let release;
  const gmRequest = (details) => {
    calls.push(details);
    release = () => details.onload({ status: 200, responseText: '{"ok":true,"exists":false}' });
  };
  const client = createApiClient({ apiUrl: API_URL, gmRequest });
  const first = client.lookup(MD5);
  const second = client.lookup(MD5);
  assert.equal(calls.length, 1);
  release();
  assert.deepEqual(await first, await second);
});

test("API error JSON is returned without transport conversion", async () => {
  const calls = [];
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([
      loaded({ ok: false, error: { code: "CHART_DUPLICATED" } }),
      loaded({ ok: true, exists: false }),
    ], calls),
  });
  assert.equal((await client.lookup(MD5)).error.code, "CHART_DUPLICATED");
  assert.equal((await client.lookup(MD5)).exists, false);
  assert.equal(calls.length, 2);
});

test("network errors are classified", async () => {
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([{ type: "error" }]),
  });
  await assert.rejects(client.lookup(MD5), (error) => {
    assert.equal(error.code, API_CLIENT_ERRORS.API_NETWORK_ERROR);
    return true;
  });
});

test("timeouts are classified", async () => {
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([{ type: "timeout" }]),
  });
  await assert.rejects(client.lookup(MD5), (error) => {
    assert.equal(error.code, API_CLIENT_ERRORS.API_TIMEOUT);
    return true;
  });
});

test("invalid JSON and invalid shapes are classified", async () => {
  for (const responseText of ["not-json", '{"exists":false}', "null"]) {
    const client = createApiClient({
      apiUrl: API_URL,
      gmRequest: gmSequence([{ type: "load", response: { status: 200, responseText } }]),
    });
    await assert.rejects(client.lookup(MD5), (error) => {
      assert.equal(error.code, API_CLIENT_ERRORS.API_INVALID_RESPONSE);
      return true;
    });
  }
});

test("successful lookup responses require a complete chart", async () => {
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([loaded({ ok: true, exists: true })]),
  });
  await assert.rejects(client.lookup(MD5), (error) => {
    assert.equal(error.code, API_CLIENT_ERRORS.API_INVALID_RESPONSE);
    return true;
  });
});

test("successful submit responses require a deduplication flag", async () => {
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([loaded({ ok: true, request_id: "same-request" })]),
  });
  await assert.rejects(client.submit({ request_id: "same-request" }), (error) => {
    assert.equal(error.code, API_CLIENT_ERRORS.API_INVALID_RESPONSE);
    return true;
  });
});

test("Google ContentService redirect final URLs are accepted", async () => {
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([
      loaded(
        { ok: true, exists: false },
        { finalUrl: "https://script.googleusercontent.com/macros/echo?user_content_key=test" },
      ),
    ]),
  });
  assert.equal((await client.lookup(MD5)).ok, true);
});

test("LOCK_TIMEOUT retries with the same payload and succeeds", async () => {
  const calls = [];
  const waits = [];
  const payload = { request_id: "same-request" };
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([
      loaded({ ok: false, error: { code: "LOCK_TIMEOUT", retryable: true } }),
      loaded({ ok: false, error: { code: "LOCK_TIMEOUT", retryable: true } }),
      loaded({ ok: true, request_id: "same-request", deduplicated: false }),
    ], calls),
    sleep: async (milliseconds) => waits.push(milliseconds),
    random: () => 0,
  });
  const result = await client.submit(payload);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [300, 900]);
  assert.deepEqual(calls.map((call) => JSON.parse(call.data)), [payload, payload, payload]);
  assert.equal(calls[0].headers["Content-Type"], "text/plain;charset=UTF-8");
});

test("LOCK_TIMEOUT stops after three retries", async () => {
  const calls = [];
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence(
      Array.from({ length: 4 }, () =>
        loaded({ ok: false, error: { code: "LOCK_TIMEOUT", retryable: true } }),
      ),
      calls,
    ),
    sleep: async () => {},
  });
  const result = await client.submit({ request_id: "same-request" });
  assert.equal(result.error.code, "LOCK_TIMEOUT");
  assert.equal(calls.length, 4);
});

test("RATE_LIMITED is never automatically retried", async () => {
  const calls = [];
  const client = createApiClient({
    apiUrl: API_URL,
    gmRequest: gmSequence([
      loaded({ ok: false, error: { code: "RATE_LIMITED", retryable: false } }),
    ], calls),
    sleep: async () => assert.fail("sleep must not run"),
  });
  assert.equal((await client.submit({})).error.code, "RATE_LIMITED");
  assert.equal(calls.length, 1);
});

test("missing or non-Google API URLs fail closed", () => {
  for (const apiUrl of ["", "https://example.com/exec", "http://script.google.com/macros/s/x/exec"]) {
    assert.throws(
      () => createApiClient({ apiUrl, gmRequest() {} }),
      (error) => error instanceof ApiClientError && error.code === "API_NOT_CONFIGURED",
    );
  }
});
