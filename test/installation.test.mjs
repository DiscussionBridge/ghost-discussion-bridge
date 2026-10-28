import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { installationDiagnostic, installationEnvironment, installationFiles, prepareInstallation } from "../src/installation.mjs";

const config = { serverUrl: "https://forum.example", ghostOrigin: "https://ghost.example", ghostAdminOrigin: "https://admin.example", adapterOrigin: "https://adapter.example", operatorOrigin: "https://adapter.example", stateFile: "/srv/bridge-state/state.json", connectionId: `dbc_${"a".repeat(24)}`, port: 8792 };
const options = { configFile: "/srv/bridge-private/adapter.env", runtimeDirectory: "/opt/bridge-runtime", nodePath: "/usr/bin/node", user: "bridge_ghost" };

test("common V4 preparation has one contract, bounded native instructions and no activation or secret contents", () => {
  const files = installationFiles({ ...config, connectionSecret: "private-secret-value", ghostAdminApiKey: "private-native-key" }, options);
  assert.equal(files.size, 4);
  assert.match(files.get("discussionbridge-ghost.service"), /User=bridge_ghost/);
  assert.match(files.get("discussionbridge-ghost.service"), /ReadWritePaths="\/srv\/bridge-state"/);
  assert.match(files.get("adapter-nginx.conf"), /proxy_pass http:\/\/127\.0\.0\.1:8792\//);
  assert.match(files.get("ghost-site-footer.html"), /https:\/\/adapter\.example/);
  const instructions = files.get("INSTALL.md");
  assert.match(instructions, /One V4 contract pair/); assert.match(instructions, /native_source_html_unqualified stops raw dispatch/);
  assert.match(instructions, /pending exact requests\/CAS\/leases\/fences/); assert.match(instructions, /entire Site Header\/Footer/);
  assert.doesNotMatch([...files.values()].join("\n"), /private-secret-value|private-native-key|systemctl start|sudo |sourceProtocol|publicationProtocol/);
});

test("closed preparation settings reject removed Bridge controls and unsafe host interpolation", () => {
  assert.deepEqual(installationEnvironment('DISCUSSIONBRIDGE_FORUM_NAME="Community Café"\nDISCUSSIONBRIDGE_PORT=8792\n'), { DISCUSSIONBRIDGE_FORUM_NAME: "Community Café", DISCUSSIONBRIDGE_PORT: "8792" });
  for (const setting of ["PUBLICATION_PROTOCOL", "SOURCE_PROTOCOL", "SOURCE_RECEIVER_PROFILE", "SOURCE_RECEIVER_SCHEMA_SHA256", "SOURCE_RECEIVER_RUNTIME_SHA256"]) assert.throws(() => installationEnvironment(`DISCUSSIONBRIDGE_${setting}=anything`));
  for (const value of ["NODE_OPTIONS=--import=/tmp/x.mjs", "DISCUSSIONBRIDGE_PORT=8792\nDISCUSSIONBRIDGE_PORT=9000", "export DISCUSSIONBRIDGE_PORT=8792", "UNKNOWN=value", "DISCUSSIONBRIDGE_LANE=ok\0bad"]) assert.throws(() => installationEnvironment(value));
  for (const user of ["root", "user name", "a\nExecStart=bad"]) assert.throws(() => installationFiles(config, { ...options, user }));
  for (const configFile of ["relative.env", "/tmp/%n.env", "/tmp/$BAD.env", '/tmp/".env']) assert.throws(() => installationFiles(config, { ...options, configFile }));
});

test("preparation diagnostics do not reflect arbitrary secret-bearing errors", () => {
  assert.match(installationDiagnostic({ code: "EEXIST" }), /Existing files were preserved/);
  assert.match(installationDiagnostic(new Error("Missing DISCUSSIONBRIDGE_ADAPTER_ORIGIN")), /ADAPTER_ORIGIN/);
  assert.doesNotMatch(installationDiagnostic(new Error("private-secret-value")), /private-secret-value/);
});

test("native Linux preparation is exclusive, preserves durable state/secrets and refuses linked paths", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghost-v4-install-"));
  try {
    const privateDirectory = join(directory, "private"), stateDirectory = join(directory, "state");
    await mkdir(privateDirectory, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
    const stateFile = join(stateDirectory, "state.json"), state = '{"version":1,"posts":{},"publications":{},"presentations":{}}';
    await writeFile(stateFile, state, { mode: 0o600 });
    const secrets = { connection: "s".repeat(32), webhook: "w".repeat(32), admin: `${"a".repeat(24)}:${"b".repeat(64)}` };
    for (const [name, secret] of Object.entries(secrets)) await writeFile(join(privateDirectory, name), secret, { mode: 0o600 });
    const environment = { DISCUSSIONBRIDGE_SERVER_URL: config.serverUrl, DISCUSSIONBRIDGE_GHOST_ORIGIN: config.ghostOrigin, DISCUSSIONBRIDGE_ADAPTER_ORIGIN: config.adapterOrigin, DISCUSSIONBRIDGE_CONNECTION_ID: config.connectionId, DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: join(privateDirectory, "connection"), DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE: join(privateDirectory, "webhook"), DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE: join(privateDirectory, "admin"), DISCUSSIONBRIDGE_STATE_FILE: stateFile };
    const configFile = join(privateDirectory, "adapter.env"), outputDirectory = join(directory, "prepared");
    await writeFile(configFile, Object.entries(environment).map(([name, value]) => `${name}=${value}`).join("\n"), { mode: 0o600 });
    const request = { configFile, outputDirectory, user: options.user };
    assert.deepEqual((await prepareInstallation(request)).activated, false);
    assert.equal(await readFile(stateFile, "utf8"), state);
    for (const [name, secret] of Object.entries(secrets)) assert.equal(await readFile(join(privateDirectory, name), "utf8"), secret);
    await assert.rejects(prepareInstallation(request), { code: "EEXIST" });
    await symlink(privateDirectory, join(directory, "linked"));
    await assert.rejects(prepareInstallation({ ...request, configFile: join(directory, "linked", "adapter.env"), outputDirectory: join(directory, "never-created") }), /symbolic/);
  } finally {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}ghost-v4-install-`)) throw new Error("Unexpected test cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});
