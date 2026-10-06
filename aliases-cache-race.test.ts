/**
 * Regression: concurrent `writeAliasCache` writers must not share a tmp path.
 *
 * Every session that loads the extension syncs aliases on `session_start`
 * (subagent sessions included), so two pi processes targeting the same
 * `agentDir` can write this cache at the same time. With the old shared
 * `${dest}.tmp`, writer B's rename moves the file away while writer A is
 * still between its write and rename: A's `renameSync` throws ENOENT (swallowed
 * as a warning), or B renames a half-written file into place.
 *
 * The test below forces the interleaving deterministically: a full second
 * `writeAliasCache` cycle runs from inside the first writer's `writeFileSync`,
 * before the first writer reaches its rename.
 */

import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { readAliasCache, writeAliasCache } from "./aliases";

const state = vi.hoisted(() => ({
  afterTmpWrite: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: ((...args: unknown[]) => {
      (actual.writeFileSync as (...a: unknown[]) => void)(...args);
      const path = args[0];
      if (typeof path === "string" && path.endsWith(".tmp") && state.afterTmpWrite) {
        const run = state.afterTmpWrite;
        state.afterTmpWrite = undefined;
        run();
      }
    }) as typeof actual.writeFileSync,
  };
});

/** Minimal cache entry that survives `sanitizeModel`. */
function entry(modelId: string) {
  return {
    base: "opencode",
    account: "2",
    models: [
      {
        id: modelId,
        name: modelId,
        api: "anthropic-messages",
        baseUrl: "https://api.example.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 8192,
      },
    ],
  };
}

describe("writeAliasCache concurrency", () => {
  it("keeps per-writer tmp paths so an interleaved writer cannot clobber them", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fallback-race-"));

    state.afterTmpWrite = () => {
      writeAliasCache(dir, { "opencode-3": entry("model-c") }, { now: () => "2026-10-06T00:00:00.000Z" });
    };

    expect(() =>
      writeAliasCache(dir, { "opencode-2": entry("model-a") }, { now: () => "2026-10-06T00:00:01.000Z" }),
    ).not.toThrow();

    // The interleaved writer renames first; the outer writer renames last and
    // therefore wins the destination — and its rename must not have thrown.
    expect(Object.keys(readAliasCache(dir))).toEqual(["opencode-2"]);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves only the destination file after a plain write", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fallback-race-"));
    writeAliasCache(dir, { "opencode-2": entry("model-a") });
    expect(readdirSync(dir)).toEqual(["pi-fallback-alias-models.json"]);
    expect(readAliasCache(dir)["opencode-2"].models[0].id).toBe("model-a");
  });
});
