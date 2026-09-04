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

