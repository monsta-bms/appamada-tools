import { buildSubmission } from "./build-submission.mjs";

await buildSubmission({
  apiUrl: process.env.APPAMADA_API_URL,
  clientVersion: "0.3.0",
  metadataPath: "./src/userscript-header.txt",
  outputPath: "./dist/appamada_bmsir_submit.user.js",
});
