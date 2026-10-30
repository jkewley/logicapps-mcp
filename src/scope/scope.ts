/**
 * Server-wide resource scope.
 *
 * AZURE_SUBSCRIPTION_ID  - default subscription; also a restriction when another scope is set
 * AZURE_RESOURCE_GROUP   - only Logic Apps / connections in this resource group
 * LOGIC_APP_NAME         - only this Logic App and the Logic Apps it (transitively) calls;
 *                          when set, AZURE_RESOURCE_GROUP/AZURE_SUBSCRIPTION_ID only locate this app
 */

import { McpError } from "../utils/errors.js";
import { armRequestAllPages } from "../utils/http.js";
import { detectLogicAppSku } from "../tools/shared.js";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import { getCallerCacheKey } from "../auth/tokenManager.js";
import { CallGraphResult, discoverCallGraph, LogicAppRef, refKey } from "./callGraph.js";

export interface ScopeConfig {
  subscriptionId?: string;
  resourceGroupName?: string;
  logicAppName?: string;
}

let config: ScopeConfig = {};
// Partitioned per caller (HTTP/Functions hosts serve multiple identities).
const resolved = new Map<string, { at: number; graph: CallGraphResult }>();
const inFlight = new Map<string, Promise<CallGraphResult>>();
const MAX_CALLERS = 100;

/** Re-resolve the call graph after this long, or sooner when a requested app is not found. */
export const SCOPE_CACHE_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;

export function setScope(next: ScopeConfig): void {
  config = {
    subscriptionId: next.subscriptionId || undefined,
    resourceGroupName: next.resourceGroupName || undefined,
    logicAppName: next.logicAppName || undefined,
  };
  resolved.clear();
  inFlight.clear();
}

export function getScope(): Readonly<ScopeConfig> {
  return config;
}

/** True when tools are restricted to a resource group or Logic App. */
export function isScoped(): boolean {
  return !!(config.resourceGroupName || config.logicAppName);
}

export function describeScope(): string {
  if (!isScoped()) {
    return config.subscriptionId
      ? `unrestricted (default subscription ${config.subscriptionId})`
      : "unrestricted";
  }
  const parts: string[] = [];
  if (config.logicAppName) parts.push(`Logic App '${config.logicAppName}' and the Logic Apps it calls`);
  if (config.resourceGroupName) parts.push(`resource group '${config.resourceGroupName}'`);
  if (config.subscriptionId) parts.push(`subscription ${config.subscriptionId}`);
  return parts.join(", ");
}

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function violation(message: string): McpError {
  return new McpError(
    "OutOfScope",
    `${message} This server is scoped to ${describeScope()} (set by AZURE_SUBSCRIPTION_ID / AZURE_RESOURCE_GROUP / LOGIC_APP_NAME).`
  );
}

async function findRoot(): Promise<LogicAppRef> {
  const name = config.logicAppName!;
  const rg = config.resourceGroupName;
  let subscriptions: string[];
  if (config.subscriptionId) {
    subscriptions = [config.subscriptionId];
  } else {
    const subs = await armRequestAllPages<{ subscriptionId: string }>("/subscriptions", {
      "api-version": "2022-12-01",
    });
    subscriptions = subs.map((s) => s.subscriptionId);
  }

  if (rg && subscriptions.length === 1) {
    await detectLogicAppSku(subscriptions[0], rg, name); // throws ResourceNotFound
    return { subscriptionId: subscriptions[0], resourceGroupName: rg, logicAppName: name };
  }

  const matches: LogicAppRef[] = [];
  for (const sub of subscriptions) {
    for (const [path, version, isSite] of [
      [`/subscriptions/${sub}/providers/Microsoft.Logic/workflows`, "2019-05-01", false],
      [`/subscriptions/${sub}/providers/Microsoft.Web/sites`, "2023-01-01", true],
    ] as const) {
      const items = await armRequestAllPages<{ id: string; name: string; kind?: string }>(path, {
        "api-version": version,
      });
      for (const item of items) {
        if (!eq(item.name, name)) continue;
        if (isSite && !item.kind?.toLowerCase().includes("workflowapp")) continue;
        const itemRg = /\/resourceGroups\/([^/]+)/i.exec(item.id)?.[1] ?? "";
        if (rg && !eq(itemRg, rg)) continue;
        matches.push({ subscriptionId: sub, resourceGroupName: itemRg, logicAppName: item.name });
      }
    }
  }
  if (matches.length === 0) {
    throw new McpError(
      "ResourceNotFound",
      `LOGIC_APP_NAME '${name}' was not found${rg ? ` in resource group '${rg}'` : ""} in ${
        config.subscriptionId ? `subscription ${config.subscriptionId}` : "any accessible subscription"
      }.`
    );
  }
  if (matches.length > 1) {
    throw new McpError(
      "InvalidParameter",
      `LOGIC_APP_NAME '${name}' matches ${matches.length} Logic Apps (${matches
        .map((m) => `${m.subscriptionId}/${m.resourceGroupName}`)
        .join(", ")}). Set AZURE_SUBSCRIPTION_ID and/or AZURE_RESOURCE_GROUP to disambiguate.`
    );
  }
  return matches[0];
}

/**
 * Resolve the Logic App scope (root + transitive callees). Cached.
 */
export async function resolveLogicAppScope(options: { refresh?: boolean } = {}): Promise<CallGraphResult> {
  if (!config.logicAppName) throw new Error("LOGIC_APP_NAME is not configured");
  const caller = getCallerCacheKey();
  const cached = resolved.get(caller);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < SCOPE_CACHE_MS && !(options.refresh && age > MIN_REFRESH_MS)) {
    return cached.graph;
  }
  let pending = inFlight.get(caller);
  if (!pending) {
    pending = (async () => {
      const graph = await discoverCallGraph(await findRoot());
      resolved.delete(caller);
      if (resolved.size >= MAX_CALLERS) resolved.delete(resolved.keys().next().value!);
      resolved.set(caller, { at: Date.now(), graph });
      return graph;
    })().finally(() => {
      inFlight.delete(caller);
    });
    inFlight.set(caller, pending);
  }
  return pending;
}

type Args = Record<string, unknown>;

const RG_LEVEL_TOOLS = new Set([
  "get_connections",
  "create_connection",
  "get_connection_details",
  "test_connection",
  "invoke_connector_operation",
]);
const CONNECTION_NAME_TOOLS = new Set(["get_connection_details", "test_connection", "invoke_connector_operation"]);
const SUBSCRIPTION_ONLY_TOOLS = new Set(["list_logic_apps", "get_connector_swagger"]);

/**
 * Parameters a tool may omit because the server scope supplies a default.
 * Used to relax `required` in advertised tool schemas.
 */
export function defaultableParams(toolName: string, properties: string[]): string[] {
  const out: string[] = [];
  const has = (p: string) => properties.includes(p);
  if (config.subscriptionId && has("subscriptionId")) out.push("subscriptionId");
  if (has("logicAppName") && config.logicAppName) {
    out.push("logicAppName");
    if (has("resourceGroupName")) out.push("resourceGroupName");
    if (has("subscriptionId") && !out.includes("subscriptionId")) out.push("subscriptionId");
  } else if (has("resourceGroupName") && config.resourceGroupName) {
    out.push("resourceGroupName");
  }
  if (toolName.endsWith("clone_workflow") && config.resourceGroupName) out.push("targetResourceGroupName");
  return out;
}

function inGraph(graph: CallGraphResult, ref: LogicAppRef): boolean {
  return graph.apps.some((a) => refKey(a) === refKey(ref));
}

/**
 * Fill scope defaults into tool arguments and reject calls outside the scope.
 * Returns a new args object.
 */
export async function applyScope(toolName: string, input: Args | undefined): Promise<Args> {
  const args: Args = { ...(input ?? {}) };
  const str = (k: string) => (typeof args[k] === "string" && args[k] ? (args[k] as string) : undefined);

  const userSub = str("subscriptionId");
  // Subscription default applies even when unscoped.
  if (!str("subscriptionId") && config.subscriptionId && toolTakes(toolName, "subscriptionId")) {
    args.subscriptionId = config.subscriptionId;
  }
  if (!isScoped()) return args;

  const takesApp = toolTakes(toolName, "logicAppName");
  const takesRg = toolTakes(toolName, "resourceGroupName");
  const takesSub = toolTakes(toolName, "subscriptionId");
  if (!takesSub && !takesRg && !takesApp) return args;

  let graph: CallGraphResult | undefined;
  if (config.logicAppName && (takesApp || takesRg || SUBSCRIPTION_ONLY_TOOLS.has(toolName))) {
    graph = await resolveLogicAppScope();
  }

  // Fill app defaults from the resolved graph.
  if (takesApp && graph) {
    if (!str("logicAppName")) args.logicAppName = graph.apps[0].logicAppName;
    const name = str("logicAppName")!;
    const candidates = graph.apps.filter(
      (a) =>
        eq(a.logicAppName, name) &&
        (!str("resourceGroupName") || eq(a.resourceGroupName, str("resourceGroupName"))) &&
        (!userSub || eq(a.subscriptionId, userSub))
    );
    if (candidates.length === 1) {
      args.resourceGroupName ??= candidates[0].resourceGroupName;
      if (!userSub) args.subscriptionId = candidates[0].subscriptionId;
    }
  } else if (takesRg && !str("resourceGroupName")) {
    if (config.resourceGroupName) {
      args.resourceGroupName = config.resourceGroupName;
    } else if (graph && RG_LEVEL_TOOLS.has(toolName)) {
      const rgs = [...new Set(graph.apps.map((a) => `${a.subscriptionId}|${a.resourceGroupName}`))];
      if (rgs.length === 1) {
        const [sub, rg] = rgs[0].split("|");
        args.resourceGroupName = rg;
        args.subscriptionId ??= sub;
      }
    }
  }
  if (!str("subscriptionId") && graph && takesSub) {
    const subs = [...new Set(graph.apps.map((a) => a.subscriptionId))];
    if (subs.length === 1) args.subscriptionId = subs[0];
  }

  // Enforcement
  const sub = str("subscriptionId");
  const rg = str("resourceGroupName");
  if (sub && config.subscriptionId && !eq(sub, config.subscriptionId) && !graph) {
    throw violation(`Subscription '${sub}' is out of scope.`);
  }
  // With LOGIC_APP_NAME, the resource group only locates the root app; callees may live elsewhere.
  const rgOnly = !!config.resourceGroupName && !config.logicAppName;
  if (rg && rgOnly && !eq(rg, config.resourceGroupName)) {
    throw violation(`Resource group '${rg}' is out of scope.`);
  }
  if (toolName === "list_logic_apps" && rgOnly && !rg) {
    args.resourceGroupName = config.resourceGroupName;
  }

  if (graph) {
    if (takesApp) {
      const name = str("logicAppName")!;
      if (!sub || !rg || !inGraph(graph, { subscriptionId: sub, resourceGroupName: rg, logicAppName: name })) {
        const fresh = await resolveLogicAppScope({ refresh: true });
        if (!sub || !rg || !inGraph(fresh, { subscriptionId: sub, resourceGroupName: rg, logicAppName: name })) {
          throw violation(`Logic App '${rg ? `${rg}/` : ""}${name}' is out of scope.`);
        }
      }
    } else if (takesRg && rg) {
      if (!graph.apps.some((a) => eq(a.resourceGroupName, rg) && (!sub || eq(a.subscriptionId, sub)))) {
        throw violation(`Resource group '${rg}' does not contain any in-scope Logic App.`);
      }
      const conn = str("connectionName");
      if (conn && CONNECTION_NAME_TOOLS.has(toolName) && sub) {
        assertConnectionInScope(graph, sub, rg, conn);
      }
    } else if (sub && !graph.apps.some((a) => eq(a.subscriptionId, sub))) {
      throw violation(`Subscription '${sub}' is out of scope.`);
    }
  }

  // Clone targets
  if (toolName === "clone_workflow" || toolName === "validate_clone_workflow") {
    const tSub = str("targetSubscriptionId") ?? sub;
    if (config.resourceGroupName && !str("targetResourceGroupName")) {
      args.targetResourceGroupName = config.resourceGroupName;
    }
    const tRg = str("targetResourceGroupName");
    if (config.subscriptionId && tSub && !eq(tSub, config.subscriptionId) && !graph) {
      throw violation(`Target subscription '${tSub}' is out of scope.`);
    }
    if (tRg && rgOnly && !eq(tRg, config.resourceGroupName)) {
      throw violation(`Target resource group '${tRg}' is out of scope.`);
    }
    const tApp = str("targetLogicAppName");
    if (graph && tSub && tRg && tApp && !inGraph(graph, { subscriptionId: tSub, resourceGroupName: tRg, logicAppName: tApp })) {
      throw violation(`Target Logic App '${tRg}/${tApp}' is out of scope.`);
    }
  }

  return args;
}

function connectionKnownFor(graph: CallGraphResult, sub: string, rg: string): boolean {
  return !graph.connectionsUnknownFor.some((a) => eq(a.subscriptionId, sub) && eq(a.resourceGroupName, rg));
}

function assertConnectionInScope(graph: CallGraphResult, sub: string, rg: string, name: string): void {
  if (!connectionKnownFor(graph, sub, rg)) return;
  const id = `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/connections/${name}`.toLowerCase();
  if (!graph.connectionIds.includes(id)) {
    throw violation(`Connection '${name}' is not used by any in-scope Logic App.`);
  }
}

/**
 * Remove out-of-scope entries from list results.
 */
export async function filterScopedResult(toolName: string, args: Args, result: unknown): Promise<unknown> {
  if (!isScoped() || !result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;

  if (toolName === "list_subscriptions" && Array.isArray(r.subscriptions)) {
    let allowed: (id: string) => boolean;
    if (config.logicAppName) {
      const graph = await resolveLogicAppScope();
      allowed = (id) => graph.apps.some((a) => eq(a.subscriptionId, id));
    } else if (config.subscriptionId) {
      allowed = (id) => eq(id, config.subscriptionId);
    } else {
      return result;
    }
    return {
      ...r,
      subscriptions: (r.subscriptions as Array<{ subscriptionId?: string }>).filter(
        (s) => !!s.subscriptionId && allowed(s.subscriptionId)
      ),
    };
  }

  if (toolName === "list_logic_apps" && Array.isArray(r.logicApps)) {
    let apps = r.logicApps as Array<{ name: string; resourceGroup: string }>;
    if (config.resourceGroupName && !config.logicAppName) apps = apps.filter((a) => eq(a.resourceGroup, config.resourceGroupName));
    if (config.logicAppName) {
      const graph = await resolveLogicAppScope();
      const sub = args.subscriptionId as string;
      apps = apps.filter((a) =>
        inGraph(graph, { subscriptionId: sub, resourceGroupName: a.resourceGroup, logicAppName: a.name })
      );
    }
    return { ...r, logicApps: apps };
  }

  if (toolName === "get_connections" && Array.isArray(r.connections) && config.logicAppName) {
    const graph = await resolveLogicAppScope();
    const sub = args.subscriptionId as string;
    const rg = args.resourceGroupName as string;
    if (!connectionKnownFor(graph, sub, rg)) return result;
    return {
      ...r,
      connections: (r.connections as Array<{ id?: string }>).filter(
        (c) => !!c.id && graph.connectionIds.includes(c.id.toLowerCase())
      ),
    };
  }

  return result;
}

const TOOL_PARAMS = new Map(
  TOOL_DEFINITIONS.map((d) => [d.name, new Set(Object.keys(d.inputSchema.properties ?? {}))])
);

function toolTakes(toolName: string, param: string): boolean {
  return TOOL_PARAMS.get(toolName)?.has(param) ?? false;
}
