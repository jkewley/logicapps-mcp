/**
 * Loads user settings from environment variables and config file.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AzureCloudEndpoints, getCloudEndpoints } from "./clouds.js";
import { Capability, parseCapabilities } from "../tools/capabilities.js";

export interface LogicAppsMcpSettings {
  tenantId: string;
  clientId: string;
  cloud: AzureCloudEndpoints;
  defaultSubscriptionId?: string;
  logLevel: "debug" | "info" | "warn" | "error";
  cacheTtlSeconds: number;
  /** Enabled tool capabilities. "read" is always present; everything else is opt-in. */
  capabilities: Capability[];
  /** Where each capability setting came from, for diagnostics. */
  capabilitySource: "cli" | "env" | "config" | "default";
  /** Path of the optional config file. */
  configFilePath: string;
  /** Non-fatal configuration problems detected while loading. */
  warnings: string[];
}

interface ConfigFile {
  tenantId?: string;
  clientId?: string;
  defaultSubscriptionId?: string;
  customCloud?: AzureCloudEndpoints;
  capabilities?: string[];
}

const DEFAULT_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"; // Azure CLI public client ID

/**
 * Load settings. Capability precedence: CLI --allow > LOGICAPPS_MCP_CAPABILITIES > config file.
 */
export async function loadSettings(
  options: { cliCapabilities?: string[] } = {}
): Promise<LogicAppsMcpSettings> {
  const warnings: string[] = [];
  const configFilePath = join(homedir(), ".logicapps-mcp", "config.json");

  // Try to load config file
  let configFile: ConfigFile = {};
  let content: string | undefined;
  try {
    content = await readFile(configFilePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") {
      warnings.push(`Could not read config file ${configFilePath} (${code}); using defaults.`);
    }
  }
  if (content !== undefined) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        configFile = parsed as ConfigFile;
      } else {
        warnings.push(`Config file ${configFilePath} must contain a JSON object; it was ignored.`);
      }
    } catch (error) {
      warnings.push(
        `Config file ${configFilePath} is not valid JSON and was ignored: ${(error as Error).message}`
      );
    }
  }

  // Determine cloud endpoints
  let cloud: AzureCloudEndpoints;
  if (configFile.customCloud) {
    cloud = configFile.customCloud;
  } else {
    cloud = getCloudEndpoints(process.env.AZURE_CLOUD);
  }

  let capabilitySource: LogicAppsMcpSettings["capabilitySource"] = "default";
  let capabilityValue: string | string[] | undefined;
  if (options.cliCapabilities && options.cliCapabilities.length > 0) {
    capabilitySource = "cli";
    capabilityValue = options.cliCapabilities;
  } else if (process.env.LOGICAPPS_MCP_CAPABILITIES !== undefined) {
    capabilitySource = "env";
    capabilityValue = process.env.LOGICAPPS_MCP_CAPABILITIES;
  } else if (configFile.capabilities !== undefined) {
    capabilitySource = "config";
    capabilityValue = configFile.capabilities;
  }
  const capabilities = [...parseCapabilities(capabilityValue)];

  const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
  let logLevel: LogicAppsMcpSettings["logLevel"] = "info";
  const rawLogLevel = process.env.LOGICAPPS_MCP_LOG_LEVEL;
  if (rawLogLevel) {
    if ((LOG_LEVELS as readonly string[]).includes(rawLogLevel)) {
      logLevel = rawLogLevel as LogicAppsMcpSettings["logLevel"];
    } else {
      warnings.push(
        `LOGICAPPS_MCP_LOG_LEVEL='${rawLogLevel}' is not one of ${LOG_LEVELS.join(", ")}; using 'info'.`
      );
    }
  }

  let cacheTtlSeconds = 300;
  const rawTtl = process.env.LOGICAPPS_MCP_CACHE_TTL;
  if (rawTtl !== undefined) {
    const parsedTtl = Number(rawTtl);
    if (Number.isInteger(parsedTtl) && parsedTtl >= 0) {
      cacheTtlSeconds = parsedTtl;
    } else {
      warnings.push(
        `LOGICAPPS_MCP_CACHE_TTL='${rawTtl}' is not a non-negative integer; using 300.`
      );
    }
  }

  return {
    tenantId: process.env.AZURE_TENANT_ID ?? configFile.tenantId ?? "common",
    clientId: process.env.AZURE_CLIENT_ID ?? configFile.clientId ?? DEFAULT_CLIENT_ID,
    cloud,
    defaultSubscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? configFile.defaultSubscriptionId,
    logLevel,
    cacheTtlSeconds,
    capabilities,
    capabilitySource,
    configFilePath,
    warnings,
  };
}
