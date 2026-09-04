import { describe, expect, it } from "vitest";

import { groupSiblings, parseAliasId } from "./aliases";

describe("parseAliasId", () => {
  it("splits at the first -<digits> boundary, keeping the rest as account", () => {
    expect(parseAliasId("opencode-2-work")).toEqual({ base: "opencode", account: "2-work" });
  });

  it("handles a base id that itself contains a dash", () => {
    expect(parseAliasId("opencode-go-2")).toEqual({ base: "opencode-go", account: "2" });
  });

  it("rejects non-numeric suffixes", () => {
    expect(parseAliasId("opencode-personal")).toBeNull();
  });

  it("rejects bare provider ids", () => {
    expect(parseAliasId("opencode")).toBeNull();
  });

  it("handles multi-digit accounts", () => {
    expect(parseAliasId("opencode-22")).toEqual({ base: "opencode", account: "22" });
  });

  it("rejects a trailing dash", () => {
    expect(parseAliasId("opencode-")).toBeNull();
  });

  it("handles numeric content inside the base id", () => {
    expect(parseAliasId("mp3-4")).toEqual({ base: "mp3", account: "4" });
  });

  it("rejects an empty base", () => {
    expect(parseAliasId("-2")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseAliasId("")).toBeNull();
  });
});

describe("groupSiblings", () => {
  it("groups alias ids by base and skips non-alias entries", () => {
    const groups = groupSiblings(["opencode", "opencode-2", "opencode-2-work", "opencode-personal"]);
    expect([...groups.keys()]).toEqual(["opencode"]);
    expect(groups.get("opencode")).toEqual(["opencode-2", "opencode-2-work"]);
  });

  it("dedups repeated keys and sorts deterministically", () => {
    const groups = groupSiblings(["opencode-2-work", "opencode-2", "opencode-2-work", "opencode-10"]);
    expect(groups.get("opencode")).toEqual(["opencode-10", "opencode-2", "opencode-2-work"]);
  });

  it("returns an empty map when no sibling slots exist", () => {
    expect(groupSiblings(["opencode", "anthropic"]).size).toBe(0);
    expect(groupSiblings([]).size).toBe(0);
  });
});
