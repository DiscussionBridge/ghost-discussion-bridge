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
  if (Buffer.byteLength(lane) > 64) throw new Error("Invalid lane");
  return {
    serverUrl: httpsOrigin("DISCUSSIONBRIDGE_SERVER_URL", environment),
    ghostOrigin: httpsOrigin("DISCUSSIONBRIDGE_GHOST_ORIGIN", environment),
    connectionId,
    connectionSecret: protectedValue(required("DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE", environment)),
    webhookToken: protectedValue(required("DISCUSSIONBRIDGE_GHOST_WEBHOOK_TOKEN_FILE", environment)),
    stateFile: required("DISCUSSIONBRIDGE_STATE_FILE", environment),
    lane,
    port,
  };
}
