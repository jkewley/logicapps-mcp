import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConnection, testConnection } from "./connections.js";
import { setEnabledCapabilities } from "./capabilities.js";
import { armRequest, fetchWithRetry } from "../utils/http.js";

// Mock the http module
vi.mock("../utils/http.js", () => ({
  armRequest: vi.fn(),
  fetchWithRetry: vi.fn(),
}));

// Mock the token manager
vi.mock("../auth/tokenManager.js", () => ({
  getAccessToken: vi.fn().mockResolvedValue("mock-token"),
}));

// Mock the clouds config
vi.mock("../config/clouds.js", () => ({
  getCloudEndpoints: vi.fn().mockReturnValue({
    resourceManager: "https://management.azure.com",
  }),
}));

describe("connections", () => {
  describe("createConnection validation", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    // Parameterized tests for empty/whitespace validation
    const emptyFieldCases = [
      { field: "subscriptionId", args: ["", "rg", "conn", "azureblob", "westus2"] as const, error: "subscriptionId is required" },
      { field: "subscriptionId (whitespace)", args: ["   ", "rg", "conn", "azureblob", "westus2"] as const, error: "subscriptionId is required" },
      { field: "resourceGroupName", args: ["sub-123", "", "conn", "azureblob", "westus2"] as const, error: "resourceGroupName is required" },
      { field: "connectionName", args: ["sub-123", "rg", "", "azureblob", "westus2"] as const, error: "connectionName is required" },
      { field: "connectorName", args: ["sub-123", "rg", "conn", "", "westus2"] as const, error: "connectorName is required" },
      { field: "location", args: ["sub-123", "rg", "conn", "azureblob", ""] as const, error: "location is required" },
    ];

    it.each(emptyFieldCases)("should throw error when $field is empty", async ({ args, error }) => {
      await expect(createConnection(args[0], args[1], args[2], args[3], args[4])).rejects.toThrow(error);
    });

    // Parameterized tests for invalid connectionName formats
    const invalidNameCases = [
      { name: "-invalid", desc: "starts with hyphen" },
      { name: "_invalid", desc: "starts with underscore" },
      { name: "conn@name", desc: "contains @" },
      { name: "conn.name", desc: "contains ." },
      { name: "conn name", desc: "contains space" },
    ];

    it.each(invalidNameCases)("should throw error when connectionName $desc", async ({ name }) => {
      await expect(
        createConnection("sub-123", "rg", name, "azureblob", "westus2")
      ).rejects.toThrow("connectionName must start with a letter or number");
    });

    it("should throw error when connectionName exceeds 80 characters", async () => {
      await expect(
        createConnection("sub-123", "rg", "a".repeat(81), "azureblob", "westus2")
      ).rejects.toThrow("connectionName must be 80 characters or less");
    });

    // Parameterized tests for valid connectionName formats
    const validNameCases = [
      { name: "validname", desc: "letters only" },
      { name: "conn123", desc: "with numbers" },
      { name: "123conn", desc: "starting with number" },
      { name: "my-conn_1", desc: "with hyphens and underscores" },
      { name: "a".repeat(80), desc: "at exactly 80 characters" },
    ];

    it.each(validNameCases)("should accept valid connectionName $desc", async ({ name }) => {
      const { armRequest } = await import("../utils/http.js");
      vi.mocked(armRequest).mockResolvedValueOnce({
        id: `/subscriptions/sub-123/resourceGroups/rg/providers/Microsoft.Web/connections/${name}`,
        name,
        location: "westus2",
        properties: { displayName: name, statuses: [{ status: "Connected" }] },
      });

      const result = await createConnection("sub-123", "rg", name, "azureblob", "westus2");
      expect(result.connectionName).toBe(name);
    });
  });

  describe("testConnection", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(armRequest).mockResolvedValue({
        id: "/c",
        name: "conn",
        location: "westus",
        properties: {
          displayName: "conn",
          overallStatus: "Error",
          statuses: [{ status: "Unknown" }],
          api: { name: "office365", displayName: "Office 365", id: "/apis/office365" },
          testLinks: [{ requestUri: "/subscriptions/s/test", method: "POST" }],
        },
      });
    });

    it("skips the live probe unless 'connector' is enabled", async () => {
      setEnabledCapabilities([]);
      const result = await testConnection("s", "rg", "conn");
      expect(fetchWithRetry).not.toHaveBeenCalled();
      expect(result.isValid).toBe(false);
      expect(result.note).toContain("connector");
    });

    it("runs the live probe when 'connector' is enabled", async () => {
      setEnabledCapabilities(["connector"]);
      vi.mocked(fetchWithRetry).mockResolvedValue({ ok: true, status: 200 } as Response);
      const result = await testConnection("s", "rg", "conn");
      expect(fetchWithRetry).toHaveBeenCalledWith(
        "https://management.azure.com/subscriptions/s/test",
        expect.objectContaining({ method: "POST" })
      );
      expect(result.isValid).toBe(true);
      setEnabledCapabilities([]);
    });
  });
});
