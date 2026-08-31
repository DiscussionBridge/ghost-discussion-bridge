import { build } from "esbuild";

await build({
  entryPoints: ["src/browser-loader.mjs"],
  bundle: true,
  format: "iife",
  minify: true,
  target: ["es2022"],
  outfile: "public/discussionbridge-loader.js",
  loader: {
    ".woff": "dataurl",
    ".woff2": "dataurl",
    ".ttf": "dataurl",
  },
  legalComments: "none",
});
