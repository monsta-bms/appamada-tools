import { buildSubmission } from "./build-submission.mjs";

await buildSubmission({
  apiUrl: "https://script.google.com/macros/s/BUILD_CHECK_PLACEHOLDER/exec",
  clientVersion: "0.4.3",
  metadataPath: "./src/userscript-header.txt",
  outputPath: "./.local/appamada_bmsir_submit.public-check.user.js",
});
