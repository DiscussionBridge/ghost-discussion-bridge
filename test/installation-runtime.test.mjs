import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installation = process.env.DISCUSSIONBRIDGE_PACKAGE_TEST_ROOT
  ? pathToFileURL(resolve(process.env.DISCUSSIONBRIDGE_PACKAGE_TEST_ROOT, "src/installation.mjs")).href
  : new URL("../src/installation.mjs", import.meta.url).href;

test("installation preflight matches the approved Node 22.12 boundary and safe diagnostic", () => {
  const cases = [
    ["21.9.0", false], ["22.0.0", false], ["22.11.9", false],
    ["22.12.0", true], ["22.12.1", true], ["23.0.0", true], ["24.0.0", true],
  ];
  const results = [];
  for (const [version] of cases) {
    // Import on the real supported runtime, then synthesize only the guard's
    // trusted runtime facts. Invalid paths stop immediately after that guard,
    // before preparation reads credentials or creates any output. This is not
    // a claim to execute the adapter on an unsupported runtime or native host.
    const program = `const { prepareInstallation, installationDiagnostic } = await import(${JSON.stringify(installation)});
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
      let caught;
      try { await prepareInstallation({ configFile: 'relative-fixture', outputDirectory: 'relative-output', user: 'bridge_fixture' }); }
      catch (error) { caught = error; }
      if (!caught) throw new Error('Invalid fixture crossed the preparation boundary');
      console.log(JSON.stringify({ message: caught.message, diagnostic: installationDiagnostic(caught), redacted: !installationDiagnostic(new Error('synthetic-private-fixture')).includes('synthetic-private-fixture') }));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: "" },
      encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    results.push({ version, ...JSON.parse(result.stdout) });
  }
  console.log(JSON.stringify({ simulated_runtime_guards: results }));
  assert.deepEqual(results, cases.map(([version, supported]) => {
    const message = supported ? "Installation needs an absolute safe path" : "Node 22.12 or newer is required";
    return { version, message, diagnostic: message, redacted: true };
  }));
});
