import { build } from "esbuild";

// Optional task-local build dependency root; never included in browser output.
const nodePaths = process.env.DISCUSSIONBRIDGE_BUILD_NODE_PATH ? [process.env.DISCUSSIONBRIDGE_BUILD_NODE_PATH] : [];

await build({
  entryPoints: ["src/browser-loader.mjs"],
  nodePaths,
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

await build({
  entryPoints: ["src/browser-rich-content.mjs"],
  nodePaths,
  bundle: true,
  format: "iife",
  minify: true,
  target: ["es2022"],
  outfile: "public/discussionbridge-rich-content.js",
  legalComments: "none",
});
