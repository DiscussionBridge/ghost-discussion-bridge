import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { loadConfig } from "./config.mjs";
import { commentsBootstrap } from "./install-rich-content.mjs";
import { adapterPublicBase } from "./deployment.mjs";
import { assertStateStoreRuntimePrerequisites } from "./state-store.mjs";
import { PRODUCT_VERSION } from "./version.mjs";

const KEYS = new Set([
  "DISCUSSIONBRIDGE_SERVER_URL", "DISCUSSIONBRIDGE_CONNECTION_ID",
  "DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE", "DISCUSSIONBRIDGE_GHOST_ORIGIN",
  "DISCUSSIONBRIDGE_ADAPTER_ORIGIN", "DISCUSSIONBRIDGE_GHOST_ADMIN_ORIGIN",
  "DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE", "DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE",
  "DISCUSSIONBRIDGE_STATE_FILE", "DISCUSSIONBRIDGE_LANE", "DISCUSSIONBRIDGE_PORT",
  "DISCUSSIONBRIDGE_OPERATOR_PASSWORD_FILE", "DISCUSSIONBRIDGE_OPERATOR_ORIGIN",
  "DISCUSSIONBRIDGE_WEBHOOK_MAX_BYTES",
  "DISCUSSIONBRIDGE_SOURCE_SYNC_INTERVAL_SECONDS",
  "DISCUSSIONBRIDGE_PUBLICATION_TYPE",
]);
const SECRET_FILES = ["DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE", "DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE", "DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE", "DISCUSSIONBRIDGE_OPERATOR_PASSWORD_FILE"];

export function installationEnvironment(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16_384 || text.includes("\0")) throw new Error("Invalid installation configuration");
  const seen = new Set();
  // One assignment per line. Reject Node/shell configuration, duplicates and
  // multiline values before Node's env-file parser can silently accept them.
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (!match || !KEYS.has(match[1]) || seen.has(match[1])) throw new Error("Unsupported or duplicate installation setting");
    seen.add(match[1]);
    if (/[\r\n\0]/u.test(match[2])) throw new Error("Invalid installation setting");
  }
  const environment = parseEnv(text);
  if (Object.keys(environment).length !== seen.size || Object.values(environment).some((value) => /[\r\n\0]/u.test(value))) throw new Error("Invalid installation configuration");
  return environment;
}

function safePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /[%$\r\n\0"\\]/u.test(value) || value === "/") throw new Error("Installation needs an absolute safe path");
  return resolve(value);
}

async function ordinaryPath(path, { file = false, privateFile = false } = {}) {
  let current = path;
  for (;;) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || (current === path ? (file ? !metadata.isFile() : !metadata.isDirectory()) : !metadata.isDirectory())) throw new Error("Installation path must not use symbolic links or special files");
    if (current === path && privateFile && (metadata.mode & 0o077) !== 0) throw new Error("Configuration and credential files must not be accessible to group or other users");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function installationFiles(config, { configFile, runtimeDirectory, nodePath, user }) {
  for (const path of [configFile, runtimeDirectory, nodePath, config.stateFile]) safePath(path);
  if (dirname(config.stateFile) === "/") throw new Error("Use a dedicated state directory");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(user ?? "") || user === "root") throw new Error("Specify the dedicated non-root adapter user");
  if (config.operatorOrigin !== config.adapterOrigin) throw new Error("The common installation uses the adapter origin for operator access");
  const origin = new URL(config.adapterOrigin);
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(origin.hostname)) throw new Error("The adapter proxy needs a DNS hostname");
  const base = adapterPublicBase(config.adapterOrigin);
  const unit = `[Unit]
Description=DiscussionBridge for Ghost
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory="${runtimeDirectory}"
ExecStart="${nodePath}" "--env-file=${configFile}" "${runtimeDirectory}/src/index.mjs"
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths="${dirname(config.stateFile)}"

[Install]
WantedBy=multi-user.target
`;
  const proxy = `# Include inside the TLS server for ${origin.origin} on the ADAPTER host.
# Supply its certificate and enable HTTP compression in that server.
# No route is installed on the customer Ghost server.
location /discussionbridge/ {
    proxy_pass http://127.0.0.1:${config.port}/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_connect_timeout 5s;
    proxy_read_timeout 65s;
    client_max_body_size ${config.webhookMaximumBytes ?? 131072};
}
`;
  const instructions = `# Prepared Ghost adapter installation

This is a preparation result, not an activated installation.

Adapter version: ${PRODUCT_VERSION}
Ghost public origin: ${config.ghostOrigin}
Ghost Admin origin: ${config.ghostAdminOrigin}
Adapter public base: ${base}
Receiver: ${config.serverUrl}
Connection: ${config.connectionId}

1. Keep the reviewed runtime at ${runtimeDirectory}; install its locked production dependencies with npm ci --omit=dev --ignore-scripts --no-audit --no-fund and an explicitly chosen cache on the adapter host. Do not rebuild browser assets in production.
2. Verify the existing non-root user ${user} can read the runtime, ${configFile} and protected credential files, and can write only the existing state directory ${dirname(config.stateFile)}. Configuration/credentials must remain private; do not put them inside the runtime or a web root.
3. Install the prepared service unit and proxy fragment on the adapter host, configure the adapter hostname's trusted TLS certificate, check systemd and Nginx syntax, then deliberately start the service. Preparation has not performed these privileged steps.
4. Check ${base}health. For selected outbound posts configure signed post.published and post.published.edited webhooks at ${base}webhooks/ghost using the existing webhook secret. Draft, unpublish and deletion events do not authorize a To rewrite. Choose a webhook transport budget large enough for the complete native JSON payload and keep the proxy and service budgets aligned.
5. If selecting the supplied theme integration, paste ghost-site-footer.html into Ghost Admin's Site Footer, preserving unrelated code injection. Otherwise retain the operator's chosen equivalent theme/per-post integration. Review theme hooks (.gh-article, .gh-content and internal tag classes) against the active theme. No Ghost server routing change is required.
6. Test explicit opt-in, public comments/presentation, native publication, authenticated operator status and denied requests before deployment acceptance. No publishing or forum enrollment is triggered by preparation.

Operator address: ${base}operator/
Operator access is ${config.operatorPassword ? "configured with its separate credential" : "disabled (no operator credential supplied)"}.
Automatic source synchronization is ${config.sourceSyncIntervalSeconds ? `selected every ${config.sourceSyncIntervalSeconds} seconds in this same service` : "disabled; retain the selected manual/external cron workflow"}. It processes only this connection's explicitly authorized native bindings, with the existing operation/state ownership.

Keep configuration, credentials and the same state directory across upgrades. Never reset or overwrite state. Stop the service before replacing a runtime; retain a preceding presentation-revision-capable runtime and compatible state backup for rollback. Refresh the footer from the new prepared runtime because asset URLs identify actual content, then deliberately synchronize authorized native publications to reconcile owned presentation changes on the same post identities. Source revision or package label alone does not prove current presentation. Qualify retained loader/provenance markup and theme behavior before accepting the upgrade or rollback. Existing native posts are not rewritten by preparation.
`;
  return new Map([
    ["discussionbridge-ghost.service", unit],
    ["adapter-nginx.conf", proxy],
    ["ghost-site-footer.html", commentsBootstrap(config)],
    ["INSTALL.md", instructions],
  ]);
}

export async function prepareInstallation({ configFile, outputDirectory, user }) {
  if (process.platform !== "linux") throw new Error("Prepare the service installation on its Linux adapter host");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node 22 or newer is required");
  const configuration = safePath(configFile);
  const output = safePath(outputDirectory);
  await ordinaryPath(configuration, { file: true, privateFile: true });
  const environment = installationEnvironment(await readFile(configuration, "utf8"));
  for (const key of SECRET_FILES) {
    if (environment[key]) await ordinaryPath(safePath(environment[key]), { file: true, privateFile: true });
  }
  const config = loadConfig(environment);
  await ordinaryPath(dirname(safePath(config.stateFile)));
  try {
    await ordinaryPath(config.stateFile, { file: true, privateFile: true });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await ordinaryPath(dirname(output));
  await assertStateStoreRuntimePrerequisites();
  const runtimeDirectory = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const files = installationFiles(config, { configFile: configuration, runtimeDirectory, nodePath: await realpath(process.execPath), user });
  // mkdir is deliberately exclusive. Never reuse a target, remove it after an
  // error, or replace its files: partial preparations remain inspectable.
  await mkdir(output, { mode: 0o700 });
  for (const [name, contents] of files) await writeFile(resolve(output, name), contents, { flag: "wx", mode: 0o600 });
  return { prepared: true, activated: false, outputDirectory: output, files: [...files.keys()] };
}

export function installationDiagnostic(error) {
  const filesystem = {
    EEXIST: "The output directory already exists; choose a new preparation directory. Existing files were preserved.",
    ENOENT: "A configuration, credential or parent directory is missing. Create the required protected files and state directory first.",
    EACCES: "The preparing user cannot access the selected files or directory. Check ownership and permissions.",
    ENOTDIR: "A selected parent path is not a directory.",
  };
  if (filesystem[error?.code]) return filesystem[error.code];
  const safeMessages = new Set([
    "Invalid installation configuration", "Unsupported or duplicate installation setting", "Invalid installation setting",
    "Installation needs an absolute safe path", "Installation path must not use symbolic links or special files",
    "Configuration and credential files must not be accessible to group or other users", "Specify the dedicated non-root adapter user",
    "The common installation uses the adapter origin for operator access", "The adapter proxy needs a DNS hostname",
    "Use a dedicated state directory", "Prepare the service installation on its Linux adapter host", "Node 22 or newer is required",
    "Invalid connection ID", "Invalid port", "Invalid lane", "Invalid protected value", "Invalid DiscussionBridge connection secret",
    "DiscussionBridge requires executable /usr/bin/flock (util-linux) and the current Node runtime on Linux",
  ]);
  if (safeMessages.has(error?.message) || /^(Missing|Invalid) DISCUSSIONBRIDGE_[A-Z_]+$/u.test(error?.message ?? "")) return error.message;
  return "Check the installation guide, required settings, Linux prerequisites and protected files.";
}
