import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSubmission } from "../build-submission.mjs";

test("local gateway candidate grants only the configured endpoint, contains no signing key, and compiles", async () => {
  const endpoint = "https://appamada-submission-gateway.local-check.workers.dev/api";
  await buildSubmission({ apiUrl: endpoint, clientVersion: "0.4.9", metadataPath: "./src/userscript-header.txt",
    outputPath: "./.local/appamada_bmsir_submit.gateway-check.user.js" });
  const source = await readFile(new URL("../.local/appamada_bmsir_submit.gateway-check.user.js", import.meta.url), "utf8");
  assert.match(source, /^\/\/ @version\s+0\.4\.9$/m);
  assert.match(source, /^\/\/ @connect\s+appamada-submission-gateway\.local-check\.workers\.dev$/m);
  assert.doesNotMatch(source, /^\/\/ @connect\s+\*$/m);
  assert.doesNotMatch(source, /GATEWAY_SHARED_SECRET|local-test-gateway-secret|computeHmacSha256Signature/);
  assert.equal(source.includes(endpoint), true);
  assert.doesNotThrow(() => new Function(source));
});
