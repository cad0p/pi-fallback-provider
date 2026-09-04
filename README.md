# pi-fallback-provider

Automatic model cycling when the pi agent gets stuck on errors.

## The problem

When an LLM provider fails (rate limit, context overflow, content policy, etc.), pi's built-in retry handles transient errors (429, 5xx). But when retries are exhausted — or the error isn't retryable — the agent just stops. You have to manually switch models and continue from the current context.

## How this extension helps

Instead of classifying errors or intercepting at the transport layer, this extension uses **progress detection**:

```
agent_end fires with stopReason === "error"
  → start 20s timer
  → if turn_start fires → cancel timer (pi is making progress)
  → if timer expires → cycle to next model, send "continue"
```

- **No error classification** — works for any error type
- **Respects pi's retries** — 20s timeout gives pi's built-in retry (3 retries × exponential backoff ≈ 14s) a chance to finish
- **Sends `continue` after switching** — resumes from the current agent context instead of replaying a stale user request
- **Resets on each failure** — each `agent_end` with error resets the timer, so it waits for the *last* failure's quiet period
- **Skips user aborts** — only triggers on `stopReason === "error"`, not `"aborted"` (ESC)
- **Scoped ordering** — when `enabledModels` is configured, cycles through that list in order

## Install

Requires pi **>= v0.83.0** (first release exposing the live `ctx.scopedModels`
the fallback order walks).

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

No configuration needed — it cycles through all models you have authenticated in pi.

Set `PI_FALLBACK_DEBUG=true` for verbose logging:

```bash
PI_FALLBACK_DEBUG=true pi
```

## Manual trigger

Use `/cycle-model` to manually cycle to the next available model and send `continue`.

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
| **This extension** | `agent_end` + progress timer | ✅ Any error | ✅ Automatic |

## License

MIT
