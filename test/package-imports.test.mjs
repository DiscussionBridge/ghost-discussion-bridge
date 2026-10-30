import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repository = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.DISCUSSIONBRIDGE_PACKAGE_TEST_ROOT || repository);

// Each process imports the real product graph from a cold module cache, without
// the test-only resolver. CI also runs these against its ordinary npm consumer.
for (const [module, member] of [
  ["service.mjs", "buildServer"],
  ["source-write.mjs", "publishSource"],
  ["cms-source-move.mjs", "prepareGhostSourceMove"],
]) {
  test(`normal package imports ${module} without a test hook`, () => {
    const address = pathToFileURL(path.join(packageRoot, "src", module)).href;
    const program = `const loaded = await import(${JSON.stringify(address)}); if (typeof loaded[${JSON.stringify(member)}] !== 'function') throw new Error('Missing product export');`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: packageRoot, env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
  });
}

test("normal HTML dependency bridge returns the exact locked functions", () => {
  const address = pathToFileURL(path.join(packageRoot, "src", "html-sanitizer.mjs")).href;
  const program = `import { createRequire } from 'node:module'; const loaded = await import(${JSON.stringify(address)}); const require = createRequire(${JSON.stringify(address)}); if (loaded.default !== require('sanitize-html') || loaded.Parser !== require('htmlparser2').Parser || loaded.parseDocument !== require('htmlparser2').parseDocument || loaded.decodeHTML !== require('entities').decodeHTML) throw new Error('Locked HTML implementation was replaced');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: packageRoot, env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

for (const [dependency, statement, member] of [
  ["sanitizer", "import sanitizeHtml from 'sanitize-html';", "sanitizeHtml"],
  ["parser", "import { Parser } from 'htmlparser2';", "Parser"],
  ["entity decoder", "import { decodeHTML } from 'entities';", "decodeHTML"],
]) for (const dependencyFirst of [true, false]) {
  test(`normal package supports static ${dependency} co-import ${dependencyFirst ? "before" : "after"} its service`, () => {
    const address = pathToFileURL(path.join(packageRoot, "src", "service.mjs")).href;
    const service = `import { buildServer } from ${JSON.stringify(address)};`;
    const program = (dependencyFirst ? statement + service : service + statement)
      + `if (typeof ${member} !== 'function' || typeof buildServer !== 'function') throw new Error('Incomplete static co-import');`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: packageRoot, env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
  });
}
