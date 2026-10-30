import { describe, it, expect } from "vitest";
import { redactValue, redactString, truncatePayload, mapWithConcurrency, REDACTED } from "./redact.js";

describe("redact", () => {
  it("redacts sensitive keys recursively", () => {
    const stats = { redactedCount: 0 };
    const out = redactValue(
      {
        headers: { Authorization: "Bearer abc.def", "Content-Type": "application/json", Cookie: "a=b" },
        body: { user: "x", password: "p@ss", nested: [{ clientSecret: "s" }], partitionKey: "pk" },
      },
      stats
    );
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.Cookie).toBe(REDACTED);
    expect(out.headers["Content-Type"]).toBe("application/json");
    expect(out.body.password).toBe(REDACTED);
    expect(out.body.nested[0].clientSecret).toBe(REDACTED);
    expect(out.body.partitionKey).toBe("pk");
    expect(out.body.user).toBe("x");
    expect(stats.redactedCount).toBe(4);
  });

  it("scrubs SAS signatures, function keys, bearer tokens and connection string secrets", () => {
    expect(redactString("https://x.blob.core.windows.net/c?sv=1&sig=abc%3D&se=2")).toBe(
      `https://x.blob.core.windows.net/c?sv=1&sig=${REDACTED}&se=2`
    );
    expect(redactString("https://f.azurewebsites.net/api/x?code=KEY123")).toBe(
      `https://f.azurewebsites.net/api/x?code=${REDACTED}`
    );
    expect(redactString("auth: Bearer eyJ0eXAi.abc-def")).toBe(`auth: Bearer ${REDACTED}`);
    expect(
      redactString("DefaultEndpointsProtocol=https;AccountName=a;AccountKey=xyz==;EndpointSuffix=core")
    ).toBe(`DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${REDACTED};EndpointSuffix=core`);
  });

  it("keeps error and status codes", () => {
    expect(redactValue({ error: { code: "BadGateway" }, statusCode: 502 })).toEqual({
      error: { code: "BadGateway" },
      statusCode: 502,
    });
  });

  it("does not mutate the input", () => {
    const input = { token: "t" };
    redactValue(input);
    expect(input.token).toBe("t");
  });

  it("truncates large payloads", () => {
    const small = truncatePayload({ a: 1 }, 1024);
    expect(small.truncated).toBe(false);
    const big = truncatePayload({ a: "x".repeat(5000) }, 1024);
    expect(big.truncated).toBe(true);
    expect(big.value).toMatchObject({ _truncated: true });
  });

  it("maps with bounded concurrency preserving order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
