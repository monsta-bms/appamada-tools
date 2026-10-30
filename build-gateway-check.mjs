import { buildSubmission } from "./build-submission.mjs";

await buildSubmission({
  apiUrl: "https://appamada-submission-gateway.local-check.workers.dev/api",
  clientVersion: "0.4.9",
  metadataPath: "./src/userscript-header.txt",
  outputPath: "./.local/appamada_bmsir_submit.gateway-check.user.js",
});
