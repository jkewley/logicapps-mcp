#!/usr/bin/env node

/**
 * MCP Server entry point.
 *
 * Supports two modes:
 * - stdio (default): For local MCP clients (Claude Desktop, VS Code Copilot)
 * - http: For cloud deployment (Azure Functions, standalone server)
 *
 * Usage:
 *   npx logicapps-mcp          # stdio mode (default)
 *   npx logicapps-mcp --http   # HTTP server mode
 *   npx logicapps-mcp --http --port 8080
 *   npx logicapps-mcp --allow execute,write   # opt in to non-read-only tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadSettings } from "./config/index.js";
import { setSettings, initializeAuth, enableAzureCliAuth } from "./auth/index.js";
import { setEnabledCapabilities, getEnabledCapabilities } from "./tools/capabilities.js";
import { setCacheTtl } from "./tools/index.js";
import { registerToolsAndPrompts } from "./server.js";
import { VERSION } from "./version.js";

/**
 * Run MCP server in stdio mode (for local MCP clients).
 */
async function runStdioMode(cliCapabilities: string[]): Promise<void> {
  const settings = await loadSettings({ cliCapabilities });
  setSettings(settings);
  setCacheTtl(settings.cacheTtlSeconds);
  setEnabledCapabilities(settings.capabilities);
  // Local stdio mode uses the signed-in Azure CLI identity (az login)
  enableAzureCliAuth(true);
  await initializeAuth();
  console.error(`Enabled capabilities: ${getEnabledCapabilities().join(", ")}`);

  const mcpServer = new McpServer(
    { name: "logicapps-mcp", version: VERSION },
    { capabilities: { tools: {}, prompts: {} } }
  );

  registerToolsAndPrompts(mcpServer);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  process.on("SIGINT", async () => {
    await mcpServer.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await mcpServer.close();
    process.exit(0);
  });
}

/**
 * Run MCP server in HTTP mode (for cloud deployment).
 */
async function runHttpMode(port: number, cliCapabilities: string[]): Promise<void> {
  // Dynamic import to avoid loading Express in stdio mode
  const { startHttpServer } = await import("./http/index.js");
  await startHttpServer(port, cliCapabilities);
}

/**
 * Parse command line arguments.
 */
function parseArgs(): { mode: "stdio" | "http"; port: number; allow: string[] } {
  const args = process.argv.slice(2);
  const isHttp = args.includes("--http");

  let port = 3000;
  const portIndex = args.indexOf("--port");
  if (portIndex !== -1 && args[portIndex + 1]) {
    port = parseInt(args[portIndex + 1], 10);
  }

  // Also check MCP_PORT env var (for Azure Functions)
  if (process.env.MCP_PORT) {
    port = parseInt(process.env.MCP_PORT, 10);
  }

  // --allow execute,write  or  --allow=all  (repeatable)
  const allow: string[] = [];
  args.forEach((arg, i) => {
    if (arg === "--allow" && args[i + 1]) {
      allow.push(...args[i + 1].split(","));
    } else if (arg.startsWith("--allow=")) {
      allow.push(...arg.slice("--allow=".length).split(","));
    }
  });

  return {
    mode: isHttp ? "http" : "stdio",
    port,
    allow,
  };
}

async function main(): Promise<void> {
  const { mode, port, allow } = parseArgs();

  if (mode === "http") {
    await runHttpMode(port, allow);
  } else {
    await runStdioMode(allow);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
