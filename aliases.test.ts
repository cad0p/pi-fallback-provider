import { describe, expect, it } from "vitest";

import { buildAliasConfig, groupSiblings, parseAliasId } from "./aliases";
import type { CloneSourceModel } from "./aliases";

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

function fauxCatalog(): CloneSourceModel[] {
  return [
    {
      id: "model-a",
      name: "Model A",
      api: "anthropic-messages",
      baseUrl: "https://api.example.com",
      reasoning: true,
      thinkingLevelMap: { low: "low", high: { nested: true } },
      input: ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1, tiers: [{ ghi: 1 }] },
      contextWindow: 200000,
      maxTokens: 16384,
      samplingParams: { temperature: 0.7 },
      compat: { foo: "bar" },
      provider: "opencode",
      headers: { "x-secret": "drop-me" },
    },
    {
      id: "model-b",
      name: "Model B",
      api: "anthropic-messages",
      baseUrl: "https://api.example.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 8192,
    },
  ];
}

describe("buildAliasConfig", () => {
  it("clones a 2-model catalog field-by-field", () => {
    const base = fauxCatalog();
    const config = buildAliasConfig("opencode-2", "opencode", base);
    expect(config.name).toBe("opencode (2)");
    expect(config.api).toBe("anthropic-messages");
    expect(config.models).toHaveLength(2);
    expect(config.models![0]).toEqual({
      id: "model-a",
      name: "Model A",
      api: "anthropic-messages",
      baseUrl: "https://api.example.com",
      reasoning: true,
      thinkingLevelMap: { low: "low", high: { nested: true } },
      input: ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1, tiers: [{ ghi: 1 }] },
      contextWindow: 200000,
      maxTokens: 16384,
      samplingParams: { temperature: 0.7 },
      compat: { foo: "bar" },
    });
    expect(config.models![1]).toEqual({
      id: "model-b",
      name: "Model B",
      api: "anthropic-messages",
      baseUrl: "https://api.example.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 8192,
    });
  });

  it("never sets apiKey (or streamSimple/oauth), and drops provider/headers extras", () => {
    const config = buildAliasConfig("opencode-2", "opencode", fauxCatalog());
    expect("apiKey" in config).toBe(false);
    expect("streamSimple" in config).toBe(false);
    expect("oauth" in config).toBe(false);
    for (const m of config.models!) {
      expect("apiKey" in m).toBe(false);
      expect("provider" in m).toBe(false);
      expect("headers" in m).toBe(false);
    }
    expect(JSON.stringify(config)).not.toContain("apiKey");
  });

  it("deep-copies input/cost/samplingParams/compat (mutating the clone spares the base)", () => {
    const base = fauxCatalog();
    const config = buildAliasConfig("opencode-2", "opencode", base);
    const clone = config.models![0];
    (clone.input as string[]).push("video");
    (clone.cost as Record<string, unknown>).input = 999;
    (clone.samplingParams as Record<string, unknown>).temperature = 0;
    (clone.compat as Record<string, unknown>).foo = "mutated";
    expect(base[0].input).toEqual(["text", "image"]);
    expect(base[0].cost.input).toBe(1);
    expect(base[0].samplingParams).toEqual({ temperature: 0.7 });
    expect(base[0].compat).toEqual({ foo: "bar" });
  });

  it("shallow-copies thinkingLevelMap (top level decoupled)", () => {
    const base = fauxCatalog();
    const config = buildAliasConfig("opencode-2", "opencode", base);
    expect(config.models![0].thinkingLevelMap).toEqual(base[0].thinkingLevelMap);
    expect(config.models![0].thinkingLevelMap).not.toBe(base[0].thinkingLevelMap);
  });

  it("omits top-level api when base models disagree", () => {
    const base = fauxCatalog();
    base[1].api = "openai-responses";
    const config = buildAliasConfig("opencode-2", "opencode", base);
    expect("api" in config).toBe(false);
    expect(config.models![0].api).toBe("anthropic-messages");
    expect(config.models![1].api).toBe("openai-responses");
  });

  it("uses the label override in the provider name", () => {
    const config = buildAliasConfig("opencode-2-work", "opencode", fauxCatalog(), { label: "work" });
    expect(config.name).toBe("opencode (work)");
  });
});
