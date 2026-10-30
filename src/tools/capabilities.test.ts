import { describe, it, expect, afterEach } from "vitest";
import {
  parseCapabilities,
  setEnabledCapabilities,
  isToolEnabled,
  assertToolAllowed,
  getEnabledCapabilities,
} from "./capabilities.js";
import { McpError } from "../utils/errors.js";

describe("capabilities", () => {
  afterEach(() => setEnabledCapabilities([]));

  it("defaults to read-only", () => {
    expect([...parseCapabilities(undefined)]).toEqual(["read"]);
  });

  it("parses comma-separated values, arrays and 'all'", () => {
    expect([...parseCapabilities("execute, WRITE")].sort()).toEqual(["execute", "read", "write"]);
    expect([...parseCapabilities(["connector"])].sort()).toEqual(["connector", "read"]);
    expect([...parseCapabilities("all")].sort()).toEqual([
      "connector",
      "execute",
      "read",
      "secrets",
      "write",
    ]);
    expect([...parseCapabilities("read-only")]).toEqual(["read"]);
  });

  it("rejects unknown capabilities", () => {
    expect(() => parseCapabilities("execute,admin")).toThrow(/Unknown capability 'admin'/);
  });

  it("allows read tools and blocks gated tools by default", () => {
    setEnabledCapabilities([]);
    expect(getEnabledCapabilities()).toEqual(["read"]);
    expect(isToolEnabled("get_run_details")).toBe(true);
    expect(isToolEnabled("run_trigger")).toBe(false);
    expect(() => assertToolAllowed("get_run_details")).not.toThrow();
    try {
      assertToolAllowed("update_workflow");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).code).toBe("CapabilityDisabled");
      expect((e as McpError).message).toContain("--allow write");
    }
  });

  it("enables only the opted-in capability", () => {
    setEnabledCapabilities(["execute"]);
    expect(isToolEnabled("run_trigger")).toBe(true);
    expect(isToolEnabled("delete_workflow")).toBe(false);
    expect(isToolEnabled("get_trigger_callback_url")).toBe(false);
  });

  it("treats unknown tools as invalid", () => {
    expect(() => assertToolAllowed("nope")).toThrow(/Unknown tool/);
  });
});
