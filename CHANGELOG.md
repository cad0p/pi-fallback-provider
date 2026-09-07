# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-09-07

<!-- USER-EDITABLE SECTION START -->
- Multi account support! Just add another account in `auth.json` for the same provider, for example for `openrouter`, you can add `openrouter-2` or `openrouter-2-personal`. The models will appear automatically at the next pi instance. Add them to scoped models like normal to achieve automatic fallback. Only api keys supported, not OAuth for now.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Multi-account support via auth.json sibling slots (closes #10)

### ⚙️ Miscellaneous Tasks

- Add pnpm install-check (pi-napkin pattern) ([#7](https://github.com/cad0p/pi-fallback-provider/pull/7))
- Pin node to pi's minimum (22.19) — pi-coding-agent engines >=22.19.0 ([#8](https://github.com/cad0p/pi-fallback-provider/pull/8))
- Wire npm publish pipeline ([#9](https://github.com/cad0p/pi-fallback-provider/pull/9))


