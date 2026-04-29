# Migration: flat manifest format → OpenClaw SDK format

**Plugin**: `tsa-artifact-tracker` (P1-D, "remember what you built")
**Workspace**: `research/picks-v31/plugins/tsa-artifact-tracker`
**Date**: 2026-04-29
**Reference plugin (canonical)**: `/opt/openclaw-tsa-git/extensions/tsa-cascade-monitor/`
**Production runtime baseline**: OpenClaw 2026.4.25+ (`pluginApi >= 2026.4.25`)

This document records the structural changes applied to migrate the plugin from
the legacy flat-manifest format to the canonical SDK format used by all
production TSA extensions in `tsa-llm:/opt/openclaw-tsa-git/extensions/`.

The legacy format is preserved verbatim under `_legacy-flat-format/` for diff
reference if rollback is needed.

---

## What changed

### 1. `package.json`

Renamed package and added the canonical `openclaw` block.

| Field                                  | Before                 | After                                          |
| -------------------------------------- | ---------------------- | ---------------------------------------------- |
| `name`                                 | `tsa-artifact-tracker` | `@openclaw/tsa-artifact-tracker`               |
| `type`                                 | _(absent → CJS)_       | _(intentionally absent in research workspace)_ |
| `openclaw.extensions`                  | —                      | `["./index.ts"]`                               |
| `openclaw.compat.pluginApi`            | —                      | `>=2026.4.25`                                  |
| `openclaw.build.openclawVersion`       | —                      | `2026.4.25`                                    |
| `devDependencies.@openclaw/plugin-sdk` | —                      | `workspace:*`                                  |

**Note on `"type": "module"`.** Production extensions in
`/opt/openclaw-tsa-git/extensions/tsa-*/` declare `"type": "module"` and use
ESM with explicit `.js` import suffixes. This research workspace deliberately
keeps CJS so `ts-node` runs the smoke test cleanly without the SDK monorepo.
When relocating to the production tree, flip `"type": "module"` and re-add
`.js` suffixes to relative imports inside `src/plugin.ts` and `index.ts`.
The marker `_note_type` in `package.json` carries this reminder.

### 2. `manifest.json` → `openclaw.plugin.json`

The plugin metadata file is renamed and slimmed: in the SDK shape, runtime
metadata (id, configSchema) lives in `openclaw.plugin.json`, while wiring
(hooks, tools, commands) is registered programmatically by `register(api)`.

The old `manifest.json` exported declarative `hooks`, `tools`, `config`,
`metrics` blocks pointing at handler symbols (`src/index.ts#onAfterToolCall`
etc). The SDK loader does not honour those declarative blocks — it calls
`register(api)` and expects the plugin to imperatively wire hooks via
`api.on(...)` and tools via `api.registerTool(...)`.

The new `openclaw.plugin.json` keeps only:

- `id`: `tsa-artifact-tracker`
- `configSchema`: JSON Schema for the validated `pluginConfig` block

### 3. New top-level `index.ts`

The canonical entrypoint. Mirrors `tsa-cascade-monitor/index.ts` and
`tsa-creator-escalation/index.ts`:

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerArtifactTracker } from "./src/plugin";

export default definePluginEntry({
  id: "tsa-artifact-tracker",
  name: "TSA Artifact Tracker",
  description: "...",
  register(api) {
    registerArtifactTracker(api);
  },
});
```

### 4. New `src/plugin.ts` — wiring module

Holds the `registerArtifactTracker(api)` function. Mirrors the structure used
by `tsa-creator-escalation/src/plugin.ts` and `tsa-log-bash-exec/src/plugin.ts`:

- Reads `api.pluginConfig` (validated against `openclaw.plugin.json`'s configSchema).
- Constructs the `ArtifactTracker` singleton eagerly so DB schema applies at register-time.
- Registers all 4 tools via `api.registerTool({...})` with JSON Schema parameters
  and an `execute(toolCallId, params, signal?, onUpdate?)` method matching
  `AnyAgentTool`.
- Registers the `after_tool_call` hook via `api.on("after_tool_call", ...)`.
  The hook is fail-open: any thrown error is logged and swallowed so it can
  never break the tool path.

### 5. `src/index.ts` (library) — unchanged

The `ArtifactTracker` class, parsers (`parseArtifactsFromResult`,
`inferKind`, `inferPublicUrl`), heuristics tables, and metrics surface are
**untouched**. The migration is purely structural; the persistence + FTS5
search + idempotency + status update logic is bit-for-bit identical to the
flat-format version.

The legacy entrypoints `onAfterToolCall`, `toolSearch`, `toolRecent`,
`toolGetByPath`, `toolUpdateStatus` are kept exported for back-compat, but
they're no longer wired via `manifest.json`; the SDK registration in
`src/plugin.ts` is now the single source of truth.

### 6. `tsconfig.json`

Re-rooted to include both top-level `index.ts` and `src/`, plus `types/`
for the SDK shim. Added a `paths` entry mapping the bare specifier
`openclaw/plugin-sdk/plugin-entry` to a local `.d.ts` shim so the standalone
build can type-check without the SDK monorepo.

### 7. `types/openclaw-plugin-sdk.d.ts` — research-only shim

Minimal-but-faithful type stub for the SDK surface area we consume:
`definePluginEntry`, `OpenClawPluginApi`, `AnyAgentTool`, `OpenClawPluginToolFactory`.

This file **does not exist in production**. When this plugin is relocated to
`/opt/openclaw-tsa-git/extensions/tsa-artifact-tracker/`, delete `types/`
and remove the `paths` mapping from `tsconfig.json` — the real workspace
package `@openclaw/plugin-sdk` will resolve via the monorepo build.

---

## Validation done in this workspace

- `npm install` clean (no peer-dep warnings, `better-sqlite3` native build OK).
- `npx tsc` clean (no errors, `dist/index.js`, `dist/src/plugin.js`,
  `dist/src/index.js` all emitted with declarations + sourcemaps).
- `npx ts-node src/smoke.test.ts` — all 22 asserts pass (`ALL SMOKE OK`):
  - 6 heuristics asserts (kind inference, public URL mapping)
  - 3 parser asserts (args path, "wrote /path" regex, Bash redirect)
  - 9 track/search/recent/update flow asserts (FTS5 search, hash, status update)
  - 1 idempotency assert (re-track upserts, no duplicate)
  - 3 metrics shape asserts

Smoke test imports only the library (`./index`), not `./plugin` — the hook

- tool wiring is exercised in production by the OpenClaw runtime, not in
  the unit smoke. Production wiring is structurally identical to
  `tsa-creator-escalation` and `tsa-log-bash-exec`, both already shipping in
  master.tsa fleet.

---

## Production deployment checklist (when ready)

1. Copy `tsa-artifact-tracker/` (excluding `_legacy-flat-format/`,
   `node_modules/`, `dist/`, `types/`, `package-lock.json`) to
   `tsa-llm:/opt/openclaw-tsa-git/extensions/tsa-artifact-tracker/`.
2. Add `"type": "module"` to `package.json` and re-add `.js` suffixes to
   relative imports in `index.ts` and `src/plugin.ts`.
3. Remove the `paths` mapping from `tsconfig.json` and switch it to
   `extends: "../tsconfig.package-boundary.base.json"` like sibling
   extensions.
4. Add the plugin to `openclaw.json` under `plugins.entries` with
   `enabled: false` (initial gate; flip on after a per-bot rollout decision).
5. Deploy through the standard OpenClaw build pipeline; the `pluginApi`
   compat block keeps it from loading on older runtimes.
6. NÃO TOCAR produção sem autorização explícita Cadu (`feedback_nunca_resetar_clones.md`).
