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
});
