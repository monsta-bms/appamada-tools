import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

function validateApiUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username && !url.password &&
      ((url.hostname === "script.google.com" && /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname)) ||
        (/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) && url.pathname === "/api")) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function buildSubmission({ apiUrl, clientVersion, metadataPath, outputPath }) {
  const normalizedApiUrl = String(apiUrl ?? "").trim();
  if (!validateApiUrl(normalizedApiUrl)) {
    throw new Error(
      "APPAMADA_API_URL must be an HTTPS Apps Script exec or a workers.dev /api gateway URL",
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(clientVersion)) {
    throw new Error("Invalid client version");
  }

  let metadata = (await readFile(new URL(metadataPath, import.meta.url), "utf8")).trimEnd();
  if (!metadata.startsWith("// ==UserScript==") || !metadata.endsWith("// ==/UserScript==")) {
    throw new Error("Invalid Userscript metadata block");
  }
  if (!metadata.includes(`// @version      ${clientVersion}`)) {
    throw new Error("Userscript metadata version does not match client version");
  }
  const apiHostname = new URL(normalizedApiUrl).hostname;
  if (apiHostname !== "script.google.com") {
    metadata = metadata.replace("// @run-at", `// @connect      ${apiHostname}\n// @run-at`);
  }

  await mkdir(new URL("./.local/", import.meta.url), { recursive: true });
  await build({
    absWorkingDir: rootDirectory,
    entryPoints: [fileURLToPath(new URL("./src/submission-main.js", import.meta.url))],
    outfile: fileURLToPath(new URL(outputPath, import.meta.url)),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    charset: "utf8",
    legalComments: "none",
    minify: false,
    sourcemap: false,
    define: {
      __APPAMADA_API_URL__: JSON.stringify(normalizedApiUrl),
      __APPAMADA_CLIENT_VERSION__: JSON.stringify(clientVersion),
    },
    banner: { js: `${metadata}\n` },
  });
}
