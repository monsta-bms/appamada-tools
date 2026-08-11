import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const entryPoint = fileURLToPath(new URL("./src/main.js", import.meta.url));
const outputFile = fileURLToPath(new URL("./dist/appamada_bmsir_submit.user.js", import.meta.url));
const metadata = (await readFile(new URL("./src/userscript-header.txt", import.meta.url), "utf8")).trimEnd();

if (!metadata.startsWith("// ==UserScript==") || !metadata.endsWith("// ==/UserScript==")) {
  throw new Error("Invalid Userscript metadata block");
}

await build({
  absWorkingDir: rootDirectory,
  entryPoints: [entryPoint],
  outfile: outputFile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  charset: "utf8",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  banner: {
    js: `${metadata}\n`,
  },
});
