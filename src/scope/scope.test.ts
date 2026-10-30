import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setScope,
  applyScope,
  filterScopedResult,
  defaultableParams,
  describeScope,
  isScoped,
  resolveLogicAppScope,
} from "./scope.js";
import type { CallGraphResult } from "./callGraph.js";

vi.mock("../utils/http.js", () => ({ armRequestAllPages: vi.fn() }));
vi.mock("../tools/shared.js", () => ({ detectLogicAppSku: vi.fn() }));
vi.mock("./callGraph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./callGraph.js")>()),
  discoverCallGraph: vi.fn(),
}));

const SUB = "sub-1";
const app = (rg: string, name: string, subscriptionId = SUB) => ({
  subscriptionId,
  resourceGroupName: rg,
  logicAppName: name,
  sku: "consumption" as const,
  reason: "x",
});
const conn = (rg: string, name: string) =>
  `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Web/connections/${name}`.toLowerCase();

const GRAPH: CallGraphResult = {
  apps: [app("rg-a", "root"), app("rg-a", "child"), app("rg-b", "other-rg-child"), app("rg-x", "cross-sub", "sub-2")],
  connectionIds: [conn("rg-a", "sql")],
  connectionsUnknownFor: [],
  unresolved: [],
  truncated: false,
};

async function mocks() {
  const http = await import("../utils/http.js");
  const shared = await import("../tools/shared.js");
  const cg = await import("./callGraph.js");
  return { http, shared, cg };
}

describe("scope", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    setScope({});
    const { cg, shared } = await mocks();
    vi.mocked(cg.discoverCallGraph).mockResolvedValue(GRAPH);
    vi.mocked(shared.detectLogicAppSku).mockResolvedValue("consumption");
  });

  describe("unscoped", () => {
    it("passes args through and only fills the default subscription", async () => {
      expect(isScoped()).toBe(false);
      expect(await applyScope("list_workflows", { resourceGroupName: "rg", logicAppName: "x" })).toEqual({
        resourceGroupName: "rg",
        logicAppName: "x",
      });
      setScope({ subscriptionId: SUB });
      expect(await applyScope("list_logic_apps", {})).toEqual({ subscriptionId: SUB });
      expect(await applyScope("list_logic_apps", { subscriptionId: "other" })).toEqual({ subscriptionId: "other" });
      expect(await applyScope("get_reference", { topic: "x" })).toEqual({ topic: "x" });
      expect(describeScope()).toContain("unrestricted");
    });
  });

  describe("AZURE_RESOURCE_GROUP", () => {
    beforeEach(() => setScope({ subscriptionId: SUB, resourceGroupName: "rg-a" }));

    it("fills defaults", async () => {
      expect(await applyScope("list_workflows", { logicAppName: "anything" })).toEqual({
        subscriptionId: SUB,
        resourceGroupName: "rg-a",
        logicAppName: "anything",
      });
      expect(await applyScope("list_logic_apps", {})).toEqual({ subscriptionId: SUB, resourceGroupName: "rg-a" });
      expect(await applyScope("get_connections", {})).toEqual({ subscriptionId: SUB, resourceGroupName: "rg-a" });
    });

    it("is case-insensitive and rejects other resource groups and subscriptions", async () => {
      await expect(applyScope("list_workflows", { resourceGroupName: "RG-A", logicAppName: "x" })).resolves.toBeDefined();
      await expect(applyScope("list_workflows", { resourceGroupName: "rg-b", logicAppName: "x" })).rejects.toMatchObject({
        code: "OutOfScope",
      });
      await expect(applyScope("get_connections", { subscriptionId: "sub-2" })).rejects.toThrow("Subscription 'sub-2'");
    });

    it("restricts clone targets", async () => {
      const args = await applyScope("clone_workflow", { logicAppName: "src", targetLogicAppName: "dst" });
      expect(args.targetResourceGroupName).toBe("rg-a");
      await expect(
        applyScope("validate_clone_workflow", { logicAppName: "src", targetResourceGroupName: "rg-z", targetLogicAppName: "d" })
      ).rejects.toThrow("Target resource group");
      await expect(
        applyScope("clone_workflow", { logicAppName: "src", targetSubscriptionId: "sub-2", targetLogicAppName: "d" })
      ).rejects.toThrow("Target subscription");
    });

    it("filters list_logic_apps results", async () => {
      const result = await filterScopedResult("list_logic_apps", { subscriptionId: SUB }, {
        logicApps: [
          { name: "a", resourceGroup: "RG-A" },
          { name: "b", resourceGroup: "rg-b" },
        ],
      });
      expect(result).toEqual({ logicApps: [{ name: "a", resourceGroup: "RG-A" }] });
    });

    it("filters list_subscriptions to the configured subscription", async () => {
      const result = await filterScopedResult("list_subscriptions", {}, {
        subscriptions: [{ subscriptionId: SUB }, { subscriptionId: "sub-2" }],
      });
      expect(result).toEqual({ subscriptions: [{ subscriptionId: SUB }] });
    });

    it("relaxes required parameters in advertised schemas", () => {
      expect(defaultableParams("list_workflows", ["subscriptionId", "resourceGroupName", "logicAppName"])).toEqual([
        "subscriptionId",
        "resourceGroupName",
      ]);
      expect(defaultableParams("list_subscriptions", [])).toEqual([]);
    });
  });

  describe("AZURE_RESOURCE_GROUP without a subscription", () => {
    it("matches the resource group in any subscription", async () => {
      setScope({ resourceGroupName: "rg-a" });
      await expect(
        applyScope("list_workflows", { subscriptionId: "any", logicAppName: "x" })
      ).resolves.toMatchObject({ resourceGroupName: "rg-a" });
    });
  });

  describe("LOGIC_APP_NAME", () => {
    beforeEach(() => setScope({ subscriptionId: SUB, resourceGroupName: "rg-a", logicAppName: "root" }));

    it("defaults to the root app", async () => {
      expect(await applyScope("list_run_history", {})).toEqual({
        subscriptionId: SUB,
        resourceGroupName: "rg-a",
        logicAppName: "root",
      });
    });

    it("fills the resource group and subscription of called apps by name", async () => {
      setScope({ logicAppName: "root" });
      const { http } = await mocks();
      vi.mocked(http.armRequestAllPages).mockImplementation(async (path: string) => {
        if (path === "/subscriptions") return [{ subscriptionId: SUB }];
        if (path.includes("Microsoft.Logic")) return [{ id: `/subscriptions/${SUB}/resourceGroups/rg-a/x`, name: "ROOT" }];
        return [];
      });
      expect(await applyScope("get_workflow_definition", { logicAppName: "cross-sub" })).toEqual({
        subscriptionId: "sub-2",
        resourceGroupName: "rg-x",
        logicAppName: "cross-sub",
      });
    });

    it("uses a called app's own subscription even when AZURE_SUBSCRIPTION_ID is set", async () => {
      expect(await applyScope("list_run_history", { logicAppName: "cross-sub" })).toMatchObject({
        subscriptionId: "sub-2",
        resourceGroupName: "rg-x",
      });
      await expect(
        applyScope("list_run_history", { subscriptionId: SUB, logicAppName: "cross-sub" })
      ).rejects.toMatchObject({ code: "OutOfScope" });
    });

    it("rejects Logic Apps outside the call graph (after one refresh)", async () => {
      const { cg } = await mocks();
      await expect(applyScope("list_workflows", { logicAppName: "unrelated" })).rejects.toMatchObject({
        code: "OutOfScope",
      });
      expect(cg.discoverCallGraph).toHaveBeenCalledTimes(1); // refresh is rate-limited
    });

    it("allows called apps in other resource groups (AZURE_RESOURCE_GROUP only locates the root)", async () => {
      await expect(applyScope("list_workflows", { logicAppName: "other-rg-child" })).resolves.toMatchObject({
        resourceGroupName: "rg-b",
      });
      await expect(
        applyScope("list_workflows", { resourceGroupName: "rg-b", logicAppName: "root" })
      ).rejects.toThrow("Logic App 'rg-b/root' is out of scope");
      await expect(applyScope("get_connections", { resourceGroupName: "rg-b" })).resolves.toBeDefined();
      await expect(applyScope("get_connections", { resourceGroupName: "rg-z" })).rejects.toThrow(
        "does not contain any in-scope Logic App"
      );
    });

    it("limits connection tools to connections used by scoped apps", async () => {
      await expect(applyScope("get_connection_details", { connectionName: "sql" })).resolves.toBeDefined();
      await expect(applyScope("test_connection", { connectionName: "blob" })).rejects.toThrow("Connection 'blob'");

      const result = await filterScopedResult(
        "get_connections",
        { subscriptionId: SUB, resourceGroupName: "rg-a" },
        { connections: [{ id: conn("rg-a", "SQL").replace("sql", "SQL") }, { id: conn("rg-a", "blob") }] }
      );
      expect((result as { connections: unknown[] }).connections).toHaveLength(1);
    });

    it("requires clone targets to be in scope", async () => {
      await expect(
        applyScope("clone_workflow", { targetLogicAppName: "brand-new" })
      ).rejects.toThrow("Target Logic App 'rg-a/brand-new'");
    });

    it("filters list results to the call graph", async () => {
      const apps = await filterScopedResult("list_logic_apps", { subscriptionId: SUB }, {
        logicApps: [
          { name: "root", resourceGroup: "rg-a" },
          { name: "child", resourceGroup: "rg-a" },
          { name: "unrelated", resourceGroup: "rg-a" },
        ],
      });
      expect((apps as { logicApps: Array<{ name: string }> }).logicApps.map((a) => a.name)).toEqual(["root", "child"]);
      const subs = await filterScopedResult("list_subscriptions", {}, {
        subscriptions: [{ subscriptionId: SUB }, { subscriptionId: "sub-2" }, { subscriptionId: "sub-3" }],
      });
      expect((subs as { subscriptions: unknown[] }).subscriptions).toHaveLength(2);
    });

    it("makes app parameters optional in advertised schemas", () => {
      expect(
        defaultableParams("get_run_details", ["subscriptionId", "resourceGroupName", "logicAppName", "runId"]).sort()
      ).toEqual(["logicAppName", "resourceGroupName", "subscriptionId"]);
    });
  });

  describe("root resolution", () => {
    it("reports ambiguous names", async () => {
      setScope({ logicAppName: "dup" });
      const { http } = await mocks();
      vi.mocked(http.armRequestAllPages).mockImplementation(async (path: string) => {
        if (path === "/subscriptions") return [{ subscriptionId: "s1" }, { subscriptionId: "s2" }];
        if (path.includes("Microsoft.Logic")) return [{ id: "/subscriptions/x/resourceGroups/rg/p", name: "dup" }];
        return [];
      });
      await expect(resolveLogicAppScope()).rejects.toThrow("matches 2 Logic Apps");
    });

    it("reports missing apps", async () => {
      setScope({ subscriptionId: SUB, logicAppName: "nope" });
      const { http } = await mocks();
      vi.mocked(http.armRequestAllPages).mockResolvedValue([]);
      await expect(resolveLogicAppScope()).rejects.toThrow("was not found in subscription sub-1");
    });

    it("ignores non-workflow sites with the same name", async () => {
      setScope({ subscriptionId: SUB, logicAppName: "site" });
      const { http } = await mocks();
      vi.mocked(http.armRequestAllPages).mockImplementation(async (path: string) =>
        path.includes("Microsoft.Web") ? [{ id: "/subscriptions/x/resourceGroups/rg/p", name: "site", kind: "app" }] : []
      );
      await expect(resolveLogicAppScope()).rejects.toThrow("was not found");
    });

    it("caches the resolved graph", async () => {
      setScope({ subscriptionId: SUB, resourceGroupName: "rg-a", logicAppName: "root" });
      const { cg } = await mocks();
      await Promise.all([resolveLogicAppScope(), resolveLogicAppScope()]);
      await resolveLogicAppScope();
      expect(cg.discoverCallGraph).toHaveBeenCalledTimes(1);
    });
  });
});
