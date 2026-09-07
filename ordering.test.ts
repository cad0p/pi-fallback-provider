import { describe, expect, it } from "vitest";

import { registerCachedAliases, syncAliases } from "./aliases";
import type {
  AliasCacheEntry,
  AliasProviderConfig,
  CloneSourceModel,
} from "./aliases";

/**
 * Simulates pi's loader queue → flush → post-bind direct contract:
 * load-time `registerProvider` calls queue into pendingProviderRegistrations
 * (loader.ts) and flush on session-services creation; post-bind calls
 * (runner.ts) hit the registry immediately with replace semantics.
 */
class FakeRegistry {
  private queue: Array<{ name: string; config: AliasProviderConfig }> = [];
  private providers = new Map<string, AliasProviderConfig>();
  bound = false;

  /** What `pi.registerProvider` does during initial extension load. */
  loadRegister(name: string, config: AliasProviderConfig): void {
    this.queue.push({ name, config: structuredClone(config) });
  }

  /** Flush queued registrations (session-services creation). */
  flush(): void {
    for (const { name, config } of this.queue) this.providers.set(name, config);
    this.queue = [];
    this.bound = true;
  }

  /** What `pi.registerProvider` does once bound (post-bind direct). */
  register(name: string, config: AliasProviderConfig): void {
    if (!this.bound) {
      this.loadRegister(name, config);
      return;
    }
    this.providers.set(name, structuredClone(config));
  }

  ids(): string[] {
    return [...this.providers.keys()].sort();
  }

  modelsOf(provider: string): CloneSourceModel[] {
    return ((this.providers.get(provider)?.models ?? []) as CloneSourceModel[]).map((m) => ({
      ...m,
      provider,
    }));
  }
}

function liveModel(overrides: Partial<CloneSourceModel> = {}): CloneSourceModel {
  return {
    id: "model-a",
    name: "Model A",
    api: "anthropic-messages",
    baseUrl: "https://api.example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 8192,
    ...overrides,
  };
}

describe("Phase-1/Phase-2 ordering (fake registry)", () => {
  it("pins id parity, Phase-2-wins, and stale pruning", () => {
    const registry = new FakeRegistry();

    // Seeded cache: opencode-2 with an OLD maxTokens + a stale alias whose
    // auth slot has since been removed.
    const seededCache: Record<string, AliasCacheEntry> = {
      "opencode-2": { base: "opencode", account: "2", models: [liveModel({ maxTokens: 100 })] },
      "opencode-9-stale": { base: "opencode", account: "9-stale", models: [liveModel()] },
    };

    // Phase 1 — load-time registration from cache (queued, then flushed).
    const phase1Ids = registerCachedAliases({
      readCache: () => structuredClone(seededCache),
      readAuthKeys: () => ["opencode", "opencode-2"],
      readSection: () => undefined,
      register: (id, config) => registry.loadRegister(id, config),
    });
    registry.flush();
    expect(phase1Ids.sort()).toEqual(["opencode-2", "opencode-9-stale"]);
    expect(registry.ids()).toEqual(["opencode-2", "opencode-9-stale"]);

    // Phase 2 — live catalog changed: maxTokens bumped + model added; the
    // stale slot is gone from auth.json.
    const live = [liveModel({ maxTokens: 16384 }), liveModel({ id: "model-b", name: "Model B" })];
    let written: Record<string, AliasCacheEntry> | undefined;
    const result = syncAliases({
      readAuthKeys: () => ["opencode", "opencode-2"],
      getBaseModels: (base) => (base === "opencode" ? structuredClone(live) : []),
      readSection: () => undefined,
      register: (id, config) => registry.register(id, config),
      writeCache: (aliases) => {
        written = aliases;
      },
    });

    // Identical alias id sets in both phases (stale pruned everywhere).
    expect(result.registered).toEqual(["opencode-2"]);
    expect(phase1Ids.filter((id) => result.registered.includes(id))).toEqual(result.registered);
    // The rewritten cache is exactly the Phase-2 id set: the next load's
    // Phase 1 cannot diverge from this session's Phase 2.
    expect(Object.keys(written ?? {}).sort()).toEqual([...result.registered].sort());

    // Phase-2 models win by value.
    const models = registry.modelsOf("opencode-2");
    expect(models.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);
    expect(models.find((m) => m.id === "model-a")?.maxTokens).toBe(16384);

    // Stale cached alias pruned from the rewritten cache (and never
    // re-registered in Phase 2 — the registry copy is last-known-good only
    // until unregister; the cache is the source of Phase-1 truth).
    expect(Object.keys(written ?? {}).sort()).toEqual(["opencode-2"]);
  });
});
