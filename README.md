# pi-fallback-provider

Automatic model cycling when the pi agent gets stuck on errors.

## The problem

When an LLM provider fails (rate limit, context overflow, content policy, etc.), pi's built-in retry handles transient errors (429, 5xx). But when retries are exhausted — or the error isn't retryable — the agent just stops. You have to manually switch models and re-send your prompt.

## How this extension helps

Instead of classifying errors or intercepting at the transport layer, this extension uses **progress detection**:

```
agent_end fires with stopReason === "error"
  → start 20s timer
  → if turn_start fires → cancel timer (pi is making progress)
  → if timer expires → cycle to next model, re-send last user prompt
```

- **No error classification** — works for any error type
- **Respects pi's retries** — 20s timeout gives pi's built-in retry (3 retries × exponential backoff ≈ 14s) a chance to finish
- **Resets on each failure** — each `agent_end` with error resets the timer, so it waits for the *last* failure's quiet period
- **Skips user aborts** — only triggers on `stopReason === "error"`, not `"aborted"` (ESC)
- **Smart ordering** — prefers the last working model (cached 1h), skips recently failed models (5min cooldown)

## Install

```bash
pi install git:github.com/cad0p/pi-fallback-provider
```

Or copy `index.ts` to `~/.pi/agent/extensions/`.

## Configuration

No configuration needed — it cycles through all models you have authenticated in pi.

Set `PI_FALLBACK_DEBUG=true` for verbose logging:

```bash
PI_FALLBACK_DEBUG=true pi
```

## Manual trigger

Use `/cycle-model` to manually cycle to the next available model at any time.

## How it decides which model to try next

1. **Cached model** — if you recently had a working model, try it first (1h TTL)
2. **Round-robin** — cycles through remaining authenticated models
3. **Failed models last** — models that recently failed are tried as a last resort (5min cooldown)

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
