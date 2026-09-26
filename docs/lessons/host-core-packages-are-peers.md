---
title: DSH Host Core Packages Must Be Peer Dependencies, Never Runtime Dependencies
type: lesson
status: Current
validation_state: Verified
authority_level: Canonical
confidence: High
scope: project
isolation: soft
tags: [dsh, plugin, dependencies, pnpm, typert, packaging]
created: 2026-09-26
last_verified: 2026-09-26
module: dsh / packaging
severity: critical
---

# DSH Host Core Packages Must Be Peer Dependencies

A DSH profile installs plugins with a **hoisted** `node_modules` layout
(`~/.dsh/profiles/<name>/pnpm-workspace.yaml` → `nodeLinker: hoisted`,
`autoInstallPeers: false`). Anything a plugin lists under `dependencies` is
flattened into the profile root — including a copy of a package the host itself
loads.

DSH ships its core packages through a **shared layer** at
`~/.dsh/profiles/node_modules/@deepseek-ai/*`, symlinked into the running
installation and therefore sitting on every profile's module-resolution chain.
`<profile>/node_modules/@deepseek-ai/<pkg>` is *nearer* than that shared layer,
so a plugin-supplied copy **shadows the host's own**.

---

## Why shadowing is fatal, not merely untidy

`@deepseek-ai/dsh-typert-loader` resolves each loader entry's `package.json` with
`createRequire(ctx.baseUrl)` — `baseUrl` being the **config tree** (the profile).
It then imports that package's `./typert` host face and validates the `TYPERT`
manifest. With a shadowing copy in place it validates the *stale* manifest, which
the current loader rejects:

```
typert-loader: @deepseek-ai/dsh-llm invocation "@deepseek-ai/dsh-llm#llm/discoverModels" parameter codec has no create() factory
```

The manifest format moved on: codecs used to carry `schema:` and must now carry a
`create()` factory. Validation failure rolls up into
`typert-loader: 1 typert contributor(s) failed to register`, the entry never
activates (`dsh: warning: 1 entry did not activate`), and everything that entry
provides disappears with it. For `dsh-llm` that means no `llm` service, no
`/api/llm/listProviders` route (HTTP 404), and no session can start.

The offending plugin's own features still register, so startup *looks* healthy —
the failure only surfaces when someone opens a session.

---

## Rules

1. **Never** list `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` under
   `dependencies`. Declare them under `peerDependencies`; DSH resolves them from
   its shared layer. Importing `createUserMessage` from
   `@deepseek-ai/dsh-llm` is fine — as a peer.
2. **A prerelease range matches only its own version.** `^0.1.2-rc.1` resolves to
   `0.1.2-rc.1` forever and never to a newer `0.1.x-rc.N`, because stable
   releases in that range do not exist. "Float within the range" is not what a
   prerelease range does.
3. **The install-time version gate reads `peerDependencies` alone.**
   `evaluatePluginCompatibility` (`@deepseek-ai/dsh-app-boot`) tests the running
   runtime version against every `@deepseek-ai/dsh*` peer and refuses the install
   on a mismatch (`incompatible-version`) unless an exact-version exemption was
   granted with `dsh plugin allow-version`. `dependencies` are never inspected —
   which is precisely how a fatal dependency passed install validation.
4. **The peer floor must cover every runtime you support.** The desktop shell's
   shared layer can be one rc behind the CLI's own version, so a floor pinned to
   the CLI's version silently blocks installs on the shell.

---

## Guard

`test/unit/manifest-host-core-packages.test.mjs` enforces rules 1, 3 and 4: no
host core package under `dependencies`; every host core import in shipped code
declared as a peer; host core peer ranges equal to
`dsh.compatibility.dshVersions`.

## Diagnostic recipe

```bash
# Is a shadowing copy present after install? (must not list dsh-llm)
ls ~/.dsh/profiles/<name>/node_modules/@deepseek-ai/

# Does the manifest in play satisfy the host's own validator?
node -e "import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-typert-loader/lib/index.js')
  .then(async ({ validateTypertManifest }) => {
    const m = await import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js')
    validateTypertManifest('@deepseek-ai/dsh-llm', m.TYPERT)
  })"
```

## Evidence

- Project-Memory-Agent issue #1 — full root-cause chain, validator-level replay,
  and the installer-level regression test.
- `docs/solutions/dsh-plugin-troubleshooting.md` — sibling symptom index.
