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

  it("registers the agent_settled banner backstop", () => {
    expect(readFileSync("index.ts", "utf-8")).toContain('pi.on("agent_settled"');
  });
});
