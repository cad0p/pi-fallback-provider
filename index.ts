/**
 * pi-fallback-provider — Automatic model cycling when the agent gets stuck.
 *
 * When pi exhausts its own retries, auto-compaction, and queued continuations
 * after a terminal error, it emits `agent_before_settle`. This extension then
 * omits the failed assistant attempt from future model context with a
 * `context_edit` draft, switches to the next authenticated scoped model, and
 * asks pi to continue. No user message is appended and no timer is involved,
 * so the fallback fires exactly when pi's own recovery is exhausted.
 *
 * How it works:
 *   1. `turn_end` with outcome "error" → pre-announce the likely next model
 *   2. `agent_before_settle` → omit the failed attempt, switch model, continue
 *   3. completed/aborted turns, fresh prompts, successful switches, and
 *      session shutdown clear the pre-announce banner
 *
 * Design inspired by:
 *   - georgebashi/pi-retry (progress detection)
 *   - nicobailon/pi-model-switch (pi.setModel, modelRegistry.getAvailable)
 *   - xilnick/pi-fallback-provider (caching, cooldown)
 */

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  readAliasCache,
  readAuthKeys,
  readModelsJsonSection,
  registerCachedAliases,
  syncAliases,
  writeAliasCache,
} from "./aliases";
import type { CloneSourceModel, SyncAliasesResult } from "./aliases";
import {
  clearStatus,
  createBoundaryHandler,
  createPreAnnounceHandler,
} from "./boundary";
import type { BoundaryDeps } from "./boundary";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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

/** Position cursor in the scoped-models array for round-robin. */
let fallbackCursor = 0;

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

  const debug = (...args: unknown[]) => log.debug(...args);

  const boundaryDeps: BoundaryDeps = {
    // The handler passes the live registry object it obtained from
    // `ctx.modelRegistry.find`, so this cast keeps pi's full Model instance.
    setModel: (model) => pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]),
    getCursor: () => fallbackCursor,
    setCursor: (next) => {
      fallbackCursor = next;
    },
    debug,
  };

  const onBoundary = createBoundaryHandler(boundaryDeps);
  const onTurnEnd = createPreAnnounceHandler({ getCursor: () => fallbackCursor, debug });

  // Main hook: pi's retries, compaction, and queued continuations are done.
  pi.on("agent_before_settle", async (event, ctx) => {
    return onBoundary(event, ctx);
  });

  // Pre-announce the likely next model while pi retries; clear the banner
  // once a turn settles without an error.
  pi.on("turn_end", async (event, ctx) => {
    await onTurnEnd(event, ctx);
  });

  // Backstop: a run aborted during retry backoff emits no further turn_end,
  // so clear the banner when the run settles.
  pi.on("agent_settled", async (_event, ctx) => {
    clearStatus(ctx, debug);
  });

  // A fresh user prompt means the episode is over — drop the banner.
  pi.on("before_agent_start", async (_event, ctx) => {
    clearStatus(ctx, debug);
  });

  // Phase 2 (multi-account): live-clone base catalogs into alias
  // providers and rewrite the MODELS-ONLY cache (prunes dead aliases).
  pi.on("session_start", async (_event, ctx) => {
    runAliasSync(ctx);
  });

  // Reset the pre-announce banner on session switch.
  pi.on("session_shutdown", async (_event, ctx) => {
    clearStatus(ctx, debug);
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
}
