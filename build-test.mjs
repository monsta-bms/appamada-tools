import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const apiUrl = String(process.env.APPAMADA_API_URL ?? "").trim();

function isValidTestApiUrl(value) {
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

if (!isValidTestApiUrl(apiUrl)) {
  throw new Error(
    "APPAMADA_API_URL must be an https://script.google.com/macros/s/.../exec URL",
  );
}

const metadata = (
  await readFile(new URL("./src/userscript-test-header.txt", import.meta.url), "utf8")
).trimEnd();

if (!metadata.startsWith("// ==UserScript==") || !metadata.endsWith("// ==/UserScript==")) {
  throw new Error("Invalid test Userscript metadata block");
}

await mkdir(new URL("./.local/", import.meta.url), { recursive: true });
await build({
  absWorkingDir: rootDirectory,
  entryPoints: ["./src/test-main.js"],
  outfile: "./.local/appamada_bmsir_submit.test.user.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  charset: "utf8",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  define: {
    __APPAMADA_API_URL__: JSON.stringify(apiUrl),
  },
  banner: {
    js: `${metadata}\n`,
  },
});
