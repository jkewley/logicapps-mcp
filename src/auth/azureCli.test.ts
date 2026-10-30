/**
 * Tests for Azure CLI authentication module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exec } from "node:child_process";

// Mock child_process
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Import after mocking
const { getAzureCliToken, checkAzureCliAuth, classifyAzureCliError, getAzureCliAccount, getAzureCliVersion } =
  await import("./azureCli.js");

describe("azureCli", () => {
  const mockExec = vi.mocked(exec);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("getAzureCliToken", () => {
    it("should return token when Azure CLI returns valid response", async () => {
      const mockResponse = {
        accessToken: "mock-access-token",
        expiresOn: "2024-12-20T12:00:00Z",
        subscription: "sub-123",
        tenant: "tenant-456",
        tokenType: "Bearer",
      };

      mockExec.mockImplementation((_cmd: unknown, opts?: unknown, cb?: unknown) => {
        const callback = typeof opts === "function" ? opts : cb;
        if (typeof callback === "function") {
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: "" });
        }
        return {} as ReturnType<typeof exec>;
      });

      const token = await getAzureCliToken();

      expect(token.accessToken).toBe("mock-access-token");
      expect(token.subscription).toBe("sub-123");
      expect(token.tenant).toBe("tenant-456");
      expect(token.tokenType).toBe("Bearer");
      expect(token.expiresOn).toBeInstanceOf(Date);
    });

    it("should throw when Azure CLI is not installed", async () => {
      const error = new Error("ENOENT: command not found");
      mockExec.mockImplementation((_cmd: unknown, opts?: unknown, cb?: unknown) => {
        const callback = typeof opts === "function" ? opts : cb;
        if (typeof callback === "function") {
          callback(error, "", "");
        }
        return {} as ReturnType<typeof exec>;
      });

      await expect(getAzureCliToken()).rejects.toThrow("Azure CLI is not installed");
    });

    it("should throw when user is not logged in", async () => {
      const error = new Error("Please run 'az login' to setup account");
      mockExec.mockImplementation((_cmd: unknown, opts?: unknown, cb?: unknown) => {
        const callback = typeof opts === "function" ? opts : cb;
        if (typeof callback === "function") {
          callback(error, "", "");
        }
        return {} as ReturnType<typeof exec>;
      });

      await expect(getAzureCliToken()).rejects.toThrow("Not logged in to Azure CLI");
    });

    it("should use custom resource when provided", async () => {
      const mockResponse = {
        accessToken: "mock-token",
        expiresOn: "2024-12-20T12:00:00Z",
        subscription: "sub-123",
        tenant: "tenant-456",
        tokenType: "Bearer",
      };

      let capturedCommand = "";
      mockExec.mockImplementation((cmd: unknown, opts?: unknown, cb?: unknown) => {
        const callback = typeof opts === "function" ? opts : cb;
        capturedCommand = cmd as string;
        if (typeof callback === "function") {
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: "" });
        }
        return {} as ReturnType<typeof exec>;
      });

      await getAzureCliToken("https://vault.azure.net");

      expect(capturedCommand).toContain("--resource");
      expect(capturedCommand).toContain("https://vault.azure.net");
    });
  });

  describe("checkAzureCliAuth", () => {
    it("should return loggedIn true when authenticated", async () => {
      const mockResponse = {
        accessToken: "mock-token",
        expiresOn: "2024-12-20T12:00:00Z",
        subscription: "sub-123",
        tenant: "tenant-456",
        tokenType: "Bearer",
      };

      mockExec.mockImplementation((_cmd: unknown, opts?: unknown, cb?: unknown) => {
        const callback = typeof opts === "function" ? opts : cb;
        if (typeof callback === "function") {
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: "" });
        }
        return {} as ReturnType<typeof exec>;
      });

      const result = await checkAzureCliAuth();

      expect(result.loggedIn).toBe(true);
      expect(result.subscription).toBe("sub-123");
      expect(result.tenant).toBe("tenant-456");
      expect(result.error).toBeUndefined();
    });

    it("should return loggedIn false when not authenticated", async () => {
      const error = new Error("Please run 'az login'");
      mockExec.mockImplementation((_cmd: unknown, opts?: unknown, cb?: unknown) => {
        const callback = typeof opts === "function" ? opts : cb;
        if (typeof callback === "function") {
          callback(error, "", "");
        }
        return {} as ReturnType<typeof exec>;
      });

      const result = await checkAzureCliAuth();

      expect(result.loggedIn).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("classifyAzureCliError", () => {
    it.each([
      [{ code: 127, message: "Command failed", stderr: "/bin/sh: 1: az: not found" }, /not installed or not on PATH/],
      [{ code: 1, message: "Command failed", stderr: "'az' is not recognized as an internal or external command" }, /not installed/],
      [{ code: "ENOENT", message: "spawn az ENOENT" }, /not installed/],
      [{ killed: true, message: "Command failed" }, /did not respond in time/],
      [{ code: 1, message: "Command failed", stderr: "AADSTS70043: The refresh token has expired" }, /expired or requires re-authentication/],
      [{ code: 1, message: "Command failed", stderr: "ERROR: Please run 'az login' to setup account." }, /Not logged in.*az login/],
      [{ code: 1, message: "something else" }, /Failed to get token from Azure CLI: something else/],
    ])("classifies %o", (error, expected) => {
      const result = classifyAzureCliError(error);
      expect(result.code).toBe("AuthenticationError");
      expect(result.message).toMatch(expected);
    });
  });

  describe("account and version", () => {
    function respond(stdout: string) {
      mockExec.mockImplementation((_cmd: unknown, _opts: unknown, callback?: unknown) => {
        const cb = typeof _opts === "function" ? _opts : callback;
        if (typeof cb === "function") cb(null, { stdout, stderr: "" });
        return {} as ReturnType<typeof exec>;
      });
    }

    it("parses az account show", async () => {
      respond(JSON.stringify({ id: "s1", name: "Dev", tenantId: "t1", environmentName: "AzureCloud", user: { name: "u@x", type: "user" } }));
      expect(await getAzureCliAccount()).toEqual({
        user: "u@x",
        userType: "user",
        tenantId: "t1",
        subscriptionId: "s1",
        subscriptionName: "Dev",
        environmentName: "AzureCloud",
      });
      expect(String(mockExec.mock.calls[0][0])).toBe("az account show --output json");
    });

    it("parses az version", async () => {
      respond(JSON.stringify({ "azure-cli": "2.67.0", extensions: {} }));
      expect(await getAzureCliVersion()).toBe("2.67.0");
    });
  });
});
