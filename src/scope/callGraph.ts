/**
 * Discovers which Logic Apps a given Logic App calls, by walking workflow definitions.
 *
 * Detected call patterns:
 * - Built-in "Workflow" actions (Consumption: child Logic App resource ID; Standard: a workflow in the same app)
 * - HTTP actions whose URI is a Logic App trigger endpoint
 *   (Consumption: https://prod-NN.<region>.logic.azure.com/workflows/<id>/triggers/...,
 *    Standard: https://<site>.azurewebsites.net/api/<workflow>/triggers/...)
 *
 * Values may be literals or a single @parameters('name') reference that can be resolved
 * from workflow parameter values/defaults. Anything else is reported as unresolved.
 */

import { armRequest, armRequestAllPages, vfsReadJson, workflowMgmtRequest } from "../utils/http.js";
import { detectLogicAppSku, getStandardAppAccess } from "../tools/shared.js";
import { McpError } from "../utils/errors.js";

export interface LogicAppRef {
  subscriptionId: string;
  resourceGroupName: string;
  logicAppName: string;
}

export interface ScopedLogicApp extends LogicAppRef {
  sku: "consumption" | "standard";
  /** "root" or "called by <app>/<workflow>.<action>" */
  reason: string;
}

export interface UnresolvedCall {
  from: string;
  action: string;
  value: string;
  reason: string;
}

export interface CallGraphResult {
  apps: ScopedLogicApp[];
  /** Lower-cased ARM IDs of API connections referenced by scoped apps (when known). */
  connectionIds: string[];
  /** Apps whose connection references could not be read (connection filtering is skipped for their RG). */
  connectionsUnknownFor: LogicAppRef[];
  unresolved: UnresolvedCall[];
  truncated: boolean;
}

export const MAX_SCOPED_APPS = 25;

interface ActionLike {
  type?: string;
  inputs?: Record<string, unknown>;
  actions?: Record<string, ActionLike>;
  else?: { actions?: Record<string, ActionLike> };
  cases?: Record<string, { actions?: Record<string, ActionLike> }>;
  default?: { actions?: Record<string, ActionLike> };
}

interface DefinitionLike {
  parameters?: Record<string, { defaultValue?: unknown }>;
  actions?: Record<string, ActionLike>;
}

export interface CallReference {
  action: string;
  kind: "workflow" | "http";
  value: string;
}

/**
 * Recursively collect candidate call references from a definition's actions.
 */
export function collectCallReferences(definition: DefinitionLike | undefined): CallReference[] {
  const refs: CallReference[] = [];
  const visit = (actions: Record<string, ActionLike> | undefined) => {
    if (!actions) return;
    for (const [name, action] of Object.entries(actions)) {
      if (!action || typeof action !== "object") continue;
      const type = action.type?.toLowerCase();
      if (type === "workflow") {
        const host = action.inputs?.host as { workflow?: { id?: unknown } } | undefined;
        const id = host?.workflow?.id;
        if (typeof id === "string") refs.push({ action: name, kind: "workflow", value: id });
      } else if (type === "http") {
        const uri = action.inputs?.uri;
        if (typeof uri === "string") refs.push({ action: name, kind: "http", value: uri });
      }
      visit(action.actions);
      visit(action.else?.actions);
      visit(action.default?.actions);
      for (const c of Object.values(action.cases ?? {})) visit(c?.actions);
    }
  };
  visit(definition?.actions);
  return refs;
}

const PARAM_REF = /^@\{?parameters\('([^']+)'\)\}?$/;

/**
 * Resolve a literal or a single @parameters('x') reference to a string.
 */
export function resolveValue(
  value: string,
  parameterValues: Record<string, unknown>
): string | undefined {
  const trimmed = value.trim();
  const m = PARAM_REF.exec(trimmed);
  if (m) {
    const v = parameterValues[m[1]];
    return typeof v === "string" && !v.includes("@") ? v : undefined;
  }
  return trimmed.includes("@") ? undefined : trimmed;
}

const CONSUMPTION_ID =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Logic\/workflows\/([^/]+)$/i;

export function parseConsumptionWorkflowId(id: string): LogicAppRef | undefined {
  const m = CONSUMPTION_ID.exec(id.trim());
  return m ? { subscriptionId: m[1], resourceGroupName: m[2], logicAppName: m[3] } : undefined;
}

/** Recognize a Logic App trigger URL and return a lookup key. */
export function parseTriggerUrl(
  uri: string
): { kind: "consumption"; workflowId: string } | { kind: "standard"; host: string } | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".logic.azure.com") || host.endsWith(".logic.azure.us") || host.endsWith(".logic.azure.cn")) {
    const m = /\/workflows\/([^/]+)\/triggers\//i.exec(url.pathname);
    if (m) return { kind: "consumption", workflowId: m[1].toLowerCase() };
  }
  if (/\/api\/[^/]+\/triggers\//i.test(url.pathname)) {
    return { kind: "standard", host };
  }
  return undefined;
}

interface AppSnapshot {
  definitions: Array<{ workflow: string; definition: DefinitionLike; parameterValues: Record<string, unknown> }>;
  connectionIds?: string[];
}

function defaultsFrom(definition: DefinitionLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(definition.parameters ?? {})) {
    if (p && "defaultValue" in p) out[k] = p.defaultValue;
  }
  return out;
}

async function snapshotApp(ref: LogicAppRef, sku: "consumption" | "standard"): Promise<AppSnapshot> {
  const { subscriptionId: s, resourceGroupName: rg, logicAppName: app } = ref;

  if (sku === "consumption") {
    const wf = await armRequest<{
      properties: {
        definition: DefinitionLike;
        parameters?: Record<string, { value?: unknown }>;
      };
    }>(`/subscriptions/${s}/resourceGroups/${rg}/providers/Microsoft.Logic/workflows/${app}`, {
      queryParams: { "api-version": "2019-05-01" },
    });
    const values = defaultsFrom(wf.properties.definition);
    for (const [k, p] of Object.entries(wf.properties.parameters ?? {})) {
      if (p && "value" in p) values[k] = p.value;
    }
    const conns = values.$connections as Record<string, { connectionId?: string }> | undefined;
    return {
      definitions: [{ workflow: app, definition: wf.properties.definition, parameterValues: values }],
      connectionIds: Object.values(conns ?? {})
        .map((c) => c?.connectionId?.toLowerCase())
        .filter((c): c is string => !!c),
    };
  }

  const { hostname, masterKey } = await getStandardAppAccess(s, rg, app);
  const workflows = await workflowMgmtRequest<Array<{ name: string }>>(
    hostname,
    `/runtime/webhooks/workflow/api/management/workflows?api-version=2020-05-01-preview`,
    masterKey
  );
  const appParams =
    (await vfsReadJson<Record<string, { value?: unknown }>>(
      hostname,
      "/admin/vfs/site/wwwroot/parameters.json",
      masterKey
    ).catch(() => null)) ?? {};
  const definitions: AppSnapshot["definitions"] = [];
  for (const wf of workflows) {
    const file = await vfsReadJson<{ definition: DefinitionLike }>(
      hostname,
      `/admin/vfs/site/wwwroot/${wf.name}/workflow.json`,
      masterKey
    );
    if (!file?.definition) continue;
    const values = defaultsFrom(file.definition);
    for (const [k, p] of Object.entries(appParams)) {
      if (p && "value" in p) values[k] = p.value;
    }
    definitions.push({ workflow: wf.name, definition: file.definition, parameterValues: values });
  }

  let connectionIds: string[] | undefined;
  try {
    const connections = await vfsReadJson<{
      managedApiConnections?: Record<string, { connection?: { id?: string } }>;
    }>(hostname, "/admin/vfs/site/wwwroot/connections.json", masterKey);
    connectionIds = Object.values(connections?.managedApiConnections ?? {})
      .map((c) => c?.connection?.id?.toLowerCase())
      .filter((c): c is string => !!c);
  } catch {
    connectionIds = undefined;
  }
  return { definitions, connectionIds };
}

interface EndpointIndex {
  consumption: Map<string, LogicAppRef>;
  standard: Map<string, LogicAppRef>;
}

async function buildEndpointIndex(subscriptionId: string): Promise<EndpointIndex> {
  const index: EndpointIndex = { consumption: new Map(), standard: new Map() };
  const rgOf = (id: string) => /\/resourceGroups\/([^/]+)/i.exec(id)?.[1] ?? "";

  const workflows = await armRequestAllPages<{
    id: string;
    name: string;
    properties?: { accessEndpoint?: string };
  }>(`/subscriptions/${subscriptionId}/providers/Microsoft.Logic/workflows`, {
    "api-version": "2019-05-01",
  });
  for (const wf of workflows) {
    const m = /\/workflows\/([^/?]+)/i.exec(wf.properties?.accessEndpoint ?? "");
    if (m) {
      index.consumption.set(m[1].toLowerCase(), {
        subscriptionId,
        resourceGroupName: rgOf(wf.id),
        logicAppName: wf.name,
      });
    }
  }

  const sites = await armRequestAllPages<{
    id: string;
    name: string;
    kind?: string;
    properties?: { defaultHostName?: string; hostNames?: string[] };
  }>(`/subscriptions/${subscriptionId}/providers/Microsoft.Web/sites`, { "api-version": "2023-01-01" });
  for (const site of sites) {
    if (!site.kind?.toLowerCase().includes("workflowapp")) continue;
    const ref = { subscriptionId, resourceGroupName: rgOf(site.id), logicAppName: site.name };
    for (const h of [site.properties?.defaultHostName, ...(site.properties?.hostNames ?? [])]) {
      if (h) index.standard.set(h.toLowerCase(), ref);
    }
  }
  return index;
}

export function refKey(r: LogicAppRef): string {
  return `${r.subscriptionId}/${r.resourceGroupName}/${r.logicAppName}`.toLowerCase();
}

/**
 * Breadth-first discovery of the root app and every Logic App it (transitively) calls.
 */
export async function discoverCallGraph(root: LogicAppRef): Promise<CallGraphResult> {
  const apps: ScopedLogicApp[] = [];
  const unresolved: UnresolvedCall[] = [];
  const connectionIds = new Set<string>();
  const connectionsUnknownFor: LogicAppRef[] = [];
  const seen = new Set<string>();
  const indexes = new Map<string, Promise<EndpointIndex>>();
  let truncated = false;

  const rootSku = await detectLogicAppSku(root.subscriptionId, root.resourceGroupName, root.logicAppName);
  const queue: ScopedLogicApp[] = [{ ...root, sku: rootSku, reason: "root" }];
  seen.add(refKey(root));

  const enqueue = async (target: LogicAppRef, reason: string, from: string, action: string) => {
    const key = refKey(target);
    if (seen.has(key)) return;
    if (seen.size >= MAX_SCOPED_APPS) {
      truncated = true;
      return;
    }
    seen.add(key);
    try {
      const sku = await detectLogicAppSku(target.subscriptionId, target.resourceGroupName, target.logicAppName);
      queue.push({ ...target, sku, reason });
    } catch (error) {
      unresolved.push({
        from,
        action,
        value: `${target.resourceGroupName}/${target.logicAppName}`,
        reason: error instanceof McpError ? error.message : String(error),
      });
    }
  };

  while (queue.length > 0) {
    const app = queue.shift()!;
    apps.push(app);

    let snapshot: AppSnapshot;
    try {
      snapshot = await snapshotApp(app, app.sku);
    } catch (error) {
      if (app.reason === "root") throw error;
      unresolved.push({
        from: app.logicAppName,
        action: "*",
        value: app.logicAppName,
        reason: `Could not read definition: ${error instanceof Error ? error.message : String(error)}`,
      });
      connectionsUnknownFor.push(app);
      continue;
    }
    if (snapshot.connectionIds) snapshot.connectionIds.forEach((c) => connectionIds.add(c));
    else connectionsUnknownFor.push(app);

    for (const { workflow, definition, parameterValues } of snapshot.definitions) {
      const from = app.sku === "standard" ? `${app.logicAppName}/${workflow}` : app.logicAppName;
      for (const ref of collectCallReferences(definition)) {
        const resolved = resolveValue(ref.value, parameterValues);
        if (!resolved) {
          unresolved.push({ from, action: ref.action, value: ref.value, reason: "Dynamic expression" });
          continue;
        }
        const reason = `called by ${from}.${ref.action}`;

        if (ref.kind === "workflow") {
          const target = parseConsumptionWorkflowId(resolved);
          if (target) await enqueue(target, reason, from, ref.action);
          else if (app.sku === "standard") continue; // workflow in the same Standard app, already in scope
          else unresolved.push({ from, action: ref.action, value: ref.value, reason: "Unrecognized workflow ID" });
          continue;
        }

        const trigger = parseTriggerUrl(resolved);
        if (!trigger) continue; // ordinary HTTP call, not a Logic App
        let index = indexes.get(app.subscriptionId);
        if (!index) {
          index = buildEndpointIndex(app.subscriptionId);
          indexes.set(app.subscriptionId, index);
        }
        let target: LogicAppRef | undefined;
        try {
          const idx = await index;
          target =
            trigger.kind === "consumption"
              ? idx.consumption.get(trigger.workflowId)
              : idx.standard.get(trigger.host);
        } catch (error) {
          unresolved.push({
            from,
            action: ref.action,
            value: ref.value,
            reason: `Could not index Logic Apps: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        if (!target) {
          if (trigger.kind === "standard" && !/azurewebsites\.(net|us)$|chinacloudsites\.cn$/.test(trigger.host)) {
            continue; // not an App Service host; probably not a Logic App
          }
          unresolved.push({
            from,
            action: ref.action,
            value: resolved.split("?")[0],
            reason: "Logic App trigger URL not found in this subscription",
          });
          continue;
        }
        if (refKey(target) === refKey(app)) continue;
        await enqueue(target, reason, from, ref.action);
      }
    }
  }

  return { apps, connectionIds: [...connectionIds], connectionsUnknownFor, unresolved, truncated };
}
