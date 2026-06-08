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

## How it decides which model to try next

When `enabledModels` is configured in pi settings, this extension walks that list in order and skips the current model. Without `enabledModels`, it currently has no fallback candidates to try.

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
