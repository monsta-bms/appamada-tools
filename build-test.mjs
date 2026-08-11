import { buildSubmission } from "./build-submission.mjs";

await buildSubmission({
  apiUrl: process.env.APPAMADA_API_URL,
  clientVersion: "0.2.0-test",
  metadataPath: "./src/userscript-test-header.txt",
  outputPath: "./.local/appamada_bmsir_submit.test.user.js",
});
