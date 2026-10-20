/**
 * Fixtures shared by the tests: a complete `Model` (pi's type needs every
 * field, the tests only care about provider/id) and the scoped entries built
 * from it.
 */

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";

/** A minimal but complete model for fixtures. */
export function fakeModel(provider: string, id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    provider,
    api: "openai-completions",
    baseUrl: "http://localhost:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

/** `"provider/id"` -> the scoped entry pi holds (`--models` / `enabledModels`). */
export function scopedEntry(reference: string, thinkingLevel?: ModelThinkingLevel): ScopedModel {
  const slash = reference.indexOf("/");
  const entry: ScopedModel = { model: fakeModel(reference.slice(0, slash), reference.slice(slash + 1)) };
  if (thinkingLevel) entry.thinkingLevel = thinkingLevel;
  return entry;
}

/** `["a/m1", "b/m2"]` -> the scoped list pi would hold. */
export function scopedEntries(references: readonly string[]): ScopedModel[] {
  return references.map((reference) => scopedEntry(reference));
}
