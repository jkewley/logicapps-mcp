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
 *   npx logicapps-mcp --check                 # verify setup (az login, access) and exit
 *   npx logicapps-mcp --resource-group my-rg  # scope tools to one resource group
 *   npx logicapps-mcp --logic-app my-app      # scope tools to one Logic App and the apps it calls
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadSettings } from "./config/index.js";
import { setSettings, initializeAuth, enableAzureCliAuth } from "./auth/index.js";
import { setEnabledCapabilities, getEnabledCapabilities } from "./tools/capabilities.js";
import { setCacheTtl } from "./tools/index.js";
import { registerToolsAndPrompts } from "./server.js";
import { runSetupChecks, formatSetupReport } from "./setup/checks.js";
import { VERSION } from "./version.js";
import { setScope, describeScope } from "./scope/scope.js";

interface CliOptions {
  allow: string[];
  resourceGroup?: string;
  logicApp?: string;
}

async function initLocal(cli: CliOptions, announce = true): Promise<void> {
  const settings = await loadSettings({
    cliCapabilities: cli.allow,
    cliResourceGroup: cli.resourceGroup,
    cliLogicAppName: cli.logicApp,
  });
  setSettings(settings);
  setCacheTtl(settings.cacheTtlSeconds);
  setEnabledCapabilities(settings.capabilities);
  setScope({
    subscriptionId: settings.defaultSubscriptionId,
    resourceGroupName: settings.resourceGroupName,
    logicAppName: settings.logicAppName,
  });
  // Local stdio mode uses the signed-in Azure CLI identity (az login)
  enableAzureCliAuth(true);
  if (announce) await initializeAuth();
}

/**
 * Run setup checks, print a report and exit (non-zero if any check failed).
 */
async function runCheckMode(cli: CliOptions): Promise<void> {
  await initLocal(cli, false);
  const report = await runSetupChecks();
  console.log(formatSetupReport(report));
  process.exit(report.ok ? 0 : 1);
}

/**
 * Run MCP server in stdio mode (for local MCP clients).
 */
async function runStdioMode(cli: CliOptions): Promise<void> {
  await initLocal(cli);
  console.error(`Enabled capabilities: ${getEnabledCapabilities().join(", ")}`);
  console.error(`Resource scope: ${describeScope()}`);

  const mcpServer = new McpServer(
    { name: "logicapps-mcp", version: VERSION },
    { capabilities: { tools: {}, prompts: {}, logging: {} } }
  );

  registerToolsAndPrompts(mcpServer);

  const initialized = new Promise<void>((resolve) => {
    mcpServer.server.oninitialized = () => resolve();
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // Preflight checks run in the background so they never delay the MCP handshake.
  void reportStartupChecks(mcpServer, initialized);

  process.on("SIGINT", async () => {
    await mcpServer.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await mcpServer.close();
    process.exit(0);
  });
}

async function reportStartupChecks(mcpServer: McpServer, initialized: Promise<void>): Promise<void> {
  try {
    const report = await runSetupChecks();
    // stderr shows up in the client's MCP server output/log
    console.error(formatSetupReport(report));
    const problems = report.checks.filter((c) => c.status === "fail" || c.status === "warn");
    if (problems.length === 0) return;

    await initialized;
    await mcpServer.server.sendLoggingMessage({
      level: report.ok ? "warning" : "error",
      logger: "logicapps-mcp",
      data: {
        summary: report.summary,
        problems: problems.map((c) => ({
          check: c.title,
          message: c.message,
          remediation: c.remediation,
        })),
        hint: "Run the check_setup tool (or 'logicapps-mcp --check' in a terminal) after fixing.",
      },
    });
  } catch (error) {
    console.error("Setup check failed to run:", error);
  }
}

/**
 * Run MCP server in HTTP mode (for cloud deployment).
 */
async function runHttpMode(port: number, cli: CliOptions): Promise<void> {
  // Dynamic import to avoid loading Express in stdio mode
  const { startHttpServer } = await import("./http/index.js");
  await startHttpServer(port, cli.allow, {
    resourceGroup: cli.resourceGroup,
    logicApp: cli.logicApp,
  });
}

/**
 * Parse command line arguments.
 */
function parseArgs(): { mode: "stdio" | "http" | "check"; port: number; cli: CliOptions } {
  const args = process.argv.slice(2);
  const isHttp = args.includes("--http");
  const isCheck = args.includes("--check");

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

  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
    const eqArg = args.find((a) => a.startsWith(`${flag}=`));
    return eqArg?.slice(flag.length + 1);
  };

  return {
    mode: isCheck ? "check" : isHttp ? "http" : "stdio",
    port,
    cli: { allow, resourceGroup: valueOf("--resource-group"), logicApp: valueOf("--logic-app") },
  };
}

async function main(): Promise<void> {
  const { mode, port, cli } = parseArgs();

  if (mode === "check") {
    await runCheckMode(cli);
  } else if (mode === "http") {
    await runHttpMode(port, cli);
  } else {
    await runStdioMode(cli);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
