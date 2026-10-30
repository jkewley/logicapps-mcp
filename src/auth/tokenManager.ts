/**
 * Token manager.
 *
 * Token resolution order:
 * 1. Request-scoped token (HTTP / Azure Functions passthrough via runWithToken)
 * 2. Process-wide passthrough token (setPassthroughToken; used by tests/tools)
 * 3. Azure CLI token (stdio mode only, when enabled via enableAzureCliAuth)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { LogicAppsMcpSettings } from "../config/settings.js";
import { McpError } from "../utils/errors.js";
import { getAzureCliToken } from "./azureCli.js";

let cachedSettings: LogicAppsMcpSettings | null = null;
let passthroughToken: string | null = null;
let azureCliEnabled = false;
let cliToken: { accessToken: string; expiresOn: Date } | null = null;
let cliTokenInFlight: Promise<string> | null = null;

const requestTokenStorage = new AsyncLocalStorage<{ token?: string }>();

// Refresh CLI tokens this long before they expire
const CLI_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function setSettings(settings: LogicAppsMcpSettings): void {
  cachedSettings = settings;
}

/**
 * Sets a process-wide passthrough token. Prefer runWithToken for servers
 * that handle concurrent requests.
 */
export function setPassthroughToken(token: string): void {
  passthroughToken = token;
}

/**
 * Clears the process-wide passthrough token.
 */
export function clearPassthroughToken(): void {
  passthroughToken = null;
}

/**
 * Run fn with a token scoped to the current async context (one request).
 * Concurrent requests never observe each other's tokens.
 */
export function runWithToken<T>(token: string | undefined, fn: () => T): T {
  return requestTokenStorage.run({ token }, fn);
}

/**
 * Enable Azure CLI (`az login`) as a token source. Used in stdio mode.
 */
export function enableAzureCliAuth(enabled = true): void {
  azureCliEnabled = enabled;
  cliToken = null;
}

/**
 * Initializes settings.
 */
export async function initializeAuth(): Promise<void> {
  if (!cachedSettings) {
    throw new McpError("AuthenticationError", "Settings not initialized");
  }
  console.error(
    azureCliEnabled
      ? "MCP server ready (Azure CLI auth mode)"
      : "MCP server ready (passthrough auth mode)"
  );
}

function getScopedToken(): string | undefined {
  const store = requestTokenStorage.getStore();
  if (store) return store.token;
  return passthroughToken ?? undefined;
}

async function getCliAccessToken(): Promise<string> {
  if (cliToken && cliToken.expiresOn.getTime() - Date.now() > CLI_REFRESH_MARGIN_MS) {
    return cliToken.accessToken;
  }
  if (!cliTokenInFlight) {
    const resource =
      cachedSettings?.cloud.authentication.tokenAudience ??
      cachedSettings?.cloud.resourceManager ??
      "https://management.azure.com";
    cliTokenInFlight = getAzureCliToken(resource)
      .then((t) => {
        cliToken = { accessToken: t.accessToken, expiresOn: t.expiresOn };
        return t.accessToken;
      })
      .finally(() => {
        cliTokenInFlight = null;
      });
  }
  return cliTokenInFlight;
}

/**
 * Gets a valid access token for the Azure ARM API.
 */
export async function getAccessToken(): Promise<string> {
  const scoped = getScopedToken();
  if (scoped) return scoped;

  // Request-scoped contexts (HTTP/Functions) never fall back to local credentials
  if (azureCliEnabled && !requestTokenStorage.getStore()) {
    return getCliAccessToken();
  }

  throw new McpError(
    "AuthenticationError",
    azureCliEnabled
      ? "No bearer token for this request. Provide an Authorization header with an ARM-scoped token."
      : "Bearer token required. Provide an Authorization header with an ARM-scoped token."
  );
}

/**
 * Stable, non-reversible key identifying the current caller. Used to partition
 * caches that hold per-caller secrets (e.g. Standard host keys).
 */
export function getCallerCacheKey(): string {
  const token = getScopedToken();
  if (!token) return "local";
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Clears all token state.
 */
export async function logout(): Promise<void> {
  clearPassthroughToken();
  cliToken = null;
}
