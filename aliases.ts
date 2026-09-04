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
    name: `${base} (${account})`,
    models,
  };
  // Top-level `api` only when uniform across base models (per-model `api`
  // is always set); otherwise omit so per-model values govern.
  if (baseModels.length > 0 && baseModels.every((m) => m.api !== undefined && m.api === baseModels[0].api)) {
    config.api = baseModels[0].api;
  }
  return config;
}

