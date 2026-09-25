# pi-fallback-provider

Automatic model cycling when the pi agent gets stuck on errors.

## The problem

When an LLM provider fails (rate limit, context overflow, content policy, etc.), pi's built-in retry handles transient errors (429, 5xx). But when retries are exhausted — or the error isn't retryable — the agent just stops. You have to manually switch models and continue from the current context.

## How this extension helps

Instead of classifying errors or intercepting at the transport layer, this
extension rides pi's settle boundary:

```
terminal error
  → pi's own recovery runs: retries, auto-compaction, queued continuations
  → agent_before_settle fires (no automatic recovery left)
  → omit the failed assistant attempt via a model-context edit
  → switch to the next authenticated model
  → pi continues from the same context point — no message is appended
```

- **No error classification** — works for any error type
- **Waits for pi's own recovery** — fires only after retries, auto-compaction,
  and queued continuations are exhausted; no timer heuristics
- **Pre-announce banner** — after an errored turn, the footer shows
  `⚠ error — next: <provider>/<id> if retries fail` while pi retries. It
  clears on a successful or completed turn, a fresh prompt, a successful
  switch, when no candidate exists, and on session shutdown; all status
  updates are UI-gated
- **Appends nothing** — the failed attempt is omitted from future model
  context via an append-only `context_edit`; a `continue` message is never
  injected
- **Aborts are not triggers** — `"aborted"` (ESC) turns never start a
  fallback. ESC during pi's retry backoff cancels that retry, but the
  settlement boundary still switches models; only the re-issue can be dropped
  by an abort during the boundary itself, and pi commits the context edit
  before checking that abort
- **Scoped ordering** — when `enabledModels` is configured, cycles through
  that list in order

## Install

Requires pi **>= v0.87.0** (settlement boundaries and model-context edits
both shipped in 0.87.0; the fallback triggers at the settle boundary).

Install the latest released version:

```bash
pi install npm:@cad0p/pi-fallback-provider
```

Or install the latest prerelease from the `next` dist-tag:

```bash
pi install npm:@cad0p/pi-fallback-provider@next
```

For local development, install from the current git checkout:

```bash
pi install git:github.com/cad0p/pi-fallback-provider@main # or feature branch
```

## Configuration

No extra configuration — it cycles through the models in your pi scope (`enabledModels` / `--models`) that you have authenticated in pi.

Set `PI_FALLBACK_DEBUG=true` for verbose logging:

```bash
PI_FALLBACK_DEBUG=true pi
```

## Manual alias refresh

Use `/fallback-refresh` to manually re-sync multi-account alias providers
from `auth.json` and the live model catalog (same code path `session_start`
runs automatically).

## How it decides which model to try next

When `enabledModels` is configured in pi settings, this extension walks that list in order and skips the current model. Without `enabledModels`, it currently has no fallback candidates to try.

## Multi-account support (auth.json sibling slots)

The fallback loop can rotate across **accounts**, not just models. Any
`auth.json` entry shaped `<provider>-<n>[...]` becomes a first-class alias
provider with the base provider's model catalog, so failover also works when
quota/rate-limit failures are per-account. There is nothing to configure:
add the sibling credential entry and list the alias models in
`enabledModels` in whatever account-vs-model order you want.

### Sibling convention

An entry id is a sibling slot when it splits at the FIRST `-<digits>`
boundary:

| `auth.json` entry | Base | Alias account |
|---|---|---|
| `opencode-2` | `opencode` | `2` |
| `opencode-2-work` | `opencode` | `2-work` |
| `opencode-go-2` | `opencode-go` | `2` |

Non-numeric suffixes are NOT recognized (`opencode-personal` is ignored).
Unknown bases (typo slots, removed providers) warn and skip — they never
break session boot. Alias slots are provisioned by duplicating credential
entries in `auth.json`; `/login` targets known providers only.

### Two-phase registration and the model cache

- **Phase 1 (load):** the extension registers aliases from the MODELS-ONLY
  cache file `<agentDir>/pi-fallback-alias-models.json`, re-applying fresh
  `models.json` inheritance per alias.
- **Phase 2 (`session_start`):** it live-clones the base catalogs from
  `ctx.modelRegistry.getAll()` (so base `models.json` upserts/overrides
  transfer automatically), re-registers the aliases (same ids replace), and
  rewrites the cache — pruning aliases whose slots disappeared.

First launch with no cache registers nothing and heals on `session_start`
(a warn is logged only when `auth.json` actually holds sibling slots; a
bare missing cache is debug). The cache stores models only — never
keys/credentials; only `auth.json` *keys* are ever read.

### models.json inheritance

Per field, the extension-built alias config wins when set; else the
`models.json` ALIAS section wins; else the BASE section fills the gap:

| Field | Alias section wins | Base fills gap | Never inherited |
|---|---|---|---|
| `headers` | ✅ (replace, not merge) | ✅ | — |
| `authHeader` | ✅ | ✅ | — |
| `compat` | ✅ | ✅ | — |
| `baseUrl` (top level) | ✅ | ✅ | — |
| `name` | only when the built config lacks one (the builder always sets `"<base> (<account>)"`) | ✅ | — |
| `apiKey` / `oauth` | — | — | ✅ never copied |

Limitations (all by design, matching pi's provider composition):

1. **Alias-section custom `models` are dropped** — when extension
   `config.models` is present, pi replaces the whole catalog, so custom
   entries cannot survive. Clones always come from the live base catalog.
2. **Header merge is replace-not-merge** — winning `headers` replace the
   field wholesale; keys are never unioned across sections.
3. **Base overrides apply to every alias** — base-section `models` /
   `modelOverrides` bake into the composed base catalog before cloning, so
   an alias can only diverge via a counter-`modelOverrides` entry (which
   itself transfers to all clones of that base).

### Coexistence with pi-multi-account

If you also run a multi-account router extension, exclude the alias ids
from its failover (e.g. via its `neverFailoverProviders` setting) so the
two loops don't fight over the same account slots.

## Differences from existing extensions

| Extension | Approach | Auto on error? | Cycles models? |
|---|---|---|---|
| **pi-fallback-provider (xilnick)** | Transport-level stream interception | Only retryable | Within chain |
| **pi-retry** | `agent_end` hook, same-model retry | Only `aborted` | ❌ Same model |
| **pi-model-switch** | LLM tool for manual switching | ❌ | ✅ Manual |
| **pi-cycle** | F8 hotkey, profile cycling | ❌ | ✅ Manual |
| **This extension** | `agent_before_settle` + model-context edit | ✅ Any error | ✅ Automatic |

## License

MIT
