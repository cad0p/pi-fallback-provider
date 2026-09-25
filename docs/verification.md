# Verification — CI gates, independent review, offline gates, live proof

This is the verification checklist `/impl` follows in this repository: what CI
proves on every PR, how independent review works, the offline gates every
change runs, and what must be proven live for which change type. It composes
the repo's authoritative sources — `.github/workflows/*`, `package.json`,
`tsconfig.json` — into one file. If a needed signal is missing here, that is a
docs gap: add it in the same PR that needed it.

## 1. How to use this file

1. Identify your change type in §5 and note its live-proof row.
2. Run the offline gates (§4) locally in your worktree.
3. Push and confirm CI is green (§2) on the exact head SHA.
4. Get independent review (§3) — verdicts recorded on that SHA, fresh
   instances after every push.
5. Prove live (§5) whenever the change type has a live surface — real output,
   never a substitute.
6. Close out (§6): evidence in the PR body, PR left **draft** (merge is the
   owner's call).

## 2. CI gates

Every PR to `main` runs:

| Check | Workflow | What it proves |
|---|---|---|
| `install-check` | `ci.yml` | `pnpm install --frozen-lockfile` under pnpm 11 — an unapproved build script (`ERR_PNPM_IGNORED_BUILDS`) fails CI instead of breaking `pi update` locally. |
| `test` | `ci.yml` | `pnpm install --frozen-lockfile` then `pnpm test` (vitest, `*.test.ts` at the repo root, fully offline). |
| `validate-package-version` | `validate-package-version.yml` | Feature branches must **not** bump the `package.json` `version` or edit `CHANGELOG.md`; release PRs own both. |
| `validate-release-pr` | `validate-release-pr.yml` | Release-PR shape only; the action exits successfully for ordinary PRs. |

`Auto Release` (`release.yml`) runs on pushes to `main` / `release/*`, not on
pull requests, so it is not a PR gate.

How to read checks:

```bash
gh pr checks <pr>            # one line per check: pass / fail / pending / skipping
gh pr checks <pr> --watch    # wait until all checks settle
gh run view <run-id> --log   # full log when something is red
```

Anything other than a pass is a blocker: fix on the branch and re-verify — a
review verdict applies to the commit it reviewed, so a new push needs a fresh
pass (§3).

## 3. Independent review protocol

Every change gets an independent verdict from an agent that did **not** author
it (the orchestrator spawns the reviewer; implementation subagents never
review their own work):

1. **Functional/correctness review** — does it do what the issue/plan says;
   are the tests real and meaningful; are the failure paths covered.
2. **Adversarial lens** — break it: mutate byte-exact string pins (reorder,
   single-character drift, added/removed punctuation must fail), probe
   boundary cases and off-by-one ranges, `null`/`undefined` returns, throw
   paths, `hasUI` gating, and copy drift against pinned strings/constants.
3. **Pi-API lens** — for changes touching pi APIs: structural types and
   runtime semantics must match the installed pi version's `dist` sources
   (this package carries no pi dev-dependency, so local types can lag the
   host `pi`).

Rules:

- Findings must be **reproduced** before reporting: a failing command, a
  mutated test, or a quoted line.
- Each reviewer records its own findings + verdict (e.g.
  `functional: CLEAN @ <sha>`, `adversarial: FINDINGS @ <sha>`) against the
  exact head SHA.
- Any commit pushed after a verdict needs a fresh verify pass by every lens
  whose scope it touched.
- Triage every finding: fix-now / defer (with a tracked issue) / decline
  (with rationale). Blockers and majors are never deferred.
- Trust but verify: an agent's summary is intent, not outcome — the
  orchestrator reads the actual diff before reporting work as done.

## 4. Offline gates

Run in the worktree; all must be green before push:

```bash
pnpm install --frozen-lockfile
pnpm test      # vitest run, *.test.ts (offline; no LLM calls)
pnpm check     # tsc --noEmit
```

Notes:

- Node ≥22.19.0 (`package.json` `engines`); CI uses Node 22.19 with pnpm 11
  and `--frozen-lockfile`.
- `tsconfig.json` intentionally excludes `index.ts`: its `@earendil-works/*`
  imports resolve at runtime through pi's extension loader and this package
  carries no pi dev-dependency by design. The framework-free modules
  (`aliases.ts`, `boundary.ts`) and all `*.test.ts` are typechecked.
- Scope discipline: a feature PR must not edit `CHANGELOG.md` or the
  `package.json` `version` (release policy); release PRs own them.

## 5. Live proof per change type

Live proof means running the real pi flow against the real surface and
capturing the authoritative signal — a green CI run is not live proof. Record
the evidence (commands, output, session JSONL path) in the PR.

| Change type | Live proof |
|---|---|
| Core fallback switch (`boundary.ts`, `index.ts` wiring) | Real pi session with `enabledModels` = [alias whose auth is a deliberately bogus key, a good model] and the bogus alias as the current model. Force a terminal error on the bogus alias; assert: exactly one model switch; the session JSONL contains exactly one `context_edit` entry with `replacement: null` targeting the final failed assistant entry (beyond pi's own retry omissions); **zero** appended user messages containing `continue`. |
| TUI pre-announce banner | tmux session: capture `tmux capture-pane -p -J` during the retry window (banner present, byte-exact against the constant) and after the switch (banner cleared). |
| Alias registration (`aliases.ts`) | Temp `PI_CODING_AGENT_DIR` with a fixture `auth.json`: assert the alias providers register with the expected model catalogs and the cache file is written/pruned. |
| Docs-only | CI green on the head SHA; links and commands in the change actually exist (spot-check anything command-like). No live run required — state so explicitly in the PR. |

Live-run hygiene: back up and restore any global config touched
(`~/.pi/agent/*.json`, settings); never leave test credentials, thresholds,
or fixture keys behind.

## 6. Closeout

- [ ] CI green on the exact PR head SHA (§2).
- [ ] Offline gates green locally on the head commit (§4).
- [ ] Independent verdict(s) recorded on the same SHA (§3); fix commits
      re-verified.
- [ ] Live proof for the change type captured with real output (§5) — or an
      explicit statement why it does not apply.
- [ ] Scope check: `git diff --name-only origin/main...HEAD` matches the
      plan; no `CHANGELOG.md` edit; no `package.json` version bump; no stray
      artifacts.
- [ ] PR body carries summary, verification evidence, `## Release notes`, and
      `Closes #N`.
- [ ] PR left **draft**; merge is the owner's call.
