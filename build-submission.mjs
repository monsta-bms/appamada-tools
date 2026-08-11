import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

function validateApiUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "script.google.com" &&
      /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) &&
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
      "APPAMADA_API_URL must be an https://script.google.com/macros/s/.../exec URL",
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(clientVersion)) {
    throw new Error("Invalid client version");
  }

  const metadata = (await readFile(new URL(metadataPath, import.meta.url), "utf8")).trimEnd();
  if (!metadata.startsWith("// ==UserScript==") || !metadata.endsWith("// ==/UserScript==")) {
    throw new Error("Invalid Userscript metadata block");
  }
  if (!metadata.includes(`// @version      ${clientVersion}`)) {
    throw new Error("Userscript metadata version does not match client version");
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
