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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Path to pi settings file. */
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

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

/** Scoped models from settings.json (enabledModels). */
let scopedModels: string[] | null = null;

/** Position cursor in the enabledModels array for round-robin. */
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

/** Split a "provider/id" string (id may contain slashes). */
function parseModelEntry(s: string): { provider: string; id: string } {
  const slash = s.indexOf("/");
  if (slash === -1) return { provider: "", id: s };
  return { provider: s.slice(0, slash), id: s.slice(slash + 1) };
}

/**
 * Load scoped models from settings.json (enabledModels field).
 * Returns null if no enabledModels configured (falls back to all available).
 */
function loadScopedModels(): string[] | null {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    if (Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0) {
      log.debug(`Loaded ${settings.enabledModels.length} scoped models from settings`);
      return settings.enabledModels;
    }
  } catch (err) {
    log.warn(`Could not read settings from ${SETTINGS_PATH}: ${err}`);
  }
  return null;
}

/** Build the ordered list of models to try.
 *  Walks enabledModels from fallbackCursor, skipping the current model. */
function buildModelOrder(
  currentProvider: string,
  currentId: string,
): Array<{ provider: string; id: string }> {
  const src = scopedModels;
  if (!src || src.length === 0) return [];

  const order: Array<{ provider: string; id: string }> = [];
  for (let i = 0; i < src.length; i++) {
    const { provider, id } = parseModelEntry(src[(fallbackCursor + i) % src.length]);
    if (provider === currentProvider && id === currentId) continue;
    order.push({ provider, id });
  }
  return order;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piFallbackProvider(pi: ExtensionAPI) {
  log.debug("Loading extension");
  scopedModels = loadScopedModels();


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

    const order = buildModelOrder(current.provider, current.id);
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

      // Success — advance cursor past this model in the enabledModels list
      if (scopedModels) {
        const modelIdx = scopedModels.findIndex((s) => {
          const { provider: sp, id: sid } = parseModelEntry(s);
          return sp === candidate.provider && sid === candidate.id;
        });
        if (modelIdx >= 0) fallbackCursor = (modelIdx + 1) % scopedModels.length;
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
