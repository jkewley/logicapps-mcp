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
  // Try to load config file
  let configFile: ConfigFile = {};
  try {
    const configPath = join(homedir(), ".logicapps-mcp", "config.json");
    const content = await readFile(configPath, "utf-8");
    configFile = JSON.parse(content);
  } catch {
    // Config file doesn't exist or is invalid, use defaults
  }

  // Determine cloud endpoints
  let cloud: AzureCloudEndpoints;
  if (configFile.customCloud) {
    cloud = configFile.customCloud;
  } else {
    cloud = getCloudEndpoints(process.env.AZURE_CLOUD);
  }

  const capabilitySource =
    options.cliCapabilities && options.cliCapabilities.length > 0
      ? options.cliCapabilities
      : (process.env.LOGICAPPS_MCP_CAPABILITIES ?? configFile.capabilities);
  const capabilities = [...parseCapabilities(capabilitySource)];

  return {
    tenantId: process.env.AZURE_TENANT_ID ?? configFile.tenantId ?? "common",
    clientId: process.env.AZURE_CLIENT_ID ?? configFile.clientId ?? DEFAULT_CLIENT_ID,
    cloud,
    defaultSubscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? configFile.defaultSubscriptionId,
    logLevel: (process.env.LOGICAPPS_MCP_LOG_LEVEL as LogicAppsMcpSettings["logLevel"]) ?? "info",
    cacheTtlSeconds: parseInt(process.env.LOGICAPPS_MCP_CACHE_TTL ?? "300", 10),
    capabilities,
  };
}
