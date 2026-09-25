/**
 * Settle-boundary fallback helpers (framework-free).
 *
 * When pi exhausts its own retries, compaction, and queued continuations it
 * emits `agent_before_settle` with the turn outcome. On a terminal error this
 * module omits the failed assistant attempt from future model context with a
 * `context_edit` draft, switches to the next authenticated scoped model, and
 * asks pi to continue — no user message is appended.
 *
 * This module contains ZERO pi imports so it can be unit-tested with plain
 * vitest. `index.ts` wires it into the live extension API.
 */

import { buildModelOrder, indexOfScoped } from "./aliases";
import type { ScopedEntry } from "./aliases";

/** Footer status key used for the pre-announce banner. */
export const STATUS_KEY = "pi-fallback";

/** Warning shown when every fallback candidate failed to switch. */
export const ALL_CANDIDATES_FAILED_MESSAGE = "All fallback models exhausted.";

/** Warning shown when the scoped-model list holds no fallback candidate. */
export const NO_CANDIDATES_MESSAGE = "No fallback models available.";

/** Structural view of a boundary draft; only `type` is interpreted here. */
export interface BoundaryDraftLike {
  type: string;
}

/** Omission draft: drops the target entry from future model context. */
export interface ContextEditDraft extends BoundaryDraftLike {
  type: "context_edit";
  targetId: string;
  replacement: null;
}

/** Structural view of one projected context entry (source + visible messages). */
export interface ProjectedEntryLike {
  sourceEntry: { id: string; type?: string };
  messages: Array<{ role?: string; stopReason?: string }>;
}

/** Structural view of the `agent_before_settle` event this module consumes. */
export interface AgentBeforeSettleEventLike {
  type: "agent_before_settle";
  outcome: "completed" | "aborted" | "error";
  entries: BoundaryDraftLike[];
  continue: boolean;
  context: {
    contextEntries: ProjectedEntryLike[];
    canContinue: boolean;
  };
}

/** Structural view of one raw session branch entry. */
export interface BranchEntryLike {
  id: string;
  type?: string;
  message?: { role?: string; stopReason?: string };
}

/** Structural view of the extension context used by the handlers. */
export interface BoundaryContextLike {
  sessionManager: { getBranch(): BranchEntryLike[] };
  scopedModels?: readonly ScopedEntry[];
  model?: { provider: string; id: string } | null;
  modelRegistry: {
    find(provider: string, id: string): { provider: string; id: string } | undefined;
    getAvailable(): Array<{ provider: string; id: string }>;
  };
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
}

/** Side effects the boundary handler needs from the extension host. */
export interface BoundaryDeps {
  setModel(model: { provider: string; id: string }): Promise<boolean>;
  getCursor(): number;
  setCursor(next: number): void;
  debug(...args: unknown[]): void;
}

/** Boundary handler return shape: drafts to commit and whether to continue. */
export type BoundaryResult = {
  entries?: BoundaryDraftLike[];
  continue?: boolean;
};

/**
 * Id of the last raw branch entry that is an assistant message with
 * `stopReason === "error"`, or `undefined` when there is none.
 */
export function findLastErroredAssistantEntryId(
  branch: readonly BranchEntryLike[],
): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    if (entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason !== "error") continue;
    return entry.id;
  }
  return undefined;
}

/**
 * Whether `targetId` owns the last model-visible projection message and that
 * message is an errored assistant reply. Omitted entries (`messages: []`) are
 * skipped, so an entry pi already omitted does not count as the tail.
 */
export function isLastModelVisibleErrorEntry(
  entries: readonly ProjectedEntryLike[],
  targetId: string,
): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.messages.length === 0) continue;
    const last = entry.messages[entry.messages.length - 1];
    return (
      entry.sourceEntry.id === targetId &&
      last?.role === "assistant" &&
      last.stopReason === "error"
    );
  }
  return false;
}

/** Candidate order computed from already-captured host reads. */
function candidateOrderFrom(
  scoped: readonly ScopedEntry[],
  current: { provider: string; id: string } | null | undefined,
  registry: BoundaryContextLike["modelRegistry"],
  cursor: number,
): Array<{ provider: string; id: string }> {
  const order = buildModelOrder(scoped, current?.provider ?? "", current?.id ?? "", cursor);
  const available = new Set(
    registry.getAvailable().map((model) => `${model.provider}/${model.id}`),
  );
  return order.filter((model) => available.has(`${model.provider}/${model.id}`));
}

/**
 * Scoped models to try, in order: the live scope walked from the cursor with
 * the current model skipped, filtered to models the registry reports as
 * available. Both the banner and the switch loop use this ordering.
 */
export function candidateOrder(
  ctx: BoundaryContextLike,
  cursor: number,
): Array<{ provider: string; id: string }> {
  return candidateOrderFrom(ctx.scopedModels ?? [], ctx.model, ctx.modelRegistry, cursor);
}

/** First candidate as a `provider/id` label, or `undefined` when none exist. */
export function nextCandidateLabel(
  ctx: BoundaryContextLike,
  cursor: number,
): string | undefined {
  const first = candidateOrder(ctx, cursor)[0];
  return first ? `${first.provider}/${first.id}` : undefined;
}

export function clearStatus(
  ctx: BoundaryContextLike,
  debug: (...args: unknown[]) => void,
): void {
  try {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  } catch (err) {
    debug(`status update failed: ${err}`);
  }
}

function warn(ctx: BoundaryContextLike, debug: (...args: unknown[]) => void, message: string): void {
  try {
    if (!ctx.hasUI) return;
    ctx.ui.notify(message, "warning");
  } catch (err) {
    debug(`notify failed: ${err}`);
  }
}

/**
 * `turn_end` handler: pre-announce the likely next candidate while pi is still
 * retrying, and clear the banner once the turn settles without an error.
 */
export function createPreAnnounceHandler(deps: Pick<BoundaryDeps, "getCursor" | "debug">): (
  event: { outcome: "completed" | "aborted" | "error" },
  ctx: BoundaryContextLike,
) => Promise<void> {
  return async (event, ctx) => {
    try {
      if (!ctx.hasUI) return;
      if (event.outcome === "error") {
        const next = nextCandidateLabel(ctx, deps.getCursor());
        ctx.ui.setStatus(
          STATUS_KEY,
          next ? `⚠ error — next: ${next} if retries fail` : undefined,
        );
      } else {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    } catch (err) {
      deps.debug(`status update failed: ${err}`);
    }
  };
}

/**
 * `agent_before_settle` handler. On a terminal error: omit the failed
 * assistant attempt from model context (unless pi's own recovery already did),
 * switch to the next authenticated candidate, and return `{ continue: true }`.
 * Every other path returns `undefined` with the status cleared.
 */
export function createBoundaryHandler(deps: BoundaryDeps): (
  event: AgentBeforeSettleEventLike,
  ctx: BoundaryContextLike,
) => Promise<BoundaryResult | undefined> {
  return async (event, ctx) => {
    if (event.outcome !== "error") return undefined;
    deps.debug("agent_before_settle error");

    let draft: ContextEditDraft | undefined;
    let order: Array<{ provider: string; id: string }>;
    let registry: BoundaryContextLike["modelRegistry"];
    let scoped: readonly ScopedEntry[];
    let previous: string;

    try {
      const targetId = findLastErroredAssistantEntryId(ctx.sessionManager.getBranch());

      if (targetId && isLastModelVisibleErrorEntry(event.context.contextEntries, targetId)) {
        draft = { type: "context_edit", targetId, replacement: null };
        deps.debug(`omitting failed attempt ${targetId} from model context`);
      } else if (event.context.canContinue) {
        deps.debug(
          targetId
            ? "pi already omitted the failed attempt — no draft needed"
            : "no errored attempt to omit — no draft needed",
        );
      } else {
        deps.debug("no model-visible errored tail to omit — bailing out");
        clearStatus(ctx, deps.debug);
        return undefined;
      }

      scoped = ctx.scopedModels ?? [];
      const current = ctx.model;
      registry = ctx.modelRegistry;
      order = candidateOrderFrom(scoped, current, registry, deps.getCursor());
      previous = current ? `${current.provider}/${current.id}` : "unknown";
    } catch (err) {
      deps.debug(`host read failed: ${err}`);
      clearStatus(ctx, deps.debug);
      return undefined;
    }

    if (order.length === 0) {
      deps.debug("no authenticated fallback candidates");
      clearStatus(ctx, deps.debug);
      warn(ctx, deps.debug, NO_CANDIDATES_MESSAGE);
      return undefined;
    }

    for (const candidate of order) {
      const key = `${candidate.provider}/${candidate.id}`;
      const model = registry.find(candidate.provider, candidate.id);
      if (!model) {
        deps.debug(`candidate not in registry: ${key}`);
        continue;
      }

      let switched: boolean;
      try {
        switched = await deps.setModel(model);
      } catch (err) {
        deps.debug(`setModel threw for ${key}: ${err}`);
        switched = false;
      }
      if (!switched) {
        deps.debug(`no auth for ${key} — skipping`);
        continue;
      }

      const idx = indexOfScoped(scoped, candidate.provider, candidate.id);
      if (idx >= 0) deps.setCursor((idx + 1) % scoped.length);
      deps.debug(`switched model ${previous} → ${key}`);
      clearStatus(ctx, deps.debug);
      return {
        entries: draft ? [...event.entries, draft] : event.entries,
        continue: true,
      };
    }

    deps.debug("all fallback candidates failed to switch");
    clearStatus(ctx, deps.debug);
    warn(ctx, deps.debug, ALL_CANDIDATES_FAILED_MESSAGE);
    return undefined;
  };
}
