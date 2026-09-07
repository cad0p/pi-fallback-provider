import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildModelOrder, indexOfScoped, parseModelEntry } from "./aliases";
import type { ScopedEntry } from "./aliases";

function scope(ids: string[]): ScopedEntry[] {
  return ids.map((id) => {
    const slash = id.indexOf("/");
    return { model: { provider: id.slice(0, slash), id: id.slice(slash + 1) } };
  });
}

describe("parseModelEntry", () => {
  it("splits provider/id and tolerates slashes in the id", () => {
    expect(parseModelEntry("opencode/model-a")).toEqual({ provider: "opencode", id: "model-a" });
    expect(parseModelEntry("opencode-2/org/model")).toEqual({ provider: "opencode-2", id: "org/model" });
    expect(parseModelEntry("bare")).toEqual({ provider: "", id: "bare" });
  });
});

describe("buildModelOrder", () => {
  const scoped = scope(["a/m1", "b/m2", "opencode-2/m3"]);

  it("walks the live scope from the cursor, skipping the current model", () => {
    expect(buildModelOrder(scoped, "a", "m1", 0).map((m) => `${m.provider}/${m.id}`)).toEqual([
      "b/m2",
      "opencode-2/m3",
    ]);
    expect(buildModelOrder(scoped, "zzz", "none", 1).map((m) => `${m.provider}/${m.id}`)).toEqual([
      "b/m2",
      "opencode-2/m3",
      "a/m1",
    ]);
  });

  it("wraps the cursor around the live array", () => {
    expect(buildModelOrder(scoped, "zzz", "none", 5).map((m) => `${m.provider}/${m.id}`)).toEqual([
      "opencode-2/m3",
      "a/m1",
      "b/m2",
    ]);
  });

  it("returns [] for an empty scope (no candidates, unchanged behavior)", () => {
    expect(buildModelOrder([], "a", "m1", 0)).toEqual([]);
  });
});

describe("indexOfScoped", () => {
  const scoped = scope(["a/m1", "b/m2"]);

  it("locates candidates for cursor advance, -1 when absent", () => {
    expect(indexOfScoped(scoped, "b", "m2")).toBe(1);
    expect(indexOfScoped(scoped, "zzz", "none")).toBe(-1);
  });
});

describe("pi version floor", () => {
  it("README declares the v0.83.0 floor", () => {
    expect(readFileSync("README.md", "utf-8")).toContain("v0.83.0");
  });
});
