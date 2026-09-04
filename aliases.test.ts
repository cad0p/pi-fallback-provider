import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyInheritance,
  buildAliasConfig,
  groupSiblings,
  parseAliasId,
  readAliasCache,
  readModelsJsonSection,
  registerCachedAliases,
  writeAliasCache,
} from "./aliases";
import type { Phase1Deps } from "./aliases";
import type { AliasProviderConfig, CloneSourceModel } from "./aliases";

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

describe("applyInheritance", () => {
  const baseModels = fauxCatalog().slice(0, 1);

  function built(): AliasProviderConfig {
    return buildAliasConfig("opencode-2", "opencode", baseModels);
  }

  it("alias-set values win over both sections (replace-not-merge for headers)", () => {
    const config = { ...built(), headers: { a: "1" } };
    const out = applyInheritance(
      config,
      { headers: { b: "2" }, baseUrl: "https://base.example.com" },
      { headers: { c: "3" } },
    );
    expect(out.headers).toEqual({ a: "1" });
    expect(out.baseUrl).toBe("https://base.example.com");
  });

  it("alias section beats base section when the built config lacks the field", () => {
    const out = applyInheritance(
      built(),
      { headers: { b: "2" }, authHeader: true },
      { headers: { c: "3" } },
    );
    expect(out.headers).toEqual({ c: "3" });
    expect(out.authHeader).toBe(true);
  });

  it("base section fills the gap, otherwise the field stays absent", () => {
    const filled = applyInheritance(built(), { authHeader: false, compat: { x: 1 } }, undefined);
    expect(filled.authHeader).toBe(false);
    expect(filled.compat).toEqual({ x: 1 });
    expect("headers" in filled).toBe(false);

    const empty = applyInheritance(built(), undefined, undefined);
    expect("headers" in empty).toBe(false);
    expect("authHeader" in empty).toBe(false);
    expect("compat" in empty).toBe(false);
    expect("baseUrl" in empty).toBe(false);
  });

  it("base name fills a config that lacks one", () => {
    const { name: _dropped, ...withoutName } = built();
    const out = applyInheritance(withoutName, { name: "Base Name" }, undefined);
    expect(out.name).toBe("Base Name");
  });

  it("never inherits apiKey or oauth even when the base section has them", () => {
    const out = applyInheritance(
      built(),
      { apiKey: "sk-secret", oauth: { name: "x" }, headers: { h: "1" } },
      undefined,
    );
    expect("apiKey" in out).toBe(false);
    expect("oauth" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("sk-secret");
  });

  it("leaves cloned per-model baseUrl values untouched (top-level only)", () => {
    const out = applyInheritance(built(), { baseUrl: "https://base.example.com" }, undefined);
    expect(out.baseUrl).toBe("https://base.example.com");
    expect(out.models![0].baseUrl).toBe("https://api.example.com");
  });
});

describe("readModelsJsonSection", () => {
  it("reads sections from a tmp agent dir; missing/invalid handled gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fallback-test-"));
    // Missing file → undefined, no warn.
    const warnings: string[] = [];
    expect(readModelsJsonSection(dir, "opencode", (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([]);

    // Valid file → section returned; unknown provider → undefined.
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({ providers: { opencode: { baseUrl: "https://x.example.com" } } }),
    );
    expect(readModelsJsonSection(dir, "opencode")?.baseUrl).toBe("https://x.example.com");
    expect(readModelsJsonSection(dir, "nope")).toBeUndefined();

    // Invalid JSON → warn + undefined, never throws.
    writeFileSync(join(dir, "models.json"), "{not json");
    expect(readModelsJsonSection(dir, "opencode", (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe("alias model cache", () => {
  function tmpAgentDir(): string {
    return mkdtempSync(join(tmpdir(), "pi-fallback-cache-"));
  }

  function cacheEntry() {
    return {
      base: "opencode",
      account: "2",
      models: [
        {
          id: "model-a",
          name: "Model A",
          api: "anthropic-messages",
          baseUrl: "https://api.example.com",
          reasoning: false,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 8192,
          samplingParams: { temperature: 0.5 },
          compat: { foo: "bar" },
        },
      ],
    };
  }

  it("round-trips models by value (samplingParams/compat survive)", () => {
    const dir = tmpAgentDir();
    writeAliasCache(dir, { "opencode-2": cacheEntry() }, { now: () => "2026-09-04T00:00:00.000Z" });
    const back = readAliasCache(dir);
    expect(back["opencode-2"]).toEqual(cacheEntry());
    expect(back["opencode-2"].models[0].samplingParams).toEqual({ temperature: 0.5 });
    expect(back["opencode-2"].models[0].compat).toEqual({ foo: "bar" });
  });

  it("returns empty silently when the cache is missing", () => {
    const warnings: string[] = [];
    expect(readAliasCache(tmpAgentDir(), (m: string) => warnings.push(m))).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("returns empty with a warning on corrupt content or version mismatch", () => {
    const dir = tmpAgentDir();
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    writeFileSync(join(dir, "pi-fallback-alias-models.json"), "{nope");
    expect(readAliasCache(dir, warn)).toEqual({});
    writeFileSync(
      join(dir, "pi-fallback-alias-models.json"),
      JSON.stringify({ version: 999, updatedAt: "x", aliases: {} }),
    );
    expect(readAliasCache(dir, warn)).toEqual({});
    expect(warnings).toHaveLength(2);
  });

  it("never persists apiKey even if a caller passes one", () => {
    const dir = tmpAgentDir();
    const tainted = cacheEntry() as unknown as { base: string; account: string; models: Record<string, unknown>[] };
    tainted.models[0] = {
      ...tainted.models[0],
      apiKey: "sk-should-never-persist",
      provider: "opencode",
    };
    writeAliasCache(dir, { "opencode-2": tainted as unknown as ReturnType<typeof cacheEntry> });
    const raw = readFileSync(join(dir, "pi-fallback-alias-models.json"), "utf-8");
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("sk-should-never-persist");
    const back = readAliasCache(dir);
    expect("apiKey" in (back["opencode-2"].models[0] as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("registerCachedAliases (Phase 1)", () => {
  const cached = {
    "opencode-2": {
      base: "opencode",
      account: "2",
      models: [
        {
          id: "model-a",
          name: "Model A",
          api: "anthropic-messages",
          baseUrl: "https://api.example.com",
          reasoning: false,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 8192,
        },
      ],
    },
  };

  function deps(overrides: Partial<Phase1Deps> = {}) {
    const registered: Array<{ aliasId: string; config: unknown }> = [];
    const warnings: string[] = [];
    const debugs: string[] = [];
    return {
      registered,
      warnings,
      debugs,
      deps: {
        readCache: () => structuredClone(cached),
        readAuthKeys: () => ["opencode", "opencode-2"],
        readSection: () => undefined,
        register: (aliasId: string, config: unknown) => {
          registered.push({ aliasId, config });
        },
        warn: (m: string) => warnings.push(m),
        debug: (m: string) => debugs.push(m),
        ...overrides,
      },
    };
  }

  it("registers cached alias ids with rebuilt configs", () => {
    const t = deps();
    const ids = registerCachedAliases(t.deps);
    expect(ids).toEqual(["opencode-2"]);
    expect(t.registered).toHaveLength(1);
    const config = t.registered[0].config as Record<string, unknown>;
    expect(config.name).toBe("opencode (2)");
    expect((config.models as unknown[])).toHaveLength(1);
    expect(t.warnings).toEqual([]);
  });

  it("registers nothing (debug, not warn) when the cache is empty and no slots exist", () => {
    const t = deps({ readCache: () => ({}), readAuthKeys: () => ["opencode"] });
    expect(registerCachedAliases(t.deps)).toEqual([]);
    expect(t.registered).toEqual([]);
    expect(t.warnings).toEqual([]);
    expect(t.debugs).toHaveLength(1);
  });

  it("warns when the cache is empty but auth.json holds sibling slots", () => {
    const t = deps({ readCache: () => ({}) });
    expect(registerCachedAliases(t.deps)).toEqual([]);
    expect(t.warnings).toHaveLength(1);
    expect(t.debugs).toEqual([]);
  });

  it("skips unparseable cached ids with a warn", () => {
    const t = deps({ readCache: () => ({ "not-an-alias!!-x": structuredClone(cached["opencode-2"]) }) });
    expect(registerCachedAliases(t.deps)).toEqual([]);
    expect(t.registered).toEqual([]);
    expect(t.warnings).toHaveLength(1);
  });
});
