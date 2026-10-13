import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCodeInjection } from "../src/install-rich-content.mjs";
import { buildServer } from "../src/service.mjs";
import { browserDeployment } from "../src/browser-deployment.mjs";
import { browserLoaderUrl } from "../src/browser-assets.mjs";
import { loadConfig } from "../src/config.mjs";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { installationDiagnostic, installationEnvironment, installationFiles, prepareInstallation } from "../src/installation.mjs";

const deployment = {
  adapterOrigin: "https://adapter.example",
  ghostOrigin: "https://ghost.example",
  serverUrl: "https://forum.example",
};
const resourceId = "11111111-1111-4111-8111-111111111111";

async function withServer(callback) {
  let reads = 0;
  const store = { read: async () => {
    reads += 1;
    return { posts: { one: {
      resource_id: resourceId, topic_id: 42,
      topic_url: "https://forum.example/t/example/42",
      canonical_url: "https://ghost.example/article/",
    } }, presentations: {}, publications: {} };
  } };
  const server = buildServer(deployment, store, {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, () => reads);
  } finally {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Ghost footer loads the external adapter without a customer-server route", () => {
  const script = mergeCodeInjection(null, deployment);
  assert.match(script, /https:\/\/adapter\.example\/discussionbridge\/assets\/loader\.js/);
  assert.match(script, /window\.location\.origin/);
  assert.match(script, /https:\/\/ghost\.example/);
});

test("external adapter serves its owned browser assets", async () => {
  await withServer(async (origin, reads) => {
    const response = await fetch(`${origin}/assets/loader.js`, { headers: { Origin: deployment.ghostOrigin } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.equal(response.headers.get("access-control-allow-origin"), deployment.ghostOrigin);
    assert.equal(reads(), 0);
    await response.arrayBuffer();
  });
});

test("cross-origin public lookup permits only the configured Ghost browser", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/comments?source=${encodeURIComponent("https://ghost.example/article/")}`, { headers: { Origin: deployment.ghostOrigin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), deployment.ghostOrigin);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.match(response.headers.get("vary"), /Origin/);
    assert.equal((await response.json()).topic_id, 42);
  });
});

test("foreign-origin requests fail before state access", async () => {
  await withServer(async (origin, reads) => {
    const response = await fetch(`${origin}/comments?source=${encodeURIComponent("https://ghost.example/article/")}`, { headers: { Origin: "https://foreign.example" } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(reads(), 0);
  });
});

test("asset responses identify actual bytes and support bounded caching without exposing files", async () => {
  await withServer(async (origin, reads) => {
    const loader = new URL(browserLoaderUrl(deployment));
    assert.match(loader.searchParams.get("v"), /^[a-f0-9]{64}$/);
    const response = await fetch(`${origin}/assets/loader.js${loader.search}`);
    const etag = response.headers.get("etag");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /immutable/);
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    await response.arrayBuffer();
    assert.equal((await fetch(`${origin}/assets/loader.js${loader.search}`, { headers: { "If-None-Match": etag } })).status, 304);
    const head = await fetch(`${origin}/assets/loader.css${loader.search}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.match(head.headers.get("content-type"), /text\/css/);
    for (const path of ["/assets/config.mjs", "/assets/.env", "/assets/loader.js?v=old", "/assets/..%2Fsrc%2Fconfig.mjs"]) assert.equal((await fetch(`${origin}${path}`)).status, 404);
    assert.equal(reads(), 0);
  });
});

test("preflight cannot grant credentials, administrative methods or administrative access", async () => {
  await withServer(async (origin, reads) => {
    const headers = { Origin: deployment.ghostOrigin, "Access-Control-Request-Method": "GET" };
    const allowed = await fetch(`${origin}/comments`, { method: "OPTIONS", headers });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null);
    for (const extra of [{ "Access-Control-Request-Method": "POST" }, { "Access-Control-Request-Headers": "authorization" }, { Origin: "null" }, { Origin: `${deployment.ghostOrigin}.evil.example` }]) {
      const denied = await fetch(`${origin}/comments`, { method: "OPTIONS", headers: { ...headers, ...extra } });
      assert.equal(denied.status, 403);
    }
    for (const path of ["/operator/", "/operator/synchronize", "/webhooks/ghost", "/health"]) {
      const denied = await fetch(`${origin}${path}`, { method: "OPTIONS", headers });
      assert.equal(denied.headers.get("access-control-allow-origin"), null);
      assert.notEqual(denied.status, 204);
    }
    assert.equal(reads(), 0);
  });
});

test("browser derives remote read and matching stylesheet addresses from its executing script", () => {
  const script = browserLoaderUrl(deployment);
  const result = browserDeployment(script);
  assert.equal(result.base, "https://adapter.example/discussionbridge/");
  assert.equal(new URL(result.stylesheet).search, new URL(script).search);
  for (const url of [undefined, "http://adapter.example/discussionbridge/assets/loader.js", "https://user:pass@adapter.example/discussionbridge/assets/loader.js", "https://adapter.example/other/loader.js", `${script}#fragment`, "https://adapter.example/discussionbridge/assets/loader.js?v=version-label"]) {
    assert.throws(() => browserDeployment(url));
  }
});

test("configuration separates public Ghost, private Admin and adapter origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-deployment-config-"));
  const values = { connection: "s".repeat(32), webhook: "w".repeat(32), admin: `${"a".repeat(24)}:${"b".repeat(64)}` };
  for (const [name, value] of Object.entries(values)) await writeFile(join(root, name), value);
  const environment = {
    DISCUSSIONBRIDGE_SERVER_URL: deployment.serverUrl,
    DISCUSSIONBRIDGE_GHOST_ORIGIN: deployment.ghostOrigin,
    DISCUSSIONBRIDGE_ADAPTER_ORIGIN: deployment.adapterOrigin,
    DISCUSSIONBRIDGE_CONNECTION_ID: "dbc_0123456789abcdef01234567",
    DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: join(root, "connection"),
    DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE: join(root, "webhook"),
    DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE: join(root, "admin"),
    DISCUSSIONBRIDGE_STATE_FILE: join(root, "state.json"),
  };
  const config = loadConfig(environment);
  assert.equal(config.operatorOrigin, deployment.adapterOrigin);
  assert.equal(config.operatorPassword, null);
  assert.equal(config.ghostAdminOrigin, deployment.ghostOrigin);
  const remote = loadConfig({ ...environment, DISCUSSIONBRIDGE_GHOST_ADMIN_ORIGIN: "https://private.ghost.io" });
  let address;
  await new GhostAdminClient(remote, async (url) => {
    address = url;
    const key = new URL(url).pathname.includes("/pages/") ? "pages" : "posts";
    return new Response(JSON.stringify({ [key]: [] }), { headers: { "Content-Type": "application/json" } });
  }).findByResource(resourceId);
  assert.equal(new URL(address).origin, "https://private.ghost.io");
  for (const invalid of ["http://adapter.example", "https://adapter.example/path", "https://user:pass@adapter.example", "https://adapter.example?key=value"]) assert.throws(() => loadConfig({ ...environment, DISCUSSIONBRIDGE_ADAPTER_ORIGIN: invalid }));
});

const preparedOptions = { configFile: "/srv/bridge-private/adapter.env", runtimeDirectory: "/opt/bridge-release", nodePath: "/usr/bin/node", user: "bridge_ghost" };
const preparedConfig = { ...deployment, port: 8792, operatorOrigin: deployment.adapterOrigin, ghostAdminOrigin: "https://private.ghost.io", stateFile: "/srv/bridge-state/state.json", connectionId: "dbc_0123456789abcdef01234567" };

test("all operators receive the same preparation files with no activation or secret material", () => {
  const files = installationFiles({ ...preparedConfig, connectionSecret: "secret-material-must-not-appear", ghostAdminApiKey: "key-material-must-not-appear" }, preparedOptions);
  assert.equal(files.size, 4);
  assert.match(files.get("discussionbridge-ghost.service"), /User=bridge_ghost/);
  assert.match(files.get("discussionbridge-ghost.service"), /--env-file=\/srv\/bridge-private\/adapter\.env/);
  assert.match(files.get("adapter-nginx.conf"), /proxy_pass http:\/\/127\.0\.0\.1:8792\//);
  assert.match(files.get("ghost-site-footer.html"), /https:\/\/adapter\.example/);
  assert.match(files.get("INSTALL.md"), /Operator access is disabled/);
  assert.doesNotMatch([...files.values()].join("\n"), /secret-material|key-material|sudo |systemctl start|curl .*\|/);
});

test("installation input rejects hidden process options, duplicates and unsafe service interpolation", () => {
  assert.deepEqual(installationEnvironment("# adapter only\nDISCUSSIONBRIDGE_PORT=8792\n"), { DISCUSSIONBRIDGE_PORT: "8792" });
  for (const text of ["NODE_OPTIONS=--import=/tmp/evil.mjs", "DISCUSSIONBRIDGE_PORT=8792\nDISCUSSIONBRIDGE_PORT=9000", "export DISCUSSIONBRIDGE_PORT=8792", "BAD=line", "DISCUSSIONBRIDGE_LANE=valid\0suffix"]) assert.throws(() => installationEnvironment(text));
  for (const user of ["root", "a\nExecStart=evil", "user name", ""]) assert.throws(() => installationFiles(preparedConfig, { ...preparedOptions, user }));
  for (const configFile of ["relative.env", "/tmp/%n.env", "/tmp/evil\n.env", "/tmp/quote\".env", "/tmp/$EXPANSION.env"]) assert.throws(() => installationFiles(preparedConfig, { ...preparedOptions, configFile }));
});

test("installation diagnostics explain safe known causes without reflecting arbitrary data", () => {
  assert.match(installationDiagnostic({ code: "EEXIST" }), /Existing files were preserved/);
  assert.match(installationDiagnostic(new Error("Missing DISCUSSIONBRIDGE_ADAPTER_ORIGIN")), /ADAPTER_ORIGIN/);
  assert.doesNotMatch(installationDiagnostic(new Error("my-secret-value")), /my-secret-value/);
});

test("Linux preparation is exclusive and preserves existing state and credentials", { skip: process.platform !== "linux" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ghost-install-"));
  const privateDirectory = join(root, "private");
  const stateDirectory = join(root, "state");
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(stateDirectory, { mode: 0o700 });
  const stateFile = join(stateDirectory, "state.json");
  const original = '{"version":1,"posts":{"preserved":true}}';
  await writeFile(stateFile, original, { mode: 0o600 });
  const secrets = { connection: "s".repeat(32), webhook: "w".repeat(32), admin: `${"a".repeat(24)}:${"b".repeat(64)}` };
  for (const [key, value] of Object.entries(secrets)) await writeFile(join(privateDirectory, key), value, { mode: 0o600 });
  const environment = {
    DISCUSSIONBRIDGE_SERVER_URL: deployment.serverUrl,
    DISCUSSIONBRIDGE_GHOST_ORIGIN: deployment.ghostOrigin,
    DISCUSSIONBRIDGE_ADAPTER_ORIGIN: deployment.adapterOrigin,
    DISCUSSIONBRIDGE_CONNECTION_ID: preparedConfig.connectionId,
    DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: join(privateDirectory, "connection"),
    DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE: join(privateDirectory, "webhook"),
    DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE: join(privateDirectory, "admin"),
    DISCUSSIONBRIDGE_STATE_FILE: stateFile,
  };
  const configFile = join(privateDirectory, "adapter.env");
  await writeFile(configFile, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  if (((await stat(configFile)).mode & 0o077) !== 0) {
    context.skip("The test filesystem does not expose owner-only POSIX file modes; native Linux filesystem qualification remains required.");
    return;
  }
  const outputDirectory = join(root, "prepared");
  const options = { configFile, outputDirectory, user: preparedOptions.user };
  const result = await prepareInstallation(options);
  assert.equal(result.prepared, true);
  assert.equal(result.activated, false);
  assert.equal(await readFile(stateFile, "utf8"), original);
  for (const [key, value] of Object.entries(secrets)) assert.equal(await readFile(join(privateDirectory, key), "utf8"), value);
  const footer = await readFile(join(outputDirectory, "ghost-site-footer.html"), "utf8");
  await assert.rejects(prepareInstallation(options), { code: "EEXIST" });
  assert.equal(await readFile(join(outputDirectory, "ghost-site-footer.html"), "utf8"), footer);
  const linked = join(root, "linked");
  await symlink(privateDirectory, linked);
  await assert.rejects(prepareInstallation({ ...options, configFile: join(linked, "adapter.env"), outputDirectory: join(root, "must-not-create") }), /symbolic/);
});
