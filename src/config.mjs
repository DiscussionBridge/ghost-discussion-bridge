import { readFileSync } from "node:fs";

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
  if (Buffer.byteLength(connectionSecret) < 32 || Buffer.byteLength(connectionSecret) > 256) throw new Error("Invalid DiscussionBridge connection secret");
  return {
    serverUrl: httpsOrigin("DISCUSSIONBRIDGE_SERVER_URL", environment),
    ghostOrigin: httpsOrigin("DISCUSSIONBRIDGE_GHOST_ORIGIN", environment),
    connectionId,
    connectionSecret,
    webhookSecret: protectedValue(required("DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE", environment)),
    ghostAdminApiKey: protectedValue(required("DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE", environment)),
    stateFile: required("DISCUSSIONBRIDGE_STATE_FILE", environment),
    lane,
    port,
  };
}
