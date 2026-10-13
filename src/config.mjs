import { readFileSync } from "node:fs";
import { validateSyncInterval } from "./publication-scheduler.mjs";

const CONNECTION_PATTERN = /^dbc_[a-f0-9]{24}$/;

function required(name, environment) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing ${name}`);
  }
  return value.trim();
}

function httpsOrigin(name, environment) {
  const parsed = new URL(required(name, environment));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error(`Invalid ${name}`);
  }
  return parsed.origin;
}

function optionalHttpsOrigin(name, environment, fallback) {
  const value = (environment[name] ?? "").trim();
  return value ? httpsOrigin(name, { ...environment, [name]: value }) : fallback;
}

function protectedValue(path) {
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 24 || value.length > 512 || /[\r\n\0]/u.test(value)) {
    throw new Error("Invalid protected value");
  }
  return value;
}

export function loadConfig(environment = process.env) {
  const connectionId = required("DISCUSSIONBRIDGE_CONNECTION_ID", environment);
  if (!CONNECTION_PATTERN.test(connectionId)) throw new Error("Invalid connection ID");
  const port = Number(environment.DISCUSSIONBRIDGE_PORT ?? "8792");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
  const lane = (environment.DISCUSSIONBRIDGE_LANE ?? "").trim();
  if (lane && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(lane)) throw new Error("Invalid lane");
  const connectionSecret = protectedValue(required("DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE", environment));
  const operatorPasswordFile = (environment.DISCUSSIONBRIDGE_OPERATOR_PASSWORD_FILE ?? "").trim();
  const operatorPassword = operatorPasswordFile ? protectedValue(operatorPasswordFile) : null;
  if (Buffer.byteLength(connectionSecret) < 32 || Buffer.byteLength(connectionSecret) > 256) throw new Error("Invalid DiscussionBridge connection secret");
  const serverUrl = httpsOrigin("DISCUSSIONBRIDGE_SERVER_URL", environment);
  const ghostOrigin = httpsOrigin("DISCUSSIONBRIDGE_GHOST_ORIGIN", environment);
  const adapterOrigin = httpsOrigin("DISCUSSIONBRIDGE_ADAPTER_ORIGIN", environment);
  const webhookMaximumBytes = Number(environment.DISCUSSIONBRIDGE_WEBHOOK_MAX_BYTES ?? 131072);
  if (!Number.isSafeInteger(webhookMaximumBytes) || webhookMaximumBytes < 1) throw new Error("Invalid Ghost webhook transport byte budget");
  const sourceSyncIntervalSeconds = validateSyncInterval(Number(environment.DISCUSSIONBRIDGE_SOURCE_SYNC_INTERVAL_SECONDS ?? 0));
  const publicationType = (environment.DISCUSSIONBRIDGE_PUBLICATION_TYPE ?? "post").trim();
  if (!["post", "page"].includes(publicationType)) throw new Error("Invalid DISCUSSIONBRIDGE_PUBLICATION_TYPE");
  return {
    serverUrl,
    ghostOrigin,
    adapterOrigin,
    ghostAdminOrigin: optionalHttpsOrigin("DISCUSSIONBRIDGE_GHOST_ADMIN_ORIGIN", environment, ghostOrigin),
    connectionId,
    connectionSecret,
    webhookSecret: protectedValue(required("DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE", environment)),
    ghostAdminApiKey: protectedValue(required("DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE", environment)),
    stateFile: required("DISCUSSIONBRIDGE_STATE_FILE", environment),
    lane,
    port,
    webhookMaximumBytes,
    sourceSyncIntervalSeconds,
    publicationType,
    operatorPassword,
    operatorOrigin: optionalHttpsOrigin("DISCUSSIONBRIDGE_OPERATOR_ORIGIN", environment, adapterOrigin),
  };
}
