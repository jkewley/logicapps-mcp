import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectCallReferences,
  resolveValue,
  parseConsumptionWorkflowId,
  parseTriggerUrl,
  discoverCallGraph,
  MAX_SCOPED_APPS,
} from "./callGraph.js";
import { McpError } from "../utils/errors.js";

vi.mock("../utils/http.js", () => ({
  armRequest: vi.fn(),
  armRequestAllPages: vi.fn(),
  vfsReadJson: vi.fn(),
  workflowMgmtRequest: vi.fn(),
}));
vi.mock("../tools/shared.js", () => ({
  detectLogicAppSku: vi.fn(),
  getStandardAppAccess: vi.fn(),
}));

const SUB = "sub-1";
const wfId = (rg: string, name: string) =>
  `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Logic/workflows/${name}`;

describe("collectCallReferences", () => {
  it("walks nested scopes, conditions, switches and loops", () => {
    const refs = collectCallReferences({
      actions: {
        Top: { type: "Workflow", inputs: { host: { workflow: { id: "a" } } } },
        Scope: {
          type: "Scope",
          actions: { InScope: { type: "Http", inputs: { uri: "https://x/y" } } },
        },
        Cond: {
          type: "If",
          actions: { Yes: { type: "Workflow", inputs: { host: { workflow: { id: "b" } } } } },
          else: { actions: { No: { type: "Workflow", inputs: { host: { workflow: { id: "c" } } } } } },
        },
        Sw: {
          type: "Switch",
          cases: { C1: { actions: { Case: { type: "Workflow", inputs: { host: { workflow: { id: "d" } } } } } } },
          default: { actions: { Def: { type: "Workflow", inputs: { host: { workflow: { id: "e" } } } } } },
        },
        Loop: {
          type: "Foreach",
          actions: { Inner: { type: "Until", actions: { Deep: { type: "workflow", inputs: { host: { workflow: { id: "f" } } } } } } },
        },
        Other: { type: "Compose", inputs: { value: "x" } },
      },
    });
    expect(refs.map((r) => `${r.action}:${r.value}`).sort()).toEqual(
      ["Case:d", "Deep:f", "Def:e", "InScope:https://x/y", "No:c", "Top:a", "Yes:b"].sort()
    );
  });

  it("handles missing definitions", () => {
    expect(collectCallReferences(undefined)).toEqual([]);
  });
});

describe("resolveValue", () => {
  it("returns literals and resolves @parameters()", () => {
    expect(resolveValue("/subscriptions/x", {})).toBe("/subscriptions/x");
    expect(resolveValue("@parameters('child')", { child: "/subscriptions/y" })).toBe("/subscriptions/y");
    expect(resolveValue("@{parameters('child')}", { child: "v" })).toBe("v");
  });

  it("returns undefined for dynamic expressions", () => {
    expect(resolveValue("@concat('a', 'b')", {})).toBeUndefined();
    expect(resolveValue("@parameters('missing')", {})).toBeUndefined();
    expect(resolveValue("https://x/@{variables('v')}", {})).toBeUndefined();
  });
});

describe("parsers", () => {
  it("parses Consumption workflow IDs", () => {
    expect(parseConsumptionWorkflowId(wfId("rg", "child"))).toEqual({
      subscriptionId: SUB,
      resourceGroupName: "rg",
      logicAppName: "child",
    });
    expect(parseConsumptionWorkflowId("/subscriptions/x/resourceGroups/y/providers/Microsoft.Web/sites/z")).toBeUndefined();
  });

  it("recognizes Logic App trigger URLs", () => {
    expect(
      parseTriggerUrl("https://prod-01.eastus.logic.azure.com:443/workflows/ABC123/triggers/manual/paths/invoke?sig=x")
    ).toEqual({ kind: "consumption", workflowId: "abc123" });
    expect(parseTriggerUrl("https://my-site.azurewebsites.net/api/wf1/triggers/When_a_HTTP_request/invoke")).toEqual({
      kind: "standard",
      host: "my-site.azurewebsites.net",
    });
    expect(parseTriggerUrl("https://api.contoso.com/orders")).toBeUndefined();
    expect(parseTriggerUrl("not a url")).toBeUndefined();
  });
});

describe("discoverCallGraph", () => {
  const consumption: Record<string, { definition: unknown; parameters?: Record<string, { value: unknown }> }> = {};

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const k of Object.keys(consumption)) delete consumption[k];
    const http = await import("../utils/http.js");
    const shared = await import("../tools/shared.js");
    vi.mocked(shared.detectLogicAppSku).mockImplementation(async (_s, rg, name) => {
      if (consumption[`${rg}/${name}`.toLowerCase()]) return "consumption";
      if (name === "std-app") return "standard";
      throw new McpError("ResourceNotFound", `Logic App '${name}' not found`);
    });
    vi.mocked(http.armRequest).mockImplementation(async (path: string) => {
      const m = /resourceGroups\/([^/]+)\/providers\/Microsoft\.Logic\/workflows\/([^/]+)$/.exec(path)!;
      const wf = consumption[`${m[1]}/${m[2]}`.toLowerCase()];
      return { properties: { definition: wf.definition, parameters: wf.parameters } };
    });
    vi.mocked(http.armRequestAllPages).mockImplementation(async (path: string) => {
      if (path.endsWith("Microsoft.Logic/workflows")) {
        return [
          {
            id: wfId("rg-b", "http-child"),
            name: "http-child",
            properties: { accessEndpoint: "https://prod-01.eastus.logic.azure.com:443/workflows/HTTPCHILDID" },
          },
        ];
      }
      return [
        {
          id: `/subscriptions/${SUB}/resourceGroups/rg-std/providers/Microsoft.Web/sites/std-app`,
          name: "std-app",
          kind: "functionapp,workflowapp",
          properties: { defaultHostName: "std-app.azurewebsites.net" },
        },
      ];
    });
    vi.mocked(shared.getStandardAppAccess).mockResolvedValue({ hostname: "std-app.azurewebsites.net", masterKey: "k" });
    vi.mocked(http.workflowMgmtRequest).mockResolvedValue([{ name: "wf1" }, { name: "wf2" }]);
    vi.mocked(http.vfsReadJson).mockImplementation(async (_h: string, path: string) => {
      if (path.endsWith("parameters.json")) return { childId: { value: wfId("rg-a", "grandchild") } };
      if (path.endsWith("connections.json")) {
        return { managedApiConnections: { sb: { connection: { id: "/Subscriptions/S/resourceGroups/rg-std/providers/Microsoft.Web/connections/SB" } } } };
      }
      if (path.includes("/wf1/")) {
        return {
          definition: {
            actions: {
              CallSibling: { type: "Workflow", inputs: { host: { workflow: { id: "wf2" } } } },
              CallConsumption: { type: "Workflow", inputs: { host: { workflow: { id: "@parameters('childId')" } } } },
            },
          },
        };
      }
      return { definition: { actions: {} } };
    });
  });

  const add = (rg: string, name: string, actions: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    consumption[`${rg}/${name}`.toLowerCase()] = { definition: { actions, ...extra } };
  };

  it("follows Workflow actions, HTTP trigger URLs and Standard apps transitively", async () => {
    add("rg-a", "root", {
      Child: { type: "Workflow", inputs: { host: { workflow: { id: wfId("rg-a", "child") } } } },
      CallHttp: {
        type: "Http",
        inputs: { uri: "https://prod-01.eastus.logic.azure.com/workflows/httpchildid/triggers/manual/paths/invoke?sig=s" },
      },
      CallStd: { type: "Http", inputs: { uri: "https://std-app.azurewebsites.net/api/wf1/triggers/manual/invoke" } },
      External: { type: "Http", inputs: { uri: "https://api.contoso.com/x" } },
      Dynamic: { type: "Workflow", inputs: { host: { workflow: { id: "@variables('target')" } } } },
    });
    consumption["rg-a/root"].parameters = {
      $connections: { value: { sql: { connectionId: wfId("rg-a", "x").replace("Logic/workflows/x", "Web/connections/sql") } } },
    };
    add("rg-a", "child", {
      Loop: { type: "Workflow", inputs: { host: { workflow: { id: wfId("rg-a", "root") } } } },
    });
    add("rg-b", "http-child", {});
    add("rg-a", "grandchild", {});

    const graph = await discoverCallGraph({ subscriptionId: SUB, resourceGroupName: "rg-a", logicAppName: "root" });

    expect(graph.apps.map((a) => `${a.resourceGroupName}/${a.logicAppName}:${a.sku}`)).toEqual([
      "rg-a/root:consumption",
      "rg-a/child:consumption",
      "rg-b/http-child:consumption",
      "rg-std/std-app:standard",
      "rg-a/grandchild:consumption",
    ]);
    expect(graph.apps[1].reason).toBe("called by root.Child");
    expect(graph.apps[4].reason).toBe("called by std-app/wf1.CallConsumption");
    expect(graph.unresolved).toEqual([
      expect.objectContaining({ from: "root", action: "Dynamic", reason: "Dynamic expression" }),
    ]);
    expect(graph.connectionIds).toContain(
      `/subscriptions/${SUB}/resourcegroups/rg-a/providers/microsoft.web/connections/sql`
    );
    expect(graph.connectionIds).toContain("/subscriptions/s/resourcegroups/rg-std/providers/microsoft.web/connections/sb");
    expect(graph.truncated).toBe(false);
  });

  it("uses parameter default values and records missing callees", async () => {
    add(
      "rg-a",
      "root",
      { Call: { type: "Workflow", inputs: { host: { workflow: { id: "@parameters('target')" } } } } },
      { parameters: { target: { defaultValue: wfId("rg-a", "gone") } } }
    );
    const graph = await discoverCallGraph({ subscriptionId: SUB, resourceGroupName: "rg-a", logicAppName: "root" });
    expect(graph.apps).toHaveLength(1);
    expect(graph.unresolved[0]).toMatchObject({ action: "Call", value: "rg-a/gone" });
  });

  it(`stops after ${MAX_SCOPED_APPS} apps`, async () => {
    for (let i = 0; i < MAX_SCOPED_APPS + 5; i++) {
      add("rg", `app${i}`, {
        Next: { type: "Workflow", inputs: { host: { workflow: { id: wfId("rg", `app${i + 1}`) } } } },
      });
    }
    const graph = await discoverCallGraph({ subscriptionId: SUB, resourceGroupName: "rg", logicAppName: "app0" });
    expect(graph.apps).toHaveLength(MAX_SCOPED_APPS);
    expect(graph.truncated).toBe(true);
  });

  it("propagates errors for the root app", async () => {
    await expect(
      discoverCallGraph({ subscriptionId: SUB, resourceGroupName: "rg", logicAppName: "missing" })
    ).rejects.toThrow("not found");
  });
});
