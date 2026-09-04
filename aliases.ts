/**
 * Multi-account alias helpers (framework-free).
 *
 * This module contains ZERO pi imports so it can be unit-tested with plain
 * vitest. `index.ts` wires these helpers into the live extension API
 * (`pi.registerProvider`, `ctx.modelRegistry`, `ctx.scopedModels`).
 *
 * Sibling-slot convention: any `auth.json` entry shaped `<provider>-<n>[...]`
 * (e.g. `opencode-2`, `opencode-2-work`) becomes a first-class alias provider
 * with the base provider's model catalog, so the `agent_end` → timer →
 * `cycleModel` loop can fail over when quota/rate-limit failures are
 * per-account. Non-numeric suffixes (e.g. `opencode-personal`) are NOT
 * recognized.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// §2. Sibling-slot parser + grouping (pure)
// ---------------------------------------------------------------------------

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Split an auth entry id at the FIRST `-<digits>` boundary.
 *
 *   opencode-2-work → { base: "opencode", account: "2-work" }
 *   opencode-go-2   → { base: "opencode-go", account: "2" }
 *   opencode-personal → null (non-numeric suffix, not recognized)
 *   opencode          → null (no suffix)
 */
export function parseAliasId(entryId: string): { base: string; account: string } | null {
  for (let i = 0; i < entryId.length - 1; i++) {
    if (entryId[i] === "-" && isDigit(entryId[i + 1])) {
      const base = entryId.slice(0, i);
      if (!base) return null;
      return { base, account: entryId.slice(i + 1) };
    }
  }
  return null;
}

/**
 * Group alias entry ids by base provider. Dedups, sorts each group
 * deterministically, and skips self-mappings.
 */
export function groupSiblings(authKeys: string[]): Map<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const key of authKeys) {
    const parsed = parseAliasId(key);
    if (!parsed) continue;
    if (parsed.base === key) continue;
    let set = groups.get(parsed.base);
    if (!set) {
      set = new Set<string>();
      groups.set(parsed.base, set);
    }
    set.add(key);
  }
  const out = new Map<string, string[]>();
  for (const [base, set] of groups) out.set(base, [...set].sort());
  return out;
}

// ---------------------------------------------------------------------------
// §3. Alias-config builder (pure)
// ---------------------------------------------------------------------------

/** Minimal structural view of a live registry model used as a clone source. */
export interface CloneSourceModel {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: unknown;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; [k: string]: unknown };
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  // Tolerate live-registry extras (provider, headers, ...) — never cloned.
  [key: string]: unknown;
}

/** Per-model config for an alias provider registration / cache entry. */
export interface AliasModelDef {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: unknown;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; [k: string]: unknown };
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

/** Provider-level config built for `pi.registerProvider(aliasId, config)`. */
export interface AliasProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: AliasModelDef[];
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepClone(v);
    return out as T;
  }
  return value;
}

function shallowClone(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return { ...value };
  return value;
}

/** Provider display name for an alias slot: `"<base> (<account>)"`. */
export function aliasDisplayName(base: string, account: string): string {
  return `${base} (${account})`;
}

/** Top-level `api` for a model list — set only when uniform, else undefined. */
function uniformApi(models: Array<{ api?: string }>): string | undefined {
  if (models.length === 0) return undefined;
  const first = models[0].api;
  if (first === undefined) return undefined;
  return models.every((m) => m.api === first) ? first : undefined;
}

/**
 * Build an alias provider config by per-model cloning the base catalog.
 *
 * Clones exactly: id, name, api, baseUrl, reasoning, input, cost,
 * contextWindow, maxTokens, thinkingLevelMap, samplingParams, compat.
 * NEVER sets `apiKey` (alias auth resolves from the alias's own auth.json
 * slot), `streamSimple`, or `oauth`. Per-model `headers` are dropped — pi's
 * provider composition forces extension per-model headers to `undefined`.
 *
 * NOTE on `samplingParams`: pi's public `ProviderModelConfig` type omits it
 * while the runtime `ProviderConfigInput.models[]` accepts it
 * (provider-composer.ts). Callers pass this config through a structural cast.
 */
export function buildAliasConfig(
  aliasId: string,
  base: string,
  baseModels: CloneSourceModel[],
  opts?: { label?: string },
): AliasProviderConfig {
  const account = opts?.label ?? parseAliasId(aliasId)?.account ?? aliasId;
  const models: AliasModelDef[] = baseModels.map((m) => {
    const def: AliasModelDef = {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: [...m.input],
      cost: deepClone(m.cost),
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    };
    if (m.api !== undefined) def.api = m.api;
    if (m.baseUrl !== undefined) def.baseUrl = m.baseUrl;
    if (m.thinkingLevelMap !== undefined) def.thinkingLevelMap = shallowClone(m.thinkingLevelMap);
    if (m.samplingParams !== undefined) def.samplingParams = deepClone(m.samplingParams);
    if (m.compat !== undefined) def.compat = deepClone(m.compat);
    return def;
  });
  const config: AliasProviderConfig = {
    name: aliasDisplayName(base, account),
    models,
  };
  // Top-level `api` only when uniform across base models (per-model `api`
  // is always set); otherwise omit so per-model values govern.
  const api = uniformApi(baseModels);
  if (api !== undefined) config.api = api;
  return config;
}

// ---------------------------------------------------------------------------
// §4. models.json inheritance merge (pure) + raw reader
// ---------------------------------------------------------------------------

/** A `models.json` provider section (base or alias). */
export interface ModelsJsonProviderSection {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  oauth?: unknown;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  models?: unknown;
  modelOverrides?: unknown;
  [key: string]: unknown;
}

export type WarnFn = (message: string) => void;

/** Fields inherited from models.json sections. NEVER apiKey/oauth. */
const INHERITED_FIELDS = ["headers", "authHeader", "compat", "baseUrl", "name"] as const;

/**
 * Conditional-fill inheritance from models.json sections.
 *
 * Per field (`headers`, `authHeader`, `compat`, `baseUrl`, `name`): the
 * extension-built alias config wins when set; else the models.json ALIAS
 * section wins; else the BASE section fills the gap; else the field stays
 * absent. `baseUrl` is top-level only — cloned per-model `baseUrl` values
 * are never touched. Header merge is replace-not-merge (no key union).
 * `apiKey`/`oauth` are never copied. Alias-section custom `models` are
 * dropped (pi's provider composition replaces the whole catalog when
 * extension `config.models` is present, so they cannot survive anyway).
 */
export function applyInheritance(
  aliasConfig: AliasProviderConfig,
  baseSection: ModelsJsonProviderSection | undefined,
  aliasSection: ModelsJsonProviderSection | undefined,
): AliasProviderConfig {
  const out: AliasProviderConfig = { ...aliasConfig };
  for (const field of INHERITED_FIELDS) {
    if (out[field] !== undefined) continue;
    const fromAlias = aliasSection?.[field];
    if (fromAlias !== undefined) {
      (out as Record<string, unknown>)[field] = deepClone(fromAlias);
      continue;
    }
    const fromBase = baseSection?.[field];
    if (fromBase !== undefined) {
      (out as Record<string, unknown>)[field] = deepClone(fromBase);
    }
  }
  return out;
}

/**
 * Read one provider section from `<agentDir>/models.json`. Returns undefined
 * when the file is missing (normal — nothing to inherit) or holds no such
 * section. Malformed file → warn + undefined (never throws in the factory
 * path). Read fresh in BOTH phases; the alias cache stores MODELS ONLY.
 */
export function readModelsJsonSection(
  agentDir: string,
  providerId: string,
  warn: WarnFn = console.warn.bind(console),
): ModelsJsonProviderSection | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(agentDir, "models.json"), "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { providers?: Record<string, ModelsJsonProviderSection> };
    return parsed?.providers?.[providerId];
  } catch (err) {
    warn(`[pi-fallback] Could not parse models.json: ${err}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// §5. Alias model-cache file helpers
// ---------------------------------------------------------------------------

/** Cache file shape: MODELS ONLY, never keys/credentials. */
export interface AliasCacheEntry {
  base: string;
  account: string;
  models: AliasModelDef[];
}

export interface AliasCacheFile {
  version: 1;
  updatedAt: string;
  aliases: Record<string, AliasCacheEntry>;
}

export const ALIAS_CACHE_VERSION = 1 as const;
export const ALIAS_CACHE_FILENAME = "pi-fallback-alias-models.json";

export function cachePath(agentDir: string): string {
  return join(agentDir, ALIAS_CACHE_FILENAME);
}

/** Rebuild one cached model through the known-field whitelist. */
function sanitizeModel(model: AliasModelDef): AliasModelDef {
  const out: AliasModelDef = {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: deepClone(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
  if (model.api !== undefined) out.api = model.api;
  if (model.baseUrl !== undefined) out.baseUrl = model.baseUrl;
  if (model.thinkingLevelMap !== undefined) out.thinkingLevelMap = deepClone(model.thinkingLevelMap);
  if (model.samplingParams !== undefined) out.samplingParams = deepClone(model.samplingParams);
  if (model.compat !== undefined) out.compat = deepClone(model.compat);
  return out;
}

function isCacheEntry(value: unknown): value is AliasCacheEntry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.base === "string" && typeof e.account === "string" && Array.isArray(e.models);
}

/**
 * Read the alias model cache. Missing file → empty (silent: first launch is
 * normal; Phase 1 escalates to warn only when auth.json holds sibling
 * slots). Corrupt file / version mismatch → warn + empty.
 */
export function readAliasCache(
  agentDir: string,
  warn: WarnFn = console.warn.bind(console),
): Record<string, AliasCacheEntry> {
  let raw: string;
  try {
    raw = readFileSync(cachePath(agentDir), "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AliasCacheFile>;
    if (parsed?.version !== ALIAS_CACHE_VERSION || parsed.aliases === null || typeof parsed.aliases !== "object") {
      warn(`[pi-fallback] Ignoring alias model cache (unsupported version or shape)`);
      return {};
    }
    const out: Record<string, AliasCacheEntry> = {};
    for (const [aliasId, entry] of Object.entries(parsed.aliases)) {
      if (!isCacheEntry(entry)) {
        warn(`[pi-fallback] Ignoring malformed cache entry for alias "${aliasId}"`);
        continue;
      }
      out[aliasId] = { base: entry.base, account: entry.account, models: entry.models.map(sanitizeModel) };
    }
    return out;
  } catch (err) {
    warn(`[pi-fallback] Could not parse alias model cache: ${err}`);
    return {};
  }
}

/**
 * Write the alias model cache atomically (tmp + rename). Models are
 * sanitized through the known-field whitelist, so even a caller-passed
 * `apiKey` (or any other secret/extra) never reaches disk.
 */
export function writeAliasCache(
  agentDir: string,
  aliases: Record<string, AliasCacheEntry>,
  opts?: { now?: () => string },
): void {
  const sanitized: Record<string, AliasCacheEntry> = {};
  for (const [aliasId, entry] of Object.entries(aliases)) {
    sanitized[aliasId] = {
      base: entry.base,
      account: entry.account,
      models: entry.models.map(sanitizeModel),
    };
  }
  const file: AliasCacheFile = {
    version: ALIAS_CACHE_VERSION,
    updatedAt: opts?.now ? opts.now() : new Date().toISOString(),
    aliases: sanitized,
  };
  const dest = cachePath(agentDir);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
  renameSync(tmp, dest);
}

// ---------------------------------------------------------------------------
// §6. Phase 1 — load-time registration from cache (injectable core)
// ---------------------------------------------------------------------------

/**
 * Read auth.json KEYS only (values are credentials — never read/log them).
 * Throws on missing/malformed file; callers translate that into warn + skip.
 */
export function readAuthKeys(agentDir: string): string[] {
  const raw = readFileSync(join(agentDir, "auth.json"), "utf-8");
  return Object.keys(JSON.parse(raw));
}

export interface Phase1Deps {
  readCache: () => Record<string, AliasCacheEntry>;
  readAuthKeys: () => string[];
  readSection: (providerId: string) => ModelsJsonProviderSection | undefined;
  register: (aliasId: string, config: AliasProviderConfig) => void;
  warn?: WarnFn;
  debug?: WarnFn;
}

/**
 * Register cached alias providers at extension load (Phase 1).
 *
 * For each cached alias id the base is re-parsed (unparseable ids are
 * skipped with a warn) and §4 inheritance is re-applied with a FRESH
 * models.json read, so user settings changes apply without waiting for
 * `session_start`. Returns the registered alias ids. Never throws — the
 * factory has no `ctx` and must not break extension load.
 *
 * No cache file → registers nothing. Logs at debug, escalating to warn
 * only when auth.json actually contains sibling slots (real degradation
 * vs nothing configured).
 */
export function registerCachedAliases(deps: Phase1Deps): string[] {
  const warn = deps.warn ?? (() => {});
  const debug = deps.debug ?? (() => {});
  let cache: Record<string, AliasCacheEntry>;
  try {
    cache = deps.readCache();
  } catch (err) {
    warn(`[pi-fallback] Could not read alias model cache: ${err}`);
    return [];
  }
  const ids = Object.keys(cache);
  if (ids.length === 0) {
    let degraded = false;
    try {
      degraded = groupSiblings(deps.readAuthKeys()).size > 0;
    } catch {
      degraded = false;
    }
    (degraded ? warn : debug)(
      `[pi-fallback] No cached alias models; aliases will register on session_start`,
    );
    return [];
  }
  const registered: string[] = [];
  for (const [aliasId, entry] of Object.entries(cache)) {
    const parsed = parseAliasId(aliasId);
    if (!parsed) {
      warn(`[pi-fallback] Skipping cached alias with unparseable id "${aliasId}"`);
      continue;
    }
    const base = entry?.base ?? parsed.base;
    const account = entry?.account ?? parsed.account;
    const models = Array.isArray(entry?.models) ? entry.models : [];
    const rebuilt: AliasProviderConfig = { name: aliasDisplayName(base, account), models };
    const api = uniformApi(models);
    if (api !== undefined) rebuilt.api = api;
    const config = applyInheritance(rebuilt, deps.readSection(base), deps.readSection(aliasId));
    try {
      deps.register(aliasId, config);
      registered.push(aliasId);
    } catch (err) {
      warn(`[pi-fallback] Failed to register cached alias "${aliasId}": ${err}`);
    }
  }
  return registered;
}

// ---------------------------------------------------------------------------
// §7. Phase 2 — session_start live-clone + cache rewrite (injectable core)
// ---------------------------------------------------------------------------

export interface SyncAliasesDeps {
  readAuthKeys: () => string[];
  getBaseModels: (base: string) => CloneSourceModel[];
  readSection: (providerId: string) => ModelsJsonProviderSection | undefined;
  register: (aliasId: string, config: AliasProviderConfig) => void;
  writeCache: (aliases: Record<string, AliasCacheEntry>) => void;
  warn?: WarnFn;
  debug?: WarnFn;
}

export interface SyncAliasesResult {
  registered: string[];
  skipped: string[];
  aborted: boolean;
}

/**
 * Live-clone base catalogs into alias providers (Phase 2).
 *
 * Reads auth.json KEYS only (values are never logged); malformed file →
 * warn + abort sync, never throw. Each sibling group resolves its base via
 * `getBaseModels` (live composed `ctx.modelRegistry.getAll()` grouped by
 * `model.provider`, so base upserts/overrides transfer automatically) —
 * unknown/empty base catalog → warn-and-skip. Fresh models.json
 * inheritance is applied per alias, then `register` (post-bind → immediate
 * effect). The cache is rewritten with the live models, pruning dead
 * aliases. Idempotent: same-id re-registration replaces.
 */
export function syncAliases(deps: SyncAliasesDeps): SyncAliasesResult {
  const warn = deps.warn ?? (() => {});
  const debug = deps.debug ?? (() => {});
  let keys: string[];
  try {
    keys = deps.readAuthKeys();
  } catch (err) {
    warn(`[pi-fallback] Could not read auth.json, aborting alias sync: ${err}`);
    return { registered: [], skipped: [], aborted: true };
  }
  const registered: string[] = [];
  const skipped: string[] = [];
  const cache: Record<string, AliasCacheEntry> = {};
  for (const [base, aliasIds] of groupSiblings(keys)) {
    let baseModels: CloneSourceModel[];
    try {
      baseModels = deps.getBaseModels(base);
    } catch (err) {
      warn(`[pi-fallback] Could not list models for base provider "${base}": ${err}`);
      skipped.push(...aliasIds);
      continue;
    }
    if (!baseModels || baseModels.length === 0) {
      warn(`[pi-fallback] Unknown base provider "${base}" — skipping alias(es) ${aliasIds.join(", ")}`);
      skipped.push(...aliasIds);
      continue;
    }
    for (const aliasId of aliasIds) {
      const account = parseAliasId(aliasId)?.account ?? aliasId;
      try {
        const config = applyInheritance(
          buildAliasConfig(aliasId, base, baseModels),
          deps.readSection(base),
          deps.readSection(aliasId),
        );
        deps.register(aliasId, config);
        registered.push(aliasId);
        cache[aliasId] = { base, account, models: config.models ?? [] };
      } catch (err) {
        warn(`[pi-fallback] Failed to sync alias "${aliasId}": ${err}`);
        skipped.push(aliasId);
      }
    }
  }
  try {
    deps.writeCache(cache);
  } catch (err) {
    warn(`[pi-fallback] Could not write alias model cache: ${err}`);
  }
  debug(`[pi-fallback] Alias sync: ${registered.length} registered, ${skipped.length} skipped`);
  return { registered, skipped, aborted: false };
}

