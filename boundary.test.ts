import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  ALL_CANDIDATES_FAILED_MESSAGE,
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  DelayAbortedError,
  MAX_TIMEOUT_MS,
  NO_CANDIDATES_MESSAGE,
  STATUS_KEY,
  buildDelayPolicy,
  candidateOrder,
  createBoundaryHandler,
  createEpisodeState,
  createPreAnnounceHandler,
  episodeElapsedMs,
  fallbackDelayMs,
  findLastErroredAssistantEntryId,
  formatDuration,
  formatPreAnnounceBanner,
  isLastModelVisibleErrorEntry,
  nextCandidateLabel,
  noteError,
  parseDelayMs,
  resetEpisode,
  resetEpisodeStatus,
  sleepAbortable,
} from "./boundary";
import type {
  AgentBeforeSettleEventLike,
  BoundaryContextLike,
  BoundaryDeps,
  BoundaryDraftLike,
  BranchEntryLike,
  EpisodeState,
  FallbackDelayPolicy,
  ProjectedEntryLike,
} from "./boundary";
import type { ScopedEntry } from "./aliases";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function scoped(ids: string[]): ScopedEntry[] {
  return ids.map((id) => {
    const slash = id.indexOf("/");
    return { model: { provider: id.slice(0, slash), id: id.slice(slash + 1) } };
  });
}

function branchMessage(
  id: string,
  stopReason: string,
  role = "assistant",
  type = "message",
): BranchEntryLike {
  return { id, type, message: { role, stopReason } };
}

function tailError(id: string): ProjectedEntryLike {
  return {
    sourceEntry: { id, type: "message" },
    messages: [{ role: "assistant", stopReason: "error" }],
  };
}

function omitted(id: string): ProjectedEntryLike {
  return { sourceEntry: { id, type: "message" }, messages: [] };
}

function projected(id: string, role: string, stopReason?: string): ProjectedEntryLike {
  return {
    sourceEntry: { id, type: "message" },
    messages: [{ role, ...(stopReason ? { stopReason } : {}) }],
  };
}

function makeContext(
  options: {
    branch?: BranchEntryLike[];
    scopedModels?: ScopedEntry[];
    available?: string[];
    model?: { provider: string; id: string } | null;
    hasUI?: boolean;
    findResult?: (
      provider: string,
      id: string,
    ) => { provider: string; id: string } | undefined;
  } = {},
): BoundaryContextLike {
  const available = options.available ?? [];
  return {
    sessionManager: { getBranch: () => options.branch ?? [] },
    scopedModels: options.scopedModels ?? [],
    model: options.model === undefined ? { provider: "a", id: "m1" } : options.model,
    modelRegistry: {
      find:
        options.findResult ??
        ((provider, id) =>
          available.includes(`${provider}/${id}`) ? { provider, id } : undefined),
      getAvailable: () =>
        available.map((key) => {
          const slash = key.indexOf("/");
          return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
        }),
    },
    hasUI: options.hasUI ?? true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

/** Error branch with one candidate queued after the current model. */
function readyContext(branch: BranchEntryLike[] = [branchMessage("e1", "error")]): BoundaryContextLike {
  return makeContext({
    branch,
    scopedModels: scoped(["a/m1", "b/m2"]),
    available: ["a/m1", "b/m2"],
  });
}

function makeEvent(
  overrides: Partial<AgentBeforeSettleEventLike> = {},
): AgentBeforeSettleEventLike {
  return {
    type: "agent_before_settle",
    outcome: "error",
    entries: [],
    continue: false,
    context: { contextEntries: [], canContinue: false },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BoundaryDeps> = {}): BoundaryDeps {
  return {
    setModel: vi.fn(async () => true),
    getCursor: () => 0,
    setCursor: vi.fn(),
    debug: vi.fn(),
    episode: createEpisodeState(),
    delay: { baseMs: DEFAULT_DELAY_MS, maxMs: DEFAULT_MAX_DELAY_MS },
    ...overrides,
  };
}

/** Pre-announce handler with the shared episode state wired like `index.ts`. */
function makePreAnnounce(
  overrides: Partial<Pick<BoundaryDeps, "getCursor" | "debug" | "episode">> & {
    now?: () => number;
  } = {},
) {
  return createPreAnnounceHandler({
    getCursor: () => 0,
    debug: vi.fn(),
    episode: createEpisodeState(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Raw branch scan
// ---------------------------------------------------------------------------

describe("findLastErroredAssistantEntryId", () => {
  it("returns undefined for an empty branch", () => {
    expect(findLastErroredAssistantEntryId([])).toBeUndefined();
  });

  it("finds the last errored assistant message, ignoring later non-message entries", () => {
    const branch: BranchEntryLike[] = [
      branchMessage("e1", "error"),
      branchMessage("ok", "stop"),
      branchMessage("e2", "error"),
      { id: "c1", type: "context_edit" },
    ];
    expect(findLastErroredAssistantEntryId(branch)).toBe("e2");
  });

  it("ignores non-message entries, non-assistant messages, and other stop reasons", () => {
    const branch: BranchEntryLike[] = [
      { id: "x1", type: "context_edit", message: { role: "assistant", stopReason: "error" } },
      branchMessage("u1", "", "user"),
      branchMessage("a1", "aborted"),
      branchMessage("a2", "length"),
      branchMessage("t1", "toolUse"),
      { id: "e9", type: "model_change" },
    ];
    expect(findLastErroredAssistantEntryId(branch)).toBeUndefined();
  });

  it("ignores a non-assistant message with an error stop reason and keeps an earlier real one", () => {
    const branch: BranchEntryLike[] = [
      branchMessage("e1", "error"),
      branchMessage("u1", "error", "user"),
    ];
    expect(findLastErroredAssistantEntryId(branch)).toBe("e1");
  });
});

describe("isLastModelVisibleErrorEntry", () => {
  it("is true when the target owns the last model-visible message", () => {
    expect(isLastModelVisibleErrorEntry([tailError("e1")], "e1")).toBe(true);
  });

  it("skips omitted entries after the target", () => {
    expect(isLastModelVisibleErrorEntry([tailError("e1"), omitted("c1")], "e1")).toBe(true);
  });

  it("is false for an empty projection", () => {
    expect(isLastModelVisibleErrorEntry([], "e1")).toBe(false);
  });

  it("is false when a later entry owns model-visible messages", () => {
    expect(
      isLastModelVisibleErrorEntry([tailError("e1"), projected("later", "user")], "e1"),
    ).toBe(false);
  });

  it("is false when the last model-visible message is not an errored assistant", () => {
    expect(
      isLastModelVisibleErrorEntry([projected("e1", "assistant", "stop")], "e1"),
    ).toBe(false);
    expect(isLastModelVisibleErrorEntry([projected("e1", "user")], "e1")).toBe(false);
  });

  it("is false when the last visible message is not an assistant despite an error stop reason", () => {
    expect(isLastModelVisibleErrorEntry([projected("e1", "user", "error")], "e1")).toBe(false);
  });

  it("is false when an earlier errored entry is the target and a later one is the tail", () => {
    expect(isLastModelVisibleErrorEntry([tailError("e1"), tailError("e2")], "e1")).toBe(false);
  });

  it("is false when the target itself is omitted and an earlier entry is the visible tail", () => {
    expect(isLastModelVisibleErrorEntry([projected("u1", "user"), omitted("e1")], "e1")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Candidate ordering
// ---------------------------------------------------------------------------

describe("candidateOrder / nextCandidateLabel", () => {
  it("walks the scope from the cursor, skips the current model, and filters to available", () => {
    const ctx = makeContext({
      scopedModels: scoped(["a/m1", "b/m2", "c/m3"]),
      available: ["a/m1", "b/m2", "c/m3"],
    });
    expect(candidateOrder(ctx, 0)).toEqual([
      { provider: "b", id: "m2" },
      { provider: "c", id: "m3" },
    ]);
  });

  it("filters out scoped models the registry reports unavailable", () => {
    const ctx = makeContext({
      scopedModels: scoped(["a/m1", "b/m2", "c/m3"]),
      available: ["a/m1", "c/m3"],
    });
    expect(candidateOrder(ctx, 0)).toEqual([{ provider: "c", id: "m3" }]);
  });

  it("returns [] and no label for an empty scope", () => {
    const ctx = makeContext();
    expect(candidateOrder(ctx, 0)).toEqual([]);
    expect(nextCandidateLabel(ctx, 0)).toBeUndefined();
  });

  it("returns the first candidate label and skips unavailable ones", () => {
    const ctx = makeContext({
      scopedModels: scoped(["a/m1", "b/m2", "c/m3"]),
      available: ["b/m2"],
    });
    expect(nextCandidateLabel(ctx, 0)).toBe("b/m2");
    const none = makeContext({ scopedModels: scoped(["a/m1", "b/m2"]), available: ["a/m1"] });
    expect(nextCandidateLabel(none, 0)).toBeUndefined();
  });

  it("wraps a negative cursor from the end of the scope", () => {
    const ctx = makeContext({
      scopedModels: scoped(["a/m1", "b/m2", "c/m3"]),
      available: ["a/m1", "b/m2", "c/m3"],
    });
    expect(candidateOrder(ctx, -1)).toEqual([
      { provider: "c", id: "m3" },
      { provider: "b", id: "m2" },
    ]);
    expect(nextCandidateLabel(ctx, -1)).toBe("c/m3");
  });
});

// ---------------------------------------------------------------------------
// Episode pacing helpers
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [1_000, "1s"],
    [59_000, "59s"],
    [60_000, "1m0s"],
    [135_000, "2m15s"],
    [3_600_000, "1h0m0s"],
    [45_315_000, "12h35m15s"],
    [90_061_000, "1d1h1m"],
    [Number.NaN, "0s"],
    [-5, "0s"],
  ])("formats %dms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("fallbackDelayMs", () => {
  const policy: FallbackDelayPolicy = { baseMs: 2_000, maxMs: 60_000 };

  it("does not delay the first switch", () => {
    expect(fallbackDelayMs(policy, 0)).toBe(0);
  });

  it("grows exponentially from the second switch and caps", () => {
    expect(fallbackDelayMs(policy, 1)).toBe(2_000);
    expect(fallbackDelayMs(policy, 2)).toBe(4_000);
    expect(fallbackDelayMs(policy, 3)).toBe(8_000);
    expect(fallbackDelayMs(policy, 4)).toBe(16_000);
    expect(fallbackDelayMs(policy, 5)).toBe(32_000);
    expect(fallbackDelayMs(policy, 6)).toBe(60_000);
    expect(fallbackDelayMs(policy, 1_000)).toBe(60_000);
  });

  it("floors fractional switch counts", () => {
    expect(fallbackDelayMs(policy, 0.9)).toBe(0);
    expect(fallbackDelayMs(policy, 1.5)).toBe(2_000);
    expect(fallbackDelayMs(policy, 2.9)).toBe(4_000);
  });

  it("disables on a non-positive or NaN base or cap", () => {
    expect(fallbackDelayMs({ baseMs: 0, maxMs: 60_000 }, 5)).toBe(0);
    expect(fallbackDelayMs({ baseMs: -1, maxMs: 60_000 }, 5)).toBe(0);
    expect(fallbackDelayMs({ baseMs: Number.NaN, maxMs: 60_000 }, 5)).toBe(0);
    expect(fallbackDelayMs({ baseMs: 2_000, maxMs: 0 }, 5)).toBe(0);
    expect(fallbackDelayMs({ baseMs: 2_000, maxMs: -1 }, 5)).toBe(0);
    expect(fallbackDelayMs({ baseMs: 2_000, maxMs: Number.NaN }, 5)).toBe(0);
  });

  it("treats an infinite cap as no cap", () => {
    expect(fallbackDelayMs({ baseMs: 2_000, maxMs: Number.POSITIVE_INFINITY }, 6)).toBe(64_000);
  });

  it("ignores non-finite switch counts and does not overflow on huge ones", () => {
    expect(fallbackDelayMs(policy, Number.NaN)).toBe(0);
    expect(fallbackDelayMs(policy, Number.POSITIVE_INFINITY)).toBe(0);
    expect(fallbackDelayMs(policy, Number.MAX_SAFE_INTEGER)).toBe(60_000);
  });
});

describe("buildDelayPolicy", () => {
  it("defaults to 2000ms base and 60000ms cap", () => {
    expect(buildDelayPolicy({})).toEqual({ baseMs: 2_000, maxMs: 60_000 });
  });

  it("reads both knobs and accepts 0 as disable", () => {
    expect(buildDelayPolicy({ PI_FALLBACK_DELAY_MS: "500" })).toEqual({
      baseMs: 500,
      maxMs: 60_000,
    });
    expect(buildDelayPolicy({ PI_FALLBACK_MAX_DELAY_MS: "0" })).toEqual({
      baseMs: 2_000,
      maxMs: 0,
    });
    expect(
      buildDelayPolicy({ PI_FALLBACK_DELAY_MS: "0", PI_FALLBACK_MAX_DELAY_MS: "15000" }),
    ).toEqual({ baseMs: 0, maxMs: 15_000 });
  });

  it("falls back per knob on invalid values", () => {
    expect(
      buildDelayPolicy({ PI_FALLBACK_DELAY_MS: "abc", PI_FALLBACK_MAX_DELAY_MS: "-5" }),
    ).toEqual({ baseMs: 2_000, maxMs: 60_000 });
  });
});

describe("parseDelayMs", () => {
  it("falls back on missing, empty, or invalid values", () => {
    expect(parseDelayMs(undefined, 2_000)).toBe(2_000);
    expect(parseDelayMs("", 2_000)).toBe(2_000);
    expect(parseDelayMs("   ", 2_000)).toBe(2_000);
    expect(parseDelayMs("abc", 2_000)).toBe(2_000);
    expect(parseDelayMs("-1", 2_000)).toBe(2_000);
    expect(parseDelayMs("NaN", 2_000)).toBe(2_000);
    expect(parseDelayMs("Infinity", 2_000)).toBe(2_000);
  });

  it("accepts zero (disables) and floors fractional values", () => {
    expect(parseDelayMs("0", 2_000)).toBe(0);
    expect(parseDelayMs("1500.9", 2_000)).toBe(1_500);
    expect(parseDelayMs(" 3000 ", 2_000)).toBe(3_000);
  });

  it("documents the Number() coercion for exotic spellings", () => {
    expect(parseDelayMs("0x10", 2_000)).toBe(16);
    expect(parseDelayMs("1e3", 2_000)).toBe(1_000);
    expect(parseDelayMs("+5", 2_000)).toBe(5);
    expect(parseDelayMs(".5", 2_000)).toBe(0); // floored to 0 → disables
  });
});

describe("episode state", () => {
  it("starts empty and opens the clock on the first error", () => {
    const state = createEpisodeState();
    expect(state).toEqual({ attempts: 0, firstErrorAt: undefined, switches: 0 });
    noteError(state, 1_000);
    expect(state).toEqual({ attempts: 1, firstErrorAt: 1_000, switches: 0 });
    noteError(state, 5_000);
    expect(state).toEqual({ attempts: 2, firstErrorAt: 1_000, switches: 0 });
    expect(episodeElapsedMs(state, 6_500)).toBe(5_500);
  });

  it("resets to empty, including the switch count", () => {
    const state = createEpisodeState();
    noteError(state, 1_000);
    state.switches = 3;
    resetEpisode(state);
    expect(state).toEqual({ attempts: 0, firstErrorAt: undefined, switches: 0 });
    expect(episodeElapsedMs(state, 9_999)).toBe(0);
  });

  it("clamps a backwards or non-finite clock to zero", () => {
    const state = createEpisodeState();
    noteError(state, 5_000);
    expect(episodeElapsedMs(state, 1_000)).toBe(0);
    expect(episodeElapsedMs(state, Number.NaN)).toBe(0);
  });
});

describe("formatPreAnnounceBanner", () => {
  it("keeps the original wording for the first failure", () => {
    expect(formatPreAnnounceBanner("b/m2", 1, 0)).toBe("⚠ error — next: b/m2 if retries fail");
  });

  it("keeps the original wording for zero or non-finite counts", () => {
    expect(formatPreAnnounceBanner("b/m2", 0, 0)).toBe("⚠ error — next: b/m2 if retries fail");
    expect(formatPreAnnounceBanner("b/m2", Number.NaN, 0)).toBe(
      "⚠ error — next: b/m2 if retries fail",
    );
  });

  it("leads with the count and elapsed time from the second failure", () => {
    expect(formatPreAnnounceBanner("b/m2", 2, 45_315_000)).toBe(
      "⚠ error #2 · retrying for 12h35m15s — next: b/m2",
    );
  });
});

describe("sleepAbortable", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    try {
      const promise = sleepAbortable(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with DelayAbortedError when the signal aborts and cleans up", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const promise = sleepAbortable(2_000, controller.signal);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(DelayAbortedError);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepAbortable(2_000, controller.signal)).rejects.toBeInstanceOf(
      DelayAbortedError,
    );
  });

  it("removes the abort listener when the delay resolves", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const promise = sleepAbortable(1_000, controller.signal);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps an oversized delay to the timer ceiling", async () => {
    const scheduled: Array<() => void> = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
    ) => {
      scheduled.push(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    try {
      const promise = sleepAbortable(Number.MAX_SAFE_INTEGER);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toBe(MAX_TIMEOUT_MS);
      scheduled[0]?.();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Pre-announce
// ---------------------------------------------------------------------------

describe("createPreAnnounceHandler", () => {
  it("pins the status key and the warning literals", () => {
    expect(STATUS_KEY).toBe("pi-fallback");
    expect(ALL_CANDIDATES_FAILED_MESSAGE).toBe("All fallback models exhausted.");
    expect(NO_CANDIDATES_MESSAGE).toBe("No fallback models available.");
    expect(DEFAULT_DELAY_MS).toBe(2_000);
    expect(DEFAULT_MAX_DELAY_MS).toBe(60_000);
    expect(MAX_TIMEOUT_MS).toBe(2_147_483_647);
  });

  it("sets the byte-exact banner on an errored turn when a candidate exists", async () => {
    const ctx = readyContext();
    const handler = makePreAnnounce();
    await handler({ outcome: "error" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      "⚠ error — next: b/m2 if retries fail",
    );
  });

  it("counts the episode and adds the elapsed time from the second error on", async () => {
    let clock = 1_000;
    const handler = makePreAnnounce({ now: () => clock });
    const first = readyContext();
    await handler({ outcome: "error" }, first);
    expect(first.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "⚠ error — next: b/m2 if retries fail",
    );

    clock += 45_315_000; // 12h35m15s
    const second = readyContext();
    await handler({ outcome: "error" }, second);
    expect(second.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "⚠ error #2 · retrying for 12h35m15s — next: b/m2",
    );

    clock += 1_000;
    const third = readyContext();
    await handler({ outcome: "error" }, third);
    expect(third.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "⚠ error #3 · retrying for 12h35m16s — next: b/m2",
    );
  });

  it("resets the episode on completed and aborted turns", async () => {
    let clock = 1_000;
    const handler = makePreAnnounce({ now: () => clock });
    await handler({ outcome: "error" }, readyContext());
    await handler({ outcome: "error" }, readyContext());
    clock += 5_000;
    const settled = readyContext();
    await handler({ outcome: "completed" }, settled);
    expect(settled.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);

    const after = readyContext();
    await handler({ outcome: "error" }, after);
    expect(after.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "⚠ error — next: b/m2 if retries fail",
    );
  });

  it("clears the banner on an errored turn when no candidate is available", async () => {
    const ctx = makeContext();
    const handler = makePreAnnounce();
    await handler({ outcome: "error" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("tracks the episode without a UI (the delay still needs the count)", async () => {
    const episode = createEpisodeState();
    const ctx = readyContext();
    ctx.hasUI = false;
    const handler = makePreAnnounce({ episode });
    await handler({ outcome: "error" }, ctx);
    await handler({ outcome: "error" }, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(episode.attempts).toBe(2);
  });

  it("does not reject when the UI throws", async () => {
    const ctx = readyContext();
    ctx.ui.setStatus = vi.fn(() => {
      throw new Error("no ui");
    });
    const handler = makePreAnnounce();
    await expect(handler({ outcome: "error" }, ctx)).resolves.toBeUndefined();
  });

  it("does not reject when the UI availability getter throws", async () => {
    const ctx = readyContext();
    Object.defineProperty(ctx, "hasUI", {
      get() {
        throw new Error("ctx is stale");
      },
    });
    const handler = makePreAnnounce();
    await expect(handler({ outcome: "error" }, ctx)).resolves.toBeUndefined();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("keeps counting when the UI availability getter throws mid-episode", async () => {
    const episode = createEpisodeState();
    const handler = makePreAnnounce({ episode });
    await handler({ outcome: "error" }, readyContext());
    const broken = readyContext();
    Object.defineProperty(broken, "hasUI", {
      get() {
        throw new Error("ctx is stale");
      },
    });
    await handler({ outcome: "error" }, broken);
    expect(episode.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Boundary handler
// ---------------------------------------------------------------------------

describe("resetEpisodeStatus", () => {
  it("clears the banner and the episode", () => {
    const episode = createEpisodeState();
    noteError(episode, 1_000);
    const ctx = readyContext();
    resetEpisodeStatus(ctx, episode, vi.fn());
    expect(episode).toEqual({ attempts: 0, firstErrorAt: undefined, switches: 0 });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("resets the state even when the UI throws", () => {
    const episode = createEpisodeState();
    noteError(episode, 1_000);
    const ctx = readyContext();
    ctx.ui.setStatus = vi.fn(() => {
      throw new Error("no ui");
    });
    expect(() => resetEpisodeStatus(ctx, episode, vi.fn())).not.toThrow();
    expect(episode.attempts).toBe(0);
  });

  it("resets without a UI and makes no UI calls", () => {
    const episode = createEpisodeState();
    noteError(episode, 1_000);
    const ctx = readyContext();
    ctx.hasUI = false;
    resetEpisodeStatus(ctx, episode, vi.fn());
    expect(episode.attempts).toBe(0);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });
});

describe("createBoundaryHandler — inter-attempt delay", () => {
  it("switches immediately on the first fallback switch", async () => {
    const deps = makeDeps({ sleep: vi.fn(async () => {}) });
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(deps.sleep).not.toHaveBeenCalled();
    expect(result?.continue).toBe(true);
    expect(deps.episode.switches).toBe(1);
  });

  it("waits the backoff before the second fallback switch", async () => {
    const deps = makeDeps({
      sleep: vi.fn(async () => {}),
      episode: { attempts: 2, firstErrorAt: 0, switches: 1 },
    });
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(deps.sleep).toHaveBeenCalledWith(2_000, ctx.signal);
    expect(deps.debug).toHaveBeenCalledWith(
      "inter-attempt delay 2000ms after 1 fallback switch(es)",
    );
    expect(result?.continue).toBe(true);
    expect(deps.setModel).toHaveBeenCalledWith({ provider: "b", id: "m2" });
    expect(deps.episode.switches).toBe(2);
  });

  it("grows the wait with the switch count and caps it", async () => {
    const deps = makeDeps({
      sleep: vi.fn(async () => {}),
      episode: { attempts: 9, firstErrorAt: 0, switches: 9 },
      delay: { baseMs: 2_000, maxMs: 60_000 },
    });
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await createBoundaryHandler(deps)(event, ctx);

    expect(deps.sleep).toHaveBeenCalledWith(60_000, ctx.signal);
  });

  it("disables the wait when the policy base is zero", async () => {
    const deps = makeDeps({
      sleep: vi.fn(async () => {}),
      episode: { attempts: 4, firstErrorAt: 0, switches: 3 },
      delay: { baseMs: 0, maxMs: 60_000 },
    });
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await createBoundaryHandler(deps)(event, ctx);

    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("settles without continuing when the delay is aborted", async () => {
    const deps = makeDeps({
      episode: { attempts: 2, firstErrorAt: 0, switches: 1 },
      sleep: vi.fn(async () => {
        throw new DelayAbortedError();
      }),
    });
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();

    expect(deps.setModel).not.toHaveBeenCalled();
    expect(deps.episode.switches).toBe(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
    expect(deps.debug).toHaveBeenCalledWith(
      expect.stringContaining("inter-attempt delay aborted"),
    );
  });

  it("still waits when candidates exist but every switch fails", async () => {
    const deps = makeDeps({
      sleep: vi.fn(async () => {}),
      setModel: vi.fn(async () => false),
      episode: { attempts: 2, firstErrorAt: 0, switches: 1 },
    });
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();

    expect(deps.sleep).toHaveBeenCalledWith(2_000, ctx.signal);
    expect(deps.episode.switches).toBe(1);
  });

  it("does not wait when no fallback candidate exists", async () => {
    const deps = makeDeps({
      sleep: vi.fn(async () => {}),
      episode: { attempts: 5, firstErrorAt: 0, switches: 4 },
    });
    const ctx = makeContext({ branch: [branchMessage("e1", "error")] });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();

    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.setModel).not.toHaveBeenCalled();
  });

  it("does not wait for a non-error outcome", async () => {
    const deps = makeDeps({
      sleep: vi.fn(async () => {}),
      episode: { attempts: 5, firstErrorAt: 0, switches: 4 },
    });
    const ctx = readyContext();
    const event = makeEvent({
      outcome: "completed",
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();

    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("chains pre-announce counting into the boundary delay and resets together", async () => {
    const episode = createEpisodeState();
    const sleeps: number[] = [];
    const pre = makePreAnnounce({ episode, now: () => 1_000 });
    const deps = makeDeps({
      episode,
      sleep: vi.fn(async (ms: number) => {
        sleeps.push(ms);
      }),
    });
    const handler = createBoundaryHandler(deps);
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    for (let i = 0; i < 3; i++) {
      await pre({ outcome: "error" }, ctx);
      await handler(event, ctx);
    }

    expect(sleeps).toEqual([2_000, 4_000]);
    expect(episode.attempts).toBe(3);
    expect(episode.switches).toBe(3);

    await pre({ outcome: "completed" }, ctx);
    await pre({ outcome: "error" }, ctx);
    await handler(event, ctx);

    expect(sleeps).toEqual([2_000, 4_000]);
    expect(episode.switches).toBe(1);
  });
});

describe("createBoundaryHandler — outcome guard", () => {
  it.each(["completed", "aborted"] as const)(
    "returns undefined for a %s outcome even with an errored branch",
    async (outcome) => {
      const deps = makeDeps();
      const ctx = readyContext();
      const event = makeEvent({
        outcome,
        context: { contextEntries: [tailError("e1")], canContinue: false },
      });
      await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
      expect(deps.setModel).not.toHaveBeenCalled();
    },
  );
});

describe("createBoundaryHandler — omission draft", () => {
  it("omits the errored tail and re-issues on the next authenticated model", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result).toEqual({
      entries: [{ type: "context_edit", targetId: "e1", replacement: null }],
      continue: true,
    });
    expect(deps.setModel).toHaveBeenCalledTimes(1);
    expect(deps.setModel).toHaveBeenCalledWith({ provider: "b", id: "m2" });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(deps.debug).toHaveBeenCalledWith(
      expect.stringContaining("switched model a/m1 → b/m2"),
    );
  });

  it("drafts the omission when a toolResult precedes the errored tail", async () => {
    const deps = makeDeps();
    const ctx = readyContext([branchMessage("e2", "error")]);
    const event = makeEvent({
      context: {
        contextEntries: [projected("t1", "toolResult"), tailError("e2")],
        canContinue: false,
      },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result).toEqual({
      entries: [{ type: "context_edit", targetId: "e2", replacement: null }],
      continue: true,
    });
    expect(deps.setModel).toHaveBeenCalledWith({ provider: "b", id: "m2" });
  });

  it("omits the errored tail even when queued messages already allow continuation", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: true },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result).toEqual({
      entries: [{ type: "context_edit", targetId: "e1", replacement: null }],
      continue: true,
    });
    expect(deps.setModel).toHaveBeenCalledTimes(1);
    expect(deps.debug).toHaveBeenCalledWith("omitting failed attempt e1 from model context");
  });

  it("preserves drafts returned by earlier handlers", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    const prior = { type: "custom_message", customType: "other", content: "x", display: false };
    const event = makeEvent({
      entries: [prior],
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result?.entries).toEqual([
      prior,
      { type: "context_edit", targetId: "e1", replacement: null },
    ]);
    expect(result?.entries?.[1]).toEqual({
      type: "context_edit",
      targetId: "e1",
      replacement: null,
    });
    expect(result?.continue).toBe(true);
  });

  it("passes the registry model object through to setModel", async () => {
    const live = { provider: "b", id: "m2", api: "anthropic-messages" };
    const ctx = makeContext({
      branch: [branchMessage("e1", "error")],
      scopedModels: scoped(["a/m1", "b/m2"]),
      available: ["a/m1", "b/m2"],
      findResult: () => live,
    });
    const deps = makeDeps();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await createBoundaryHandler(deps)(event, ctx);

    expect(deps.setModel).toHaveBeenCalledWith(live);
  });

  it("advances the cursor past the switched candidate", async () => {
    const deps = makeDeps();
    const ctx = makeContext({
      branch: [branchMessage("e1", "error")],
      scopedModels: scoped(["a/m1", "b/m2", "c/m3"]),
      available: ["a/m1", "b/m2", "c/m3"],
    });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await createBoundaryHandler(deps)(event, ctx);

    expect(deps.setCursor).toHaveBeenCalledWith(2);
  });
});

describe("createBoundaryHandler — continuation without a draft", () => {
  it("skips the draft when pi already omitted the failed attempt", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    const entries: BoundaryDraftLike[] = [];
    const event = makeEvent({
      entries,
      context: { contextEntries: [omitted("e1")], canContinue: true },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result?.entries).toBe(entries);
    expect(result?.continue).toBe(true);
    expect(deps.setModel).toHaveBeenCalledTimes(1);
    expect(deps.debug).toHaveBeenCalledWith(
      "pi already omitted the failed attempt — no draft needed",
    );
  });

  it("logs the no-errored-attempt case when the branch holds no failed entry", async () => {
    const deps = makeDeps();
    const ctx = readyContext([branchMessage("ok", "stop")]);
    const event = makeEvent({
      context: { contextEntries: [], canContinue: true },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result?.continue).toBe(true);
    expect(deps.debug).toHaveBeenCalledWith("no errored attempt to omit — no draft needed");
    expect(deps.debug).not.toHaveBeenCalledWith(
      "pi already omitted the failed attempt — no draft needed",
    );
  });

  it("skips the draft when the last visible entry is a non-empty toolResult", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    const entries: BoundaryDraftLike[] = [];
    const event = makeEvent({
      entries,
      context: {
        contextEntries: [projected("t1", "toolResult"), omitted("e1")],
        canContinue: true,
      },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result?.entries).toBe(entries);
    expect(result?.continue).toBe(true);
    expect(deps.setModel).toHaveBeenCalledWith({ provider: "b", id: "m2" });
  });

});

describe("createBoundaryHandler — bail-outs", () => {
  it("returns undefined without switching when nothing safe can be omitted", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    const event = makeEvent({
      context: {
        contextEntries: [tailError("e1"), projected("later", "user")],
        canContinue: false,
      },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
    expect(deps.debug).toHaveBeenCalled();
  });

  it("bails out on an empty projection that cannot continue", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
    expect(deps.debug).toHaveBeenCalled();
  });

  it("returns undefined when the branch has no errored assistant entry", async () => {
    const deps = makeDeps();
    const ctx = readyContext([branchMessage("ok", "stop")]);
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("warns and clears when the scope holds no fallback candidate", async () => {
    const deps = makeDeps();
    const ctx = makeContext({ branch: [branchMessage("e1", "error")] });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(NO_CANDIDATES_MESSAGE, "warning");
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(deps.debug).toHaveBeenCalledWith("no authenticated fallback candidates");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("warns no one when no candidate exists and there is no UI", async () => {
    const deps = makeDeps();
    const ctx = makeContext({ branch: [branchMessage("e1", "error")], hasUI: false });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("warns when the scope is non-empty but no scoped model is available", async () => {
    const deps = makeDeps();
    const ctx = makeContext({
      branch: [branchMessage("e1", "error")],
      scopedModels: scoped(["a/m1", "b/m2"]),
      available: [],
    });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(NO_CANDIDATES_MESSAGE, "warning");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(ALL_CANDIDATES_FAILED_MESSAGE, "warning");
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("warns and returns no draft when every candidate fails to switch", async () => {
    const deps = makeDeps({ setModel: vi.fn(async () => false) });
    const ctx = readyContext();
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(ALL_CANDIDATES_FAILED_MESSAGE, "warning");
    expect(deps.setCursor).not.toHaveBeenCalled();
  });

  it("warns when a candidate is unavailable in the registry", async () => {
    const deps = makeDeps();
    const ctx = makeContext({
      branch: [branchMessage("e1", "error")],
      scopedModels: scoped(["a/m1", "b/m2"]),
      available: ["a/m1", "b/m2"],
      findResult: () => undefined,
    });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(ALL_CANDIDATES_FAILED_MESSAGE, "warning");
  });
});

describe("createBoundaryHandler — stale context", () => {
  it("bails out without switching when the branch read throws", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    ctx.sessionManager = {
      getBranch() {
        throw new Error("ctx is stale");
      },
    };
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
    expect(deps.debug).toHaveBeenCalledWith(expect.stringContaining("host read failed"));
  });

  it("bails out without switching when the availability read throws", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    ctx.modelRegistry.getAvailable = () => {
      throw new Error("registry gone");
    };
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
    expect(deps.debug).toHaveBeenCalledWith(expect.stringContaining("host read failed"));
  });
});

describe("createBoundaryHandler — candidate failure handling", () => {
  it("skips a throwing candidate and switches to the next one exactly once", async () => {
    const deps = makeDeps({
      setModel: vi
        .fn()
        .mockRejectedValueOnce(new Error("no key"))
        .mockResolvedValueOnce(true),
    });
    const ctx = makeContext({
      branch: [branchMessage("e1", "error")],
      scopedModels: scoped(["a/m1", "b/m2", "c/m3"]),
      available: ["a/m1", "b/m2", "c/m3"],
    });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result?.continue).toBe(true);
    expect(deps.setModel).toHaveBeenCalledTimes(2);
    expect(deps.setModel).toHaveBeenNthCalledWith(1, { provider: "b", id: "m2" });
    expect(deps.setModel).toHaveBeenNthCalledWith(2, { provider: "c", id: "m3" });
    expect(deps.setCursor).toHaveBeenCalledWith(0);
    const firstCandidateCalls = vi
      .mocked(deps.setModel)
      .mock.calls.filter(([m]) => m.provider === "b" && m.id === "m2");
    expect(firstCandidateCalls).toHaveLength(1);
  });

  it("skips a candidate whose switch returns false", async () => {
    const deps = makeDeps({
      setModel: vi.fn(async (model) => model.provider === "c"),
    });
    const ctx = makeContext({
      branch: [branchMessage("e1", "error")],
      scopedModels: scoped(["a/m1", "b/m2", "c/m3"]),
      available: ["a/m1", "b/m2", "c/m3"],
    });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result?.continue).toBe(true);
    expect(deps.setModel).toHaveBeenCalledTimes(2);
    expect(deps.debug).toHaveBeenCalledWith("no auth for b/m2 — skipping");
    expect(deps.setCursor).toHaveBeenCalledWith(0);
  });

  it("returns the draft even when the post-switch UI throws", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    ctx.ui.setStatus = vi.fn(() => {
      throw new Error("no ui");
    });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result).toEqual({
      entries: [{ type: "context_edit", targetId: "e1", replacement: null }],
      continue: true,
    });
  });

  it("returns the draft and continuation when the UI availability getter throws after the switch", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    Object.defineProperty(ctx, "hasUI", {
      get() {
        throw new Error("ctx is stale");
      },
    });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result).toEqual({
      entries: [{ type: "context_edit", targetId: "e1", replacement: null }],
      continue: true,
    });
  });

  it("works without a UI and makes no UI calls", async () => {
    const deps = makeDeps();
    const ctx = readyContext();
    ctx.hasUI = false;
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const result = await createBoundaryHandler(deps)(event, ctx);

    expect(result?.continue).toBe(true);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not reject when the warning notify throws after all candidates fail", async () => {
    const deps = makeDeps({ setModel: vi.fn(async () => false) });
    const ctx = readyContext();
    ctx.ui.notify = vi.fn(() => {
      throw new Error("no ui");
    });
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    await expect(createBoundaryHandler(deps)(event, ctx)).resolves.toBeUndefined();
  });
});

describe("createBoundaryHandler — repeated invocations", () => {
  it("advances the cursor on each switch with no budget stop", async () => {
    let cursor = 0;
    const setCursor = vi.fn((next: number) => {
      cursor = next;
    });
    const deps = makeDeps({ getCursor: () => cursor, setCursor });
    const ctx = makeContext({
      branch: [branchMessage("e1", "error")],
      scopedModels: scoped(["a/m1", "b/m2", "c/m3"]),
      available: ["a/m1", "b/m2", "c/m3"],
    });
    const handler = createBoundaryHandler(deps);
    const event = makeEvent({
      context: { contextEntries: [tailError("e1")], canContinue: false },
    });

    const first = await handler(event, ctx);
    const second = await handler(event, ctx);

    expect(first?.continue).toBe(true);
    expect(second?.continue).toBe(true);
    expect(setCursor).toHaveBeenNthCalledWith(1, 2);
    expect(setCursor).toHaveBeenNthCalledWith(2, 0);
    expect(deps.setModel).toHaveBeenNthCalledWith(1, { provider: "b", id: "m2" });
    expect(deps.setModel).toHaveBeenNthCalledWith(2, { provider: "c", id: "m3" });
  });
});
