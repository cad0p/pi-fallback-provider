import { describe, expect, it } from "vitest";

// Smoke test for the harness itself (§1). Real coverage lives in
// aliases.test.ts / ordering.test.ts / cycle.test.ts.
describe("harness", () => {
  it("runs TypeScript tests under vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
