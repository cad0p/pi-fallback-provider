import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The settle-boundary fallback re-issues failed attempts by editing model
 * context, so the extension must not inject messages: no `sendUserMessage`
 * call sites, and no manual `/cycle-model` command that would append one.
 */
describe("no-message-injection regression", () => {
  it("has no sendUserMessage call sites in the extension sources", () => {
    for (const file of ["index.ts", "boundary.ts"]) {
      expect(readFileSync(file, "utf-8")).not.toContain("sendUserMessage");
    }
  });

  it("has no /cycle-model command in the sources or README", () => {
    for (const file of ["index.ts", "README.md"]) {
      expect(readFileSync(file, "utf-8")).not.toContain("/cycle-model");
    }
  });

  it("does not re-register the cycle-model command", () => {
    expect(readFileSync("index.ts", "utf-8")).not.toContain('registerCommand("cycle-model"');
  });
});

/**
 * `index.ts` cannot be imported under vitest (pi modules resolve only inside
 * the real agent), so the boundary trigger is pinned at the source level.
 */
describe("boundary wiring regression", () => {
  it("registers the settle-boundary and turn_end handlers", () => {
    const source = readFileSync("index.ts", "utf-8");
    expect(source).toContain('pi.on("agent_before_settle"');
    expect(source).toContain('pi.on("turn_end"');
  });

  it("delegates each registered handler to its own boundary logic", () => {
    const source = readFileSync("index.ts", "utf-8");
    const boundaryBody = source.slice(
      source.indexOf('pi.on("agent_before_settle"'),
      source.indexOf('pi.on("turn_end"'),
    );
    expect(boundaryBody).toContain("return (await onBoundary(event, ctx))");
    expect(boundaryBody).not.toContain("onTurnEnd(event, ctx)");
    const turnEndBody = source.slice(
      source.indexOf('pi.on("turn_end"'),
      source.indexOf('pi.on("agent_settled"'),
    );
    expect(turnEndBody).toContain("await onTurnEnd(event, ctx)");
    expect(turnEndBody).not.toContain("onBoundary(event, ctx)");
  });

  it("forwards the live registry model to pi.setModel", () => {
    const source = readFileSync("index.ts", "utf-8");
    expect(source).toContain(
      'setModel: (model) => pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0])',
    );
  });

  it("registers the agent_settled banner backstop that clears the status", () => {
    const source = readFileSync("index.ts", "utf-8");
    expect(source).toContain('pi.on("agent_settled"');
    const settledBody = source.slice(
      source.indexOf('pi.on("agent_settled"'),
      source.indexOf('pi.on("before_agent_start"'),
    );
    expect(settledBody).toContain("clearStatus(ctx, debug)");
  });

  it("registers the fresh-prompt and session-shutdown banner handlers", () => {
    const source = readFileSync("index.ts", "utf-8");
    expect(source).toContain('pi.on("before_agent_start"');
    expect(source).toContain('pi.on("session_shutdown"');
    const clears = source.match(/clearStatus\(ctx, debug\)/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * `index.ts` owns the log prefix and `aliases.ts` messages carry none, so the
 * injected logger renders each line with exactly one extension-name prefix
 * (issue #13). `index.ts` cannot be imported under vitest, so the invariant
 * is pinned at the source level.
 */
describe("log prefix regression", () => {
  it("uses the full extension name as the logger prefix in index.ts", () => {
    const source = readFileSync("index.ts", "utf-8");
    expect(source).toContain("[pi-fallback-provider]");
    expect(source).not.toContain("[pi-fallback]");
  });

  it("leaves every aliases.ts message free of a bracket prefix", () => {
    const source = readFileSync("aliases.ts", "utf-8");
    expect(source).not.toMatch(/\[pi-fallback/i);
  });

  it("never doubles the prefix across the logger and its messages", () => {
    const sources =
      readFileSync("index.ts", "utf-8") + readFileSync("aliases.ts", "utf-8");
    expect(sources).not.toMatch(/\[pi-fallback\]\s*\[pi-fallback/);
  });
});
