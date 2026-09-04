/**
 * pi-fallback-provider — Automatic model cycling when the agent gets stuck.
 *
 * Unlike transport-level fallbacks, this hooks into `agent_end` and detects
 * when the agent has stopped making progress after an error. It cycles
 * through all available (authenticated) models, sending "continue" each time
 * so the agent resumes from its current context instead of replaying an
 * outdated user request.
 *
 * How it works:
 *   1. `agent_end` fires with stopReason === "error" → start timer
 *   2. `turn_start` fires → cancel timer (pi is retrying / making progress)
 *   3. Timer expires → cycle to next model, send "continue"
 *
 * Design inspired by:
 *   - georgebashi/pi-retry (agent_end hook, progress detection)
 *   - nicobailon/pi-model-switch (pi.setModel, modelRegistry.getAvailable)
 *   - xilnick/pi-fallback-provider (caching, cooldown)
 */

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import {
  buildModelOrder,
  indexOfScoped,
  readAliasCache,
  readAuthKeys,
  readModelsJsonSection,
  registerCachedAliases,
  syncAliases,
  writeAliasCache,
} from "./aliases";
import type { CloneSourceModel, SyncAliasesResult } from "./aliases";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How long to wait after an error before cycling (ms).
 *  Must be longer than pi's built-in retry window (default: 3 retries × 2s
 *  base delay with exponential backoff = ~14s). We use 20s to give pi's
 *  retries a chance to complete. */
const PROGRESS_TIMEOUT_MS = 20_000;

/** Prompt sent after switching models so the agent continues from context. */
const FALLBACK_PROMPT = "continue";

/** Debug logging. */
const DEBUG =
  process.env.PI_FALLBACK_DEBUG === "true" ||
  process.env.PI_FALLBACK_DEBUG === "1";

const log = {
  debug: (...args: unknown[]) => DEBUG && console.log("[pi-fallback]", ...args),
  warn: (...args: unknown[]) => console.warn("[pi-fallback]", ...args),
  error: (...args: unknown[]) => console.error("[pi-fallback]", ...args),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Active progress timer. */
let progressTimer: ReturnType<typeof setTimeout> | null = null;

/** Position cursor in the scoped-models array for round-robin. */
let fallbackCursor = 0;

/** Countdown interval for status bar updates. */
let countdownInterval: ReturnType<typeof setInterval> | null = null;

/** Captured ctx for countdown updates. */
let capturedCtx: ExtensionContext | null = null;

/** TUI reference for focus detection. */
let tuiRef: TUI | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearFallbackState(ctx?: ExtensionContext): void {
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  (capturedCtx || ctx)?.ui.setStatus("pi-fallback", undefined);
  capturedCtx = null;
}

function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piFallbackProvider(pi: ExtensionAPI) {
  log.debug("Loading extension");

  // Phase 1 (multi-account): register alias providers from the MODELS-ONLY
  // cache file. Graceful when absent (first run heals on session_start).
  // Inheritance is re-applied with a fresh models.json read per alias.
  // Never throws — a factory failure must not break extension load.
  try {
    const agentDir = getAgentDir();
    registerCachedAliases({
      readCache: () => readAliasCache(agentDir, (m) => log.warn(m)),
      readAuthKeys: () => readAuthKeys(agentDir),
      readSection: (id) => readModelsJsonSection(agentDir, id, (m) => log.warn(m)),
      // Structural cast: our per-model `samplingParams` is accepted by the
      // runtime ProviderConfigInput but missing from the public
      // ProviderModelConfig type (see aliases.ts buildAliasConfig docs).
      register: (aliasId, config) => pi.registerProvider(aliasId, config as unknown as ProviderConfig),
      warn: (m) => log.warn(m),
      debug: (m) => log.debug(m),
    });
  } catch (err) {
    log.warn(`Alias Phase-1 registration failed: ${err}`);
  }


  // Detect progress: if the agent starts a new turn, cancel the timer.
  pi.on("turn_start", async () => {
    if (progressTimer || countdownInterval) {
      log.debug("turn_start detected — cancelling fallback");
      clearFallbackState();
    }
  });

  // Main hook: when agent ends with an error, start the progress timer.
  pi.on("agent_end", async (event, ctx) => {
    // Find the last assistant message
    const lastAssistant = [...event.messages]
      .reverse()
      .find((m: any) => m.role === "assistant") as any;

    if (!lastAssistant) return;

    // User pressed ESC during agent run — cancel any pending fallback
    if (lastAssistant.stopReason === "aborted") {
      if (progressTimer || countdownInterval) {
        log.debug("User aborted — cancelling fallback");
        clearFallbackState(ctx);
      }
      return;
    }

    // Only trigger on actual errors
    if (lastAssistant.stopReason !== "error") return;

    const errorMessage: string = lastAssistant.errorMessage || "";
    log.debug(`agent_end with error: ${errorMessage}`);

    // Clear any existing timer
    if (progressTimer) {
      clearTimeout(progressTimer);
    }

    // Show status bar countdown
    capturedCtx = ctx;
    const totalSec = Math.round(PROGRESS_TIMEOUT_MS / 1000);
    let remainingSec = totalSec;
    ctx.ui.setStatus("pi-fallback", `⚠ agent error — fallback in ${remainingSec}s (esc to cancel)`);

    countdownInterval = setInterval(() => {
      remainingSec--;
      if (remainingSec <= 0) {
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = null;
        return;
      }
      capturedCtx?.ui.setStatus("pi-fallback", `⚠ agent error — fallback in ${remainingSec}s (esc to cancel)`);
    }, 1000);

    // Start the progress timer
    progressTimer = setTimeout(() => {
      clearFallbackState();
      log.debug("Progress timer expired — cycling model");
      cycleModel(ctx);
    }, PROGRESS_TIMEOUT_MS);

    log.debug(`Progress timer started (${PROGRESS_TIMEOUT_MS}ms)`);
  });

  // Capture TUI reference and set up ESC handler
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("__pi-fallback-tui-probe", (tui: TUI) => {
      tuiRef = tui;
      return { render: () => [] };
    }, { placement: "aboveEditor" });
    ctx.ui.setWidget("__pi-fallback-tui-probe", undefined);

    ctx.ui.onTerminalInput((data: string) => {
      if (!matchesKey(data, "escape")) return;
      if (!progressTimer && !countdownInterval) return;

      log.debug("ESC pressed — cancelling fallback timer");
      clearFallbackState(ctx);
      return { consume: true };
    });

    // Phase 2 (multi-account): live-clone base catalogs into alias
    // providers and rewrite the MODELS-ONLY cache (prunes dead aliases).
    runAliasSync(ctx);
  });

  // Reset state on session switch
  pi.on("session_shutdown", async () => {
    clearFallbackState();
  });

  // Register a manual /cycle-next command for testing
  pi.registerCommand("cycle-model", {
    description: "Cycle to the next available model and send continue (manual trigger)",
    handler: async (_args, ctx) => {
      await cycleModel(ctx);
    },
  });

  // Manual alias re-sync (same code path as session_start Phase 2).
  pi.registerCommand("fallback-refresh", {
    description: "Re-sync multi-account alias providers from auth.json and live models",
    handler: async (_args, ctx) => {
      const result = runAliasSync(ctx);
      if (!result) {
        ctx.ui.notify("Alias refresh failed (see logs).", "error");
      } else if (result.aborted) {
        ctx.ui.notify("Alias refresh aborted: could not read auth.json.", "warning");
      } else {
        ctx.ui.notify(`Refreshed ${result.registered.length} alias provider(s).`, "info");
      }
    },
  });

  // Phase-2 body shared by session_start and /fallback-refresh.
  // Post-bind registration takes effect immediately. Never throws — a
  // throwing session_start handler must not break session boot.
  function runAliasSync(ctx: ExtensionContext): SyncAliasesResult | undefined {
    try {
      const agentDir = getAgentDir();
      const byProvider = new Map<string, CloneSourceModel[]>();
      for (const m of ctx.modelRegistry.getAll()) {
        const provider = (m as { provider?: unknown }).provider;
        if (typeof provider !== "string") continue;
        const list = byProvider.get(provider) ?? [];
        list.push(m as unknown as CloneSourceModel);
        byProvider.set(provider, list);
      }
      return syncAliases({
        readAuthKeys: () => readAuthKeys(agentDir),
        getBaseModels: (base) => byProvider.get(base) ?? [],
        readSection: (id) => readModelsJsonSection(agentDir, id, (msg) => log.warn(msg)),
        // Structural cast: see Phase-1 register for the samplingParams note.
        register: (aliasId, config) => pi.registerProvider(aliasId, config as unknown as ProviderConfig),
        writeCache: (aliases) => writeAliasCache(agentDir, aliases),
        warn: (m) => log.warn(m),
        debug: (m) => log.debug(m),
      });
    } catch (err) {
      log.warn(`Alias sync failed: ${err}`);
      return undefined;
    }
  }

  // Core cycling logic
  async function cycleModel(ctx: ExtensionContext): Promise<void> {
    const current = ctx.model;
    if (!current) {
      log.warn("No current model — cannot cycle");
      return;
    }

    const available = ctx.modelRegistry.getAvailable();
    if (available.length <= 1) {
      log.warn("Only one model available — cannot cycle");
      ctx.ui.notify("Only one model available, cannot cycle.", "warning");
      return;
    }

    const scoped = ctx.scopedModels ?? [];
    if (ctx.scopedModels == null) {
      // Old pi without live scoping (needs pi >= v0.83.0) — no file fallback.
      log.warn("ctx.scopedModels is unavailable (pi >= v0.83.0 required) — cannot build fallback order");
    }
    const order = buildModelOrder(scoped, current.provider, current.id, fallbackCursor);
    if (order.length === 0) {
      log.warn("No models available to cycle to");
      ctx.ui.notify("No fallback models available.", "error");
      return;
    }

    log.debug(`Cycling: trying ${order.length} models starting with ${modelKey(order[0].provider, order[0].id)}`);
    log.debug(`order: ${order.map((m) => modelKey(m.provider, m.id)).join(", ")}`);

    for (const candidate of order) {
      const key = modelKey(candidate.provider, candidate.id);
      log.debug(`Trying: ${key}`);

      const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
      if (!model) {
        log.warn(`Model not found in registry: ${key}`);
        continue;
      }

      let success: boolean;
      try {
        success = await pi.setModel(model);
      } catch (err) {
        log.warn(`setModel failed for ${key}: ${err}`);
        success = false;
      }

      if (!success) {
        log.warn(`No auth for ${key}, skipping`);
        continue;
      }

      // Success — advance cursor past this model in the live scope array
      if (scoped.length > 0) {
        const modelIdx = indexOfScoped(scoped, candidate.provider, candidate.id);
        if (modelIdx >= 0) fallbackCursor = (modelIdx + 1) % scoped.length;
      }

      ctx.ui.notify(`Switched to ${key} (previous model failed)`, "info");
      log.debug(`Switched to ${key}`);

      // Send "continue" so the agent resumes from its current context instead
      // of replaying a stale user request from before the failed turn.
      log.debug(`Sending fallback prompt: ${FALLBACK_PROMPT}`);
      pi.sendUserMessage(FALLBACK_PROMPT);
      return;
    }

    // All candidates failed
    log.error("All model candidates failed");
    ctx.ui.notify("All fallback models exhausted.", "error");
  }
}
