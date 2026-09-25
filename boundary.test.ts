import { describe, expect, it, vi } from "vitest";

import {
  ALL_CANDIDATES_FAILED_MESSAGE,
  NO_CANDIDATES_MESSAGE,
  STATUS_KEY,
  candidateOrder,
  createBoundaryHandler,
  createPreAnnounceHandler,
  findLastErroredAssistantEntryId,
  isLastModelVisibleErrorEntry,
  nextCandidateLabel,
} from "./boundary";
import type {
  AgentBeforeSettleEventLike,
  BoundaryContextLike,
  BoundaryDeps,
  BoundaryDraftLike,
  BranchEntryLike,
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
    ...overrides,
  };
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
// Pre-announce
// ---------------------------------------------------------------------------

describe("createPreAnnounceHandler", () => {
  it("pins the status key and the warning literals", () => {
    expect(STATUS_KEY).toBe("pi-fallback");
    expect(ALL_CANDIDATES_FAILED_MESSAGE).toBe("All fallback models exhausted.");
    expect(NO_CANDIDATES_MESSAGE).toBe("No fallback models available.");
  });

  it("sets the byte-exact banner on an errored turn when a candidate exists", async () => {
    const ctx = readyContext();
    const handler = createPreAnnounceHandler({ getCursor: () => 0, debug: vi.fn() });
    await handler({ outcome: "error" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      "⚠ error — next: b/m2 if retries fail",
    );
  });

  it("clears the banner on completed and aborted turns", async () => {
    const handler = createPreAnnounceHandler({ getCursor: () => 0, debug: vi.fn() });
    for (const outcome of ["completed", "aborted"] as const) {
      const ctx = readyContext();
      await handler({ outcome }, ctx);
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
    }
  });

  it("clears the banner on an errored turn when no candidate is available", async () => {
    const ctx = makeContext();
    const handler = createPreAnnounceHandler({ getCursor: () => 0, debug: vi.fn() });
    await handler({ outcome: "error" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("makes no UI calls without a UI", async () => {
    const ctx = readyContext();
    ctx.hasUI = false;
    const handler = createPreAnnounceHandler({ getCursor: () => 0, debug: vi.fn() });
    await handler({ outcome: "error" }, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("does not reject when the UI throws", async () => {
    const ctx = readyContext();
    ctx.ui.setStatus = vi.fn(() => {
      throw new Error("no ui");
    });
    const handler = createPreAnnounceHandler({ getCursor: () => 0, debug: vi.fn() });
    await expect(handler({ outcome: "error" }, ctx)).resolves.toBeUndefined();
  });

  it("does not reject when the UI availability getter throws", async () => {
    const ctx = readyContext();
    Object.defineProperty(ctx, "hasUI", {
      get() {
        throw new Error("ctx is stale");
      },
    });
    const handler = createPreAnnounceHandler({ getCursor: () => 0, debug: vi.fn() });
    await expect(handler({ outcome: "error" }, ctx)).resolves.toBeUndefined();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Boundary handler
// ---------------------------------------------------------------------------

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
