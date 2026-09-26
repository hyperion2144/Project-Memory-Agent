# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Injected messages carry a producer-owned source kind** (follow-up to [#1](https://github.com/hyperion2144/Project-Memory-Agent/issues/1)):
  - Every injection used the retired catch-all `source: { kind: 'plugin', plugin: <name> }`, which session format v4
    refuses: `format v4 message requires a producer-owned source kind`. The refusal hits as soon as a conversation runs,
    so with the shadowing bug fixed the plugin still could not be used at all.
  - Sources are now `{ kind: 'plugin:<name>', form: <declared ContextForm> }` — the exact shape DSH's own v3-to-v4
    migration rewrites a legacy plugin source into (`producerKind()` maps an unknown plugin to `plugin:<plugin>` and
    drops the `plugin` field). The undeclared `form: 'context'` became `'instructions'`.
  - All six injection sites — the four lifecycle hooks in the plugin entry and both slash commands — now build messages
    with the host's `createUserMessage()` instead of hand-rolled `{ id, role, content, source }` objects.
  - `test/integration/dsh-plugin-hooks.test.mjs` asserts the contract on every injected message (no `'plugin'` kind,
    `plugin:<name>` shape, declared `form`); its static-context lookup no longer keys on the invented form.
- **Host-API sweep against DSH 0.1.7-rc.2** (same install session as [#1](https://github.com/hyperion2144/Project-Memory-Agent/issues/1)):
  - `invocation.text` does not exist on the current `CommandInvocation` (the field is `rawInput`), so `/ema` silently fell
    back to its `default` subcommand and `/project-memory --trace` never enabled tracing. Both commands now read
    `invocation.rawInput`.
  - `agent/post-step` does not exist on this host, so the post-task compounding hook was dead code. It is re-anchored on
    the agent-scoped `agent/turn-stopping` event, and the task text is read from `session.deriveMessages()` instead of
    the retired payload message field. Producer-injected context (`plugin:*` sources) is skipped, so the plugin's own
    injections are never mistaken for the user's task. The feature is now **opt-in** via `COMPOUNDING_ENABLED`, matching
    its documented contract — the code previously defaulted to on while the hook never fired.
  - `resolveWorkspace()` probed `payload.session` and `payload.agent.cwd`, neither of which exists on an `agent/pre-step`
    payload, so hook-driven injections fell back to `process.cwd()`. It now reads `payload.agent.session.header.cwd`
    first — the authoritative session workspace.
  - Re-checked and found **compatible** (no change needed): `CommandResult`, the `agent/pre-step` waterfall plus its
    `next()` contract, `ctx.skills.register` / `registerProvider`, `defineTool` and `ctx.tools.register`,
    `WebRoute { kind: 'prefix' }`, `agent.inject` / `followup`, and `agent.session.header.cwd`.
  - `test/integration/dsh-plugin-hooks.test.mjs` grew coverage for all three fixes (rawInput parsing, opt-in
    turn-stopping compounding, workspace resolution proven by a marker that only the session cwd carries).
- **Plugin no longer shadows the host's own `@deepseek-ai/dsh-llm`** ([#1](https://github.com/hyperion2144/Project-Memory-Agent/issues/1)):
  - `@deepseek-ai/dsh-llm` moved from `dependencies` to `peerDependencies`. DSH installs profile plugins with a hoisted
    `node_modules`, so a host core package declared as a runtime dependency landed in the profile root — nearer than DSH's
    shared core layer — and shadowed the host's copy. `@deepseek-ai/dsh-typert-loader` then validated the stale copy's
    `./typert` manifest, failed strict codec validation (`parameter codec has no create() factory`), and the whole
    `dsh-llm` entry failed to activate: `dsh: warning: 1 entry did not activate`, `GET /api/llm/listProviders` → 404,
    and sessions could not load.
  - `createUserMessage` is still imported from the host; DSH resolves it through its shared core layer, the same
    mechanism already used for `@deepseek-ai/dsh-tools`.
  - Added `test/unit/manifest-host-core-packages.test.mjs`: host core packages may never appear under `dependencies`,
    every host core import in shipped code must be a declared peer, and host core peer ranges must match
    `dsh.compatibility.dshVersions`.

### Changed

- **DSH compatibility baseline raised to the `0.1.7` line**: `dsh.compatibility.dshReleases` now approves `0.1.7-rc.1`
  and `0.1.7-rc.2`, and `dshVersions` plus every `@deepseek-ai/dsh-*` peer range is `>=0.1.7-rc.1 <0.2.0-0`. The floor
  stays at `rc.1` deliberately: DSH's install-time gate (`evaluatePluginCompatibility`) tests each peer range against
  the running runtime and refuses incompatible installs, and the desktop shell's shared core layer is `0.1.7-rc.1`.
- Recorded the underlying rule in `docs/lessons/host-core-packages-are-peers.md` and refreshed the package-layout
  description in `docs/architecture.md`.

## [0.5.4] — 2026-09-22

### Added

- **Auto-Start Standalone EMA UI Server on Port 3888**:
  - Automatically launches the standalone UI server on port 3888 on plugin load (alongside `/ema` mount on DSH web server).
  - Both `http://127.0.0.1:3080/ema` and `http://127.0.0.1:3888` are directly accessible without requiring manual `ema ui` command.
  - Gracefully handles `EADDRINUSE` if port 3888 is already bound, and properly closes on plugin unload.

## [0.5.3] — 2026-09-22

### Added

- **Native DSH Web Integration & Prefix Mounting**:
  - Mounted EMA Visual Memory Graph UI directly on DSH's internal web server under `/ema` prefix (`http://127.0.0.1:3080/ema`) via Cordis `ctx.inject(['webServer'], ...)`.
  - Added `basePath` support across `handleUIRequest` and the Web UI template (`window.__EMA_BASE_PATH__` / `API_BASE`) for transparent prefix mounting.
  - Prominent startup banner displaying all live UI endpoints on load:
    - 📊 EMA Visual Memory Graph (mounted): `http://127.0.0.1:3080/ema`
    - 🌐 Standalone EMA UI (optional): `http://127.0.0.1:3888` (`ema ui`)
    - 🔍 Codebase Memory UI: `http://localhost:9749/`
- **Eager Daemon & UI Start for Codebase Memory**:
  - Restored eager background startup of `codebase-memory-mcp` so `http://localhost:9749/` is live on plugin load without waiting for first tool call.
  - Guarded against daemon startup during unit/integration tests to ensure clean test exit.

## [0.5.2] — 2026-09-22

### Changed

- **Root-Level Package Architecture (Parity with Official DSH Plugins)**:
  - Flattened repository layout: eliminated intermediate `dsh-plugin/` directory and established `@lovedolove/dsh-project-memory` as the root-level npm package directly matching the layout of official DSH plugins (such as `dsh-univer-office`).
  - Unified `skills/` directory at the repository root, removing redundancy and making the root directory the single source of truth.
  - Simplified CLI and testing commands: `npm test` runs the complete 185-test suite from repo root.
  - Updated GitHub Actions workflow (`.github/workflows/publish-npm.yml`) to build, test, and publish directly from repository root.
  - Updated `install.sh`, `install.ps1`, `AGENTS.md`, and documentation to reference root-level paths (`bin/ema-cli.mjs`).

## [0.5.1] — 2026-09-22

### Added

- **First-Class Native System Bundled Skills for DeepSeek Harness (Parity with `dsh-univer-office`)**:
  - Direct packaging of all 8 Project Memory skills (`knowledge-classification`, `knowledge-compounding`, `knowledge-discovery`, `memory-architecture`, `memory-edit`, `memory-verification`, `obsolete-knowledge`, `repository-audit`) and their reference guides directly inside `@lovedolove/dsh-project-memory`.
  - Implemented `createBundledSkillProvider()` conforming to `@deepseek-ai/dsh-skill` `SkillRegistry` with rank `BUNDLED_SKILL_RANK` (600) and `source: 'bundled'`.
  - Seamless single-command installation via DeepSeek Harness native package manager (`dsh plugin add @lovedolove/dsh-project-memory`), automatically activating all 8 skills across all sessions with zero filesystem copying or symlinking required.

## [0.5.0] — 2026-09-22

### Added

- **Built-in 384-d Vector Model & Hybrid RRF Search**:
  - Deterministic local feature-hash and subword n-gram embedder with zero dependencies and offline execution.
  - Active `sqlite-vec` KNN vector storage in derived `.ema/index.db`.
  - Stage 2 retrieval upgraded to Reciprocal Rank Fusion (RRF) combining FTS5 lexical matching with vector cosine distance.
- **Interactive Visual Memory Graph Web UI (`ema ui`)**:
  - Full-screen dark-theme force-directed physics knowledge graph on `http://127.0.0.1:3888`.
  - Dynamic 4-D lifecycle node coloring (Canonical, Candidate, Contradiction, Historical).
  - Explicit contradiction edge highlighting with animated glowing rings.
  - Interactive slide-over inspection drawer with grounded code evidence anchors, Markdown preview, and one-click promotion.
- **Autonomous Distillation & Ingestion Engine (`ema ingest`, MCP `ema_distill`)**:
  - Automated knowledge capture from Git diffs, patches, and task text.
  - Generates immutable evidence anchors (`ema://evidence/...#sym:...`, `#line:...`).
  - Quarantined candidate isolation invariant enforced in `.ema/candidates/`.
- **One-Line Universal Installer & DeepSeek Harness Integration**:
  - One-line installer script for Linux/macOS (`install.sh` via `curl | bash`) and Windows (`install.ps1` via `irm | iex`).
  - Auto-detection and auto-mounting to active DeepSeek Harness profile.
  - Slash commands `/ema ui` and `/ema ingest` supported in DeepSeek Harness chat.
  - Global `ema` launcher in `~/.local/bin/ema` and `%USERPROFILE%\.local\bin\ema.cmd`.

## [0.4.31] — 2026-09-14

### Added

- **WSL/Linux support for dsh-plugin**: codebase-memory-bridge.mjs now detects
  the platform and uses the POSIX codebase-memory-mcp binary on Linux/WSL
  instead of the Windows .exe. Project slugs are derived without a drive-letter
  prefix on Linux paths (e.g. /home/u/proj → home-u-proj).

- **dsh-plugin/test/**: added codebase-memory-bridge.test.mjs with node:test
  covering Windows slug behavior (pinned), Linux/WSL slug behavior, and a
  createClient round-trip with a fake POSIX MCP executable.

## [0.4.30] — 2026-09-XX

### Added
- **dsh-plugin/README.md**: plugin-specific documentation with feature overview,
  slash command usage, integration points, environment variables, and compatibility matrix.
- **Root README optimization**: restructured DSH Plugin section with Install/Usage
  subsections, added `--trace` flag documentation, removed redundancy with How to Use.
- **README.zh-CN.md sync**: updated Chinese README to match English version changes.

## [0.4.27] — 2026-09-08

### Fixed
- **DSH boot crash**: removed broken `pma-skill-dir` insert row from
  `cordis.patch.yml`. It used `name: cordis:plugin` which is NOT a registered
  Cordis builtin (only `cordis:include` and `cordis:group` exist), causing
  `builtins['plugin']` to resolve to `undefined` and the loader to throw
  "invalid plugin, expect function or object with an "apply" method, received undefined".
- Skill directory registration is now handled entirely by `dsh/plugin.mjs`
  at runtime via `registerWorkspaceSkills()` (workspace `skills/` + global dirs).
- Added `@deepseek-ai/dsh-tools` to peerDependencies so the module resolves
  correctly when installed in a DSH profile.

## [0.4.26] — 2026-09-08

### Fixed
- **DSH Store contract**: replaced colliding `skill-filesystem` entry ID with
  unique `pma-skill-dir` insert row in `cordis.patch.yml`; removed
  `@deepseek-ai/dsh-skill-filesystem` from dependencies.
- Added `dsh.compatibility` block with per-release DSH version declarations
  (`0.1.2-rc.1`, `0.1.3-alpha.1`, `0.1.3-alpha.2` all `compatible`),
  Node.js range (`>=18.0.0 <23.0.0`), and DSH version range.
- Added `lifecycle-evidence.md` for DSH Store validation.
- Updated `docs/architecture.md` to reflect new patch structure.

## [0.4.25] — 2026-09-07

### Added
- **DSH subagent dispatch**: `install.ps1` seeds `agents/project-memory.md` into `~/.dsh/agents/` for both `-Target dsh` and `-Target all`. After the user runs `dsh plugin add @lovedolove/dsh-project-memory`, they can dispatch via `use_agent(agent: "project-memory")`.
- **New `global` target**: installs skills to `~/.agents/skills/` and agent to `~/.agents/agents/project-memory.md` (cross-tool compatible with Claude Code, Codex, etc.).

### Fixed
- **DSH target**: no longer touches `~/.dsh/profiles/` files (package.json, cordis.patch.yml, pnpm-workspace.yaml). Respects the CLI-only workflow: `dsh plugin add` is the user's command.

### Changed
- `install.ps1`: DSH target now only prints the `dsh plugin add` command and seeds the agent file. ~180 lines → ~130 lines. Removed `Add-Plugin-ToProfile`, `Resolve-DshProfile`.
- `README.md`: updated DSH section to reflect CLI-only approach.
- `docs/architecture.md`: noted agent seeding + CLI-only DSH install.
- `CHANGELOG.md`: new file.

### Removed
- `@aiwayds/dsh-subagent-registry` references entirely from install.ps1 and documentation.
