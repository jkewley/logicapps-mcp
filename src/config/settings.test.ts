import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadSettings } from "./settings.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

// Mock os
vi.mock("node:os", () => ({
  homedir: vi.fn(),
}));

describe("settings", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/home/testuser");
    // Reset environment variables
    delete process.env.AZURE_TENANT_ID;
    delete process.env.AZURE_CLIENT_ID;
    delete process.env.AZURE_SUBSCRIPTION_ID;
    delete process.env.AZURE_CLOUD;
    delete process.env.LOGICAPPS_MCP_LOG_LEVEL;
    delete process.env.LOGICAPPS_MCP_CACHE_TTL;
    delete process.env.LOGICAPPS_MCP_CAPABILITIES;
    delete process.env.AZURE_RESOURCE_GROUP;
    delete process.env.LOGIC_APP_NAME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("loadSettings", () => {
    it("should return default settings when no config file exists", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));

      const settings = await loadSettings();

      expect(settings.tenantId).toBe("common");
      expect(settings.clientId).toBe("04b07795-8ddb-461a-bbee-02f9e1bf7b46");
      expect(settings.cloud.name).toBe("AzurePublic");
      expect(settings.logLevel).toBe("info");
      expect(settings.cacheTtlSeconds).toBe(300);
    });

    it("should load settings from config file", async () => {
      const configFile = {
        tenantId: "my-tenant",
        clientId: "my-client-id",
        defaultSubscriptionId: "my-sub",
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(configFile));

      const settings = await loadSettings();

      expect(settings.tenantId).toBe("my-tenant");
      expect(settings.clientId).toBe("my-client-id");
      expect(settings.defaultSubscriptionId).toBe("my-sub");
    });

    it("should prefer environment variables over config file", async () => {
      process.env.AZURE_TENANT_ID = "env-tenant";
      process.env.AZURE_CLIENT_ID = "env-client";
      process.env.AZURE_SUBSCRIPTION_ID = "env-sub";

      const configFile = {
        tenantId: "config-tenant",
        clientId: "config-client",
        defaultSubscriptionId: "config-sub",
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(configFile));

      const settings = await loadSettings();

      expect(settings.tenantId).toBe("env-tenant");
      expect(settings.clientId).toBe("env-client");
      expect(settings.defaultSubscriptionId).toBe("env-sub");
    });

    it("should use custom cloud from config file", async () => {
      const customCloud = {
        name: "CustomCloud",
        authentication: {
          loginEndpoint: "https://custom.login.com",
          tokenAudience: "https://custom.api.com",
        },
        resourceManager: "https://custom.management.com",
        suffixes: {
          azureWebsites: ".custom.com",
        },
      };
      const configFile = { customCloud };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(configFile));

      const settings = await loadSettings();

      expect(settings.cloud).toEqual(customCloud);
    });

    it("should respect AZURE_CLOUD environment variable", async () => {
      process.env.AZURE_CLOUD = "AzureGovernment";
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));

      const settings = await loadSettings();

      expect(settings.cloud.name).toBe("AzureGovernment");
    });

    it("should parse LOGICAPPS_MCP_LOG_LEVEL environment variable", async () => {
      process.env.LOGICAPPS_MCP_LOG_LEVEL = "debug";
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));

      const settings = await loadSettings();

      expect(settings.logLevel).toBe("debug");
    });

    it("should parse LOGICAPPS_MCP_CACHE_TTL environment variable", async () => {
      process.env.LOGICAPPS_MCP_CACHE_TTL = "600";
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));

      const settings = await loadSettings();

      expect(settings.cacheTtlSeconds).toBe(600);
    });

    it("should default to read-only capabilities", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      expect((await loadSettings()).capabilities).toEqual(["read"]);
    });

    it("should apply capability precedence: CLI > env > config file", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ capabilities: ["secrets"] }));
      expect((await loadSettings()).capabilities.sort()).toEqual(["read", "secrets"]);

      process.env.LOGICAPPS_MCP_CAPABILITIES = "execute";
      expect((await loadSettings()).capabilities.sort()).toEqual(["execute", "read"]);

      expect((await loadSettings({ cliCapabilities: ["write"] })).capabilities.sort()).toEqual(["read", "write"]);
    });

    it("should reject invalid capabilities", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      process.env.LOGICAPPS_MCP_CAPABILITIES = "everything";
      await expect(loadSettings()).rejects.toThrow(/Unknown capability/);
    });

    it("should warn (not silently ignore) an invalid config file", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{not json");
      const settings = await loadSettings();
      expect(settings.warnings).toHaveLength(1);
      expect(settings.warnings[0]).toMatch(/not valid JSON/);
    });

    it("should not warn when the config file is absent", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
      const settings = await loadSettings();
      expect(settings.warnings).toEqual([]);
      expect(settings.capabilitySource).toBe("default");
    });

    it("should warn and fall back for invalid log level and cache TTL", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
      process.env.LOGICAPPS_MCP_LOG_LEVEL = "verbose";
      process.env.LOGICAPPS_MCP_CACHE_TTL = "abc";
      const settings = await loadSettings();
      expect(settings.logLevel).toBe("info");
      expect(settings.cacheTtlSeconds).toBe(300);
      expect(settings.warnings).toHaveLength(2);
    });

    it("should report the capability source", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ capabilities: ["write"] }));
      expect((await loadSettings()).capabilitySource).toBe("config");
      process.env.LOGICAPPS_MCP_CAPABILITIES = "execute";
      expect((await loadSettings()).capabilitySource).toBe("env");
      expect((await loadSettings({ cliCapabilities: ["all"] })).capabilitySource).toBe("cli");
    });
  });

  describe("resource scope", () => {
    beforeEach(() => {
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));
    });

    it("is unset by default", async () => {
      const settings = await loadSettings();
      expect(settings.resourceGroupName).toBeUndefined();
      expect(settings.logicAppName).toBeUndefined();
    });

    it("reads AZURE_RESOURCE_GROUP and LOGIC_APP_NAME", async () => {
      process.env.AZURE_RESOURCE_GROUP = " rg-orders ";
      process.env.LOGIC_APP_NAME = "la-orders";
      const settings = await loadSettings();
      expect(settings.resourceGroupName).toBe("rg-orders");
      expect(settings.logicAppName).toBe("la-orders");
    });

    it("prefers CLI over env over config file", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ resourceGroupName: "rg-config", logicAppName: "la-config" })
      );
      expect((await loadSettings()).resourceGroupName).toBe("rg-config");
      process.env.AZURE_RESOURCE_GROUP = "rg-env";
      expect((await loadSettings()).resourceGroupName).toBe("rg-env");
      const cli = await loadSettings({ cliResourceGroup: "rg-cli", cliLogicAppName: "la-cli" });
      expect(cli.resourceGroupName).toBe("rg-cli");
      expect(cli.logicAppName).toBe("la-cli");
    });

    it("warns and ignores invalid names", async () => {
      process.env.AZURE_RESOURCE_GROUP = "bad/rg";
      process.env.LOGIC_APP_NAME = "bad name?";
      const settings = await loadSettings();
      expect(settings.resourceGroupName).toBeUndefined();
      expect(settings.logicAppName).toBeUndefined();
      expect(settings.warnings).toHaveLength(2);
    });

    it("treats an empty AZURE_SUBSCRIPTION_ID as unset", async () => {
      process.env.AZURE_SUBSCRIPTION_ID = "  ";
      expect((await loadSettings()).defaultSubscriptionId).toBeUndefined();
    });
  });
});
