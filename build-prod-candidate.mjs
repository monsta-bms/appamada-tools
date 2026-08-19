import { buildSubmission } from "./build-submission.mjs";

await buildSubmission({
  apiUrl: process.env.APPAMADA_API_URL,
  clientVersion: "0.4.4-rc.1",
  metadataPath: "./src/userscript-prod-candidate-header.txt",
  outputPath: "./.local/appamada_bmsir_submit.prod-candidate.user.js",
});
