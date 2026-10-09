/**
 * Settle-boundary fallback helpers (framework-free).
 *
 * When pi exhausts its own retries, compaction, and queued continuations it
 * emits `agent_before_settle` with the turn outcome. On a terminal error this
 * module omits the failed assistant attempt from future model context with a
 * `context_edit` draft, switches to the next authenticated scoped model, and
 * asks pi to continue — no user message is appended.
 *
 * Consecutive failures form an episode: the pre-announce banner carries the
 * attempt count and elapsed time, and each fallback switch after the first
 * waits an exponential inter-attempt delay so a quota window is paced instead
 * of hammered at provider speed.
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

/** Default inter-attempt backoff base (ms); `0` disables the delay. */
export const DEFAULT_DELAY_MS = 2_000;

/** Default inter-attempt backoff cap (ms). */
export const DEFAULT_MAX_DELAY_MS = 60_000;

/** Node's maximum `setTimeout` delay; larger values fire immediately. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

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
  /** Run abort signal; aborts the inter-attempt delay when the user stops the run. */
  signal?: AbortSignal;
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
}

/** Consecutive errored turns since the last successful, aborted, or fresh turn. */
export interface EpisodeState {
  /** Number of consecutive errored turns (0 when no episode is open). */
  attempts: number;
  /** Clock time of the first error in the episode, or undefined when none. */
  firstErrorAt: number | undefined;
}

/** Exponential inter-attempt backoff policy. `baseMs <= 0` disables the delay. */
export interface FallbackDelayPolicy {
  baseMs: number;
  maxMs: number;
}

/** Side effects the boundary handler needs from the extension host. */
export interface BoundaryDeps {
  setModel(model: { provider: string; id: string }): Promise<boolean>;
  getCursor(): number;
  setCursor(next: number): void;
  debug(...args: unknown[]): void;
  /** Shared consecutive-error episode state (banner count/elapsed + delay input). */
  episode: EpisodeState;
  /** Inter-attempt backoff policy. */
  delay: FallbackDelayPolicy;
  /** Injectable abortable sleep for tests; defaults to {@link sleepAbortable}. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
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

// ---------------------------------------------------------------------------
// Episode state, pacing, and banner formatting
// ---------------------------------------------------------------------------

/** Fresh episode state (no errors yet). */
export function createEpisodeState(): EpisodeState {
  return { attempts: 0, firstErrorAt: undefined };
}

/** Record one more errored turn; the first error opens the episode clock. */
export function noteError(state: EpisodeState, now: number): void {
  if (state.firstErrorAt === undefined) state.firstErrorAt = now;
  state.attempts += 1;
}

/** Close the episode (success, abort, fresh prompt, shutdown). */
export function resetEpisode(state: EpisodeState): void {
  state.attempts = 0;
  state.firstErrorAt = undefined;
}

/** Milliseconds since the first error of the open episode, or 0 when none. */
export function episodeElapsedMs(state: EpisodeState, now: number): number {
  if (state.firstErrorAt === undefined) return 0;
  return Math.max(0, now - state.firstErrorAt);
}

/**
 * Inter-attempt delay before the next fallback switch: none after the first
 * failure, then `min(base × 2^(attempts-2), cap)`; `baseMs <= 0` disables.
 */
export function fallbackDelayMs(policy: FallbackDelayPolicy, attempts: number): number {
  if (!Number.isFinite(policy.baseMs) || policy.baseMs <= 0) return 0;
  if (!Number.isFinite(attempts) || attempts <= 1) return 0;
  const exponent = Math.min(Math.floor(attempts) - 2, 30);
  const delay = policy.baseMs * 2 ** exponent;
  const safe = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
  const cap = Number.isFinite(policy.maxMs) && policy.maxMs > 0 ? policy.maxMs : 0;
  return Math.min(safe, cap);
}

/** Parse an env delay value; undefined/empty/negative/non-numeric → fallback. */
export function parseDelayMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/** Compact episode duration: `15s`, `2m3s`, `12h35m15s`, `1d3h5m`. */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/**
 * Pre-announce banner text. The first failure keeps the original wording; from
 * the second consecutive failure the episode count and elapsed time lead.
 */
export function formatPreAnnounceBanner(next: string, attempts: number, elapsedMs: number): string {
  if (attempts <= 1) return `⚠ error — next: ${next} if retries fail`;
  return `⚠ error #${attempts} · retrying for ${formatDuration(elapsedMs)} — next: ${next}`;
}

/** Raised when the inter-attempt delay is cancelled by the run's abort signal. */
export class DelayAbortedError extends Error {
  constructor() {
    super("Fallback delay aborted");
    this.name = "DelayAbortedError";
  }
}

/** Resolve after `ms`, rejecting with {@link DelayAbortedError} when `signal` aborts. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DelayAbortedError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function finish(err?: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    }
    function onAbort(): void {
      finish(new DelayAbortedError());
    }
    timer = setTimeout(() => finish(), Math.min(Math.max(ms, 0), MAX_TIMEOUT_MS));
    signal?.addEventListener("abort", onAbort, { once: true });
    // The signal may have aborted between the guard above and the listener
    // registration; re-check so that race cannot wait out the full delay.
    if (signal?.aborted) onAbort();
  });
}

/** Close the episode and clear the banner (fresh prompt, settle, shutdown). */
export function resetEpisodeStatus(
  ctx: BoundaryContextLike,
  state: EpisodeState,
  debug: (...args: unknown[]) => void,
): void {
  resetEpisode(state);
  clearStatus(ctx, debug);
}

/**
 * `turn_end` handler: pre-announce the likely next candidate while pi is still
 * retrying, track the consecutive-error episode (count + first-error time) that
 * feeds the boundary delay, and clear the banner once the turn settles without
 * an error.
 */
export function createPreAnnounceHandler(
  deps: Pick<BoundaryDeps, "getCursor" | "debug" | "episode"> & { now?: () => number },
): (
  event: { outcome: "completed" | "aborted" | "error" },
  ctx: BoundaryContextLike,
) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (event, ctx) => {
    try {
      // Episode bookkeeping is behavior (it feeds the boundary delay), so it
      // runs even when there is no UI to render the banner.
      if (event.outcome === "error") {
        noteError(deps.episode, now());
      } else {
        resetEpisode(deps.episode);
      }
      if (!ctx.hasUI) return;
      if (event.outcome === "error") {
        const next = nextCandidateLabel(ctx, deps.getCursor());
        ctx.ui.setStatus(
          STATUS_KEY,
          next
            ? formatPreAnnounceBanner(
                next,
                deps.episode.attempts,
                episodeElapsedMs(deps.episode, now()),
              )
            : undefined,
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

    // Pace repeated fallbacks: no delay after the first failure, then
    // exponential backoff capped by the policy. Aborting the run during the
    // wait settles without continuing.
    const delayMs = fallbackDelayMs(deps.delay, deps.episode.attempts);
    if (delayMs > 0) {
      deps.debug(
        `inter-attempt delay ${delayMs}ms after ${deps.episode.attempts} consecutive error(s)`,
      );
      try {
        await (deps.sleep ?? sleepAbortable)(delayMs, ctx.signal);
      } catch (err) {
        deps.debug(`inter-attempt delay aborted: ${err}`);
        clearStatus(ctx, deps.debug);
        return undefined;
      }
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
