import { buildSubmission } from "./build-submission.mjs";

const endpoint = new URL(process.env.APPAMADA_API_URL || "https://unconfigured.invalid");
if (!/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(endpoint.hostname) || endpoint.pathname !== "/api") {
  throw new Error("A configured submission gateway /api endpoint is required for the new public release");
}

await buildSubmission({
  apiUrl: process.env.APPAMADA_API_URL,
  clientVersion: "0.4.8",
  metadataPath: "./src/userscript-header.txt",
  outputPath: "./dist/appamada_bmsir_submit.user.js",
});
