/**
 * Capability-based access policy for tools.
 *
 * The server is read-only by default. Tools that execute workflows, modify
 * Azure resources, call live connectors, or reveal secrets must be explicitly
 * enabled via LOGICAPPS_MCP_CAPABILITIES, the --allow CLI flag, or the
 * "capabilities" array in ~/.logicapps-mcp/config.json.
 */

import { McpError } from "../utils/errors.js";

export type Capability = "read" | "execute" | "write" | "connector" | "secrets";

export const OPT_IN_CAPABILITIES: readonly Exclude<Capability, "read">[] = [
  "execute",
  "write",
  "connector",
  "secrets",
];

export const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
  read: "Read-only inspection of resources, definitions, and run history (always enabled)",
  execute: "Start, resubmit, or cancel workflow runs (run_trigger, resubmit_run, cancel_run)",
  write:
    "Create, update, delete, enable, disable, or clone workflows and create API connections",
  connector:
    "Make live calls through API connections (invoke_connector_operation, active test_connection probes)",
  secrets: "Return signed secrets such as trigger callback URLs (get_trigger_callback_url)",
};

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolPolicy {
  capability: Capability;
  annotations: ToolAnnotations;
}

const READ: ToolPolicy = {
  capability: "read",
  annotations: { readOnlyHint: true, openWorldHint: true },
};
const LOCAL_READ: ToolPolicy = {
  capability: "read",
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/**
 * Every tool must be classified. definitions.test.ts enforces this.
 */
export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  // Discovery / definitions
  check_setup: READ,
  list_subscriptions: READ,
  list_logic_apps: READ,
  list_workflows: READ,
  get_host_status: READ,
  get_workflow_definition: READ,
  get_workflow_triggers: READ,
  get_workflow_swagger: READ,
  list_workflow_versions: READ,
  get_workflow_version: READ,
  // Run history / diagnostics
  list_run_history: READ,
  get_run_details: READ,
  get_run_actions: READ,
  get_action_io: READ,
  search_runs: READ,
  analyze_run_failures: READ,
  extract_run_test_data: READ,
  get_trigger_history: READ,
  get_action_repetitions: READ,
  get_scope_repetitions: READ,
  get_action_request_history: READ,
  get_expression_traces: READ,
  // Connections (metadata only; test_connection only probes when connector is enabled)
  get_connections: READ,
  get_connection_details: READ,
  test_connection: READ,
  get_connector_swagger: READ,
  validate_clone_workflow: READ,
  // Knowledge
  get_troubleshooting_guide: LOCAL_READ,
  get_authoring_guide: LOCAL_READ,
  get_reference: LOCAL_READ,
  get_workflow_instructions: LOCAL_READ,
  // Secrets
  get_trigger_callback_url: {
    capability: "secrets",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  // Execute
  run_trigger: {
    capability: "execute",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  resubmit_run: {
    capability: "execute",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  cancel_run: {
    capability: "execute",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  // Write
  create_workflow: {
    capability: "write",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  update_workflow: {
    capability: "write",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  delete_workflow: {
    capability: "write",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  enable_workflow: {
    capability: "write",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  disable_workflow: {
    capability: "write",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  clone_workflow: {
    capability: "write",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  create_connection: {
    capability: "write",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  // Connector execution
  invoke_connector_operation: {
    capability: "connector",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
};

let enabledCapabilities = new Set<Capability>(["read"]);

/**
 * Parse a list of capability names (e.g. from env var, CLI, or config file).
 * Accepts "all" and "read-only"/"none". Throws on unknown values.
 */
export function parseCapabilities(input: string | string[] | undefined): Set<Capability> {
  const result = new Set<Capability>(["read"]);
  if (input === undefined) return result;
  const items = (Array.isArray(input) ? input : input.split(","))
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => s.length > 0);

  for (const item of items) {
    if (item === "all") {
      OPT_IN_CAPABILITIES.forEach((c) => result.add(c));
    } else if (item === "read" || item === "read-only" || item === "readonly" || item === "none") {
      // read is always enabled
    } else if ((OPT_IN_CAPABILITIES as readonly string[]).includes(item)) {
      result.add(item as Capability);
    } else {
      throw new Error(
        `Unknown capability '${item}'. Valid values: ${["read", ...OPT_IN_CAPABILITIES, "all"].join(", ")}`
      );
    }
  }
  return result;
}

export function setEnabledCapabilities(capabilities: Iterable<Capability>): void {
  enabledCapabilities = new Set<Capability>(["read", ...capabilities]);
}

export function getEnabledCapabilities(): Capability[] {
  return [...enabledCapabilities];
}

export function isCapabilityEnabled(capability: Capability): boolean {
  return enabledCapabilities.has(capability);
}

export function getToolCapability(toolName: string): Capability | undefined {
  return TOOL_POLICIES[toolName]?.capability;
}

export function isToolEnabled(toolName: string): boolean {
  const capability = getToolCapability(toolName);
  return capability !== undefined && enabledCapabilities.has(capability);
}

export function getToolAnnotations(toolName: string): ToolAnnotations | undefined {
  return TOOL_POLICIES[toolName]?.annotations;
}

/**
 * Throw a descriptive error if the tool is not allowed under the current policy.
 */
export function assertToolAllowed(toolName: string): void {
  const capability = getToolCapability(toolName);
  if (capability === undefined) {
    throw new McpError("InvalidTool", `Unknown tool: ${toolName}`);
  }
  if (!enabledCapabilities.has(capability)) {
    throw new McpError(
      "CapabilityDisabled",
      `Tool '${toolName}' requires the '${capability}' capability, which is disabled. ` +
        `This server is read-only by default. To opt in, set LOGICAPPS_MCP_CAPABILITIES=${capability} ` +
        `(comma-separated, or 'all'), pass --allow ${capability}, or add "${capability}" to ` +
        `"capabilities" in ~/.logicapps-mcp/config.json.`,
      { capability, enabledCapabilities: getEnabledCapabilities() }
    );
  }
}
