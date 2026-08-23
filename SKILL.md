---
name: dsh-plugin
description: Build, scaffold, install, verify and debug DeepSeek Harness (DSH) plugins — cordis plugins that add a tool, service, event hook, LLM adapter or settings/UI surface to DSH. Use for "write a DSH plugin", "add a tool to DeepSeek Harness", "scaffold a dsh plugin", "add a settings card to DSH", "register a tool with ctx.tools", "cordis plugin apply(ctx, config)", "dsh plugin add", "cordis.patch.yml", "defineTool", "my DSH plugin isn't loading", or any dsh plugin development / dsh-tools / dsh-agent / dsh-llm extension work.
---

# DSH plugin development

A DSH plugin is a cordis plugin: an ES module exporting `apply(ctx, config)`, packaged with a
`dsh.bundle.patch` declaration so `dsh plugin add` promotes it into a profile's layer stack.

## When to use

- Adding a tool the model can call (`ctx.tools.register(defineTool(...))`).
- Hooking harness events (`tools/pre-execute`, `agent/pre-step`, `session/event`, ...).
- Providing a service (`class X extends Service`), an LLM adapter, or a user-facing surface
  (`ctx.settings.register` for a settings card, `ctx.webServer.register` for a route).
- Diagnosing a plugin that installs but never loads, or whose config is ignored.

Do **not** use for editing DSH itself, or for `~/.dsh/profiles/<p>/cordis.yml` (always `[]`; edit
`cordis.patch.yml` instead).

## Environment (verified)

```bash
DSH="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"   # no PATH shim; $HOME, never ~
# profiles: $HOME/.dsh/profiles/web, $HOME/.dsh/profiles/headless
# installed: cordis 4.0.1, schemastery 3.18.1, dsh-tools/dsh-llm/dsh-session 0.1.1-rc.2
```

Reference implementation, known-good and installable: `/Users/charlesqin/orca/projects/DSH-Project/dsh-pi-review`.

## Quick start

```bash
SKILL=/Users/charlesqin/orca/projects/DSH-Project/.claude/skills/dsh-plugin
# $DSH is the handle defined under "Environment" above

# 1. scaffold (writes package.json, tsconfig.json, cordis.patch.yml, src/, test/)
node $SKILL/scripts/scaffold.mjs dsh-hello --dir $HOME/code --profile web

# 2. install deps + build (dist/ MUST exist before install — a link: install runs no prepare)
cd $HOME/code/dsh-hello && npm install && npm run build

# 3. verify before touching the profile
node $SKILL/scripts/verify.mjs $HOME/code/dsh-hello --profile web

# 4. install into the profile (-w is MANDATORY for `add`)
cd $HOME/code && $DSH plugin --profile web add -w ./dsh-hello

# 5. confirm it composed into the tree
$DSH --profile web --dump-config | tail -20      # look for "# == dsh-hello"
```

After every source edit: `npm run build`, **then restart the profile**. The profile holds a
**symlink**, so a stale `dist/` is one cause of "my change did nothing" — but module HMR is off in
both stock profiles (`root: []`), so a rebuilt `dist/` is *never* hot-reloaded even when it is
fresh. Only `~/.dsh/profiles/<p>/cordis.patch.yml` and `~/.dsh/cordis.patch.yml` reload live.
See references/install-and-verify.md §5.

Uninstall: `$DSH plugin --profile web remove dsh-hello` (no `-w` needed; remove by package name).

## The plugin contract

`src/index.ts` — the whole minimal plugin:

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-hello'

// Every entry in `inject` is REQUIRED and blocking. apply() re-runs whenever one
// of these services is replaced. There is no required/optional object split in
// cordis 4.0.1 — for an optional dep, omit it here and use ctx.get('name').
export const inject = ['tools']

// Config must be BOTH a TS interface and a same-named runtime Schema (declaration
// merging). A plain object here does not work — cordis needs a Standard Schema.
export interface Config {
  greeting: string
  loud: boolean
}
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello').description('Prefix for the reply.'),
  loud: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  // Anything registered through ctx (listeners, tools, timers) is disposed
  // automatically. Only external resources need an explicit effect:
  ctx.effect(() => () => { /* kill child processes, close handles */ })
}
```

`cordis.patch.yml` — `name` must be the **installed package name**, `id` is the stable handle later
patch layers target:

```yaml
- insert:
    - id: hello
      name: dsh-hello
      config:
        greeting: Hello
```

`package.json` essentials: `"type": "module"`, `main`/`types` pointing at `dist/`,
`"files": ["dist", "cordis.patch.yml"]`, and `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
Without `dsh.bundle.patch` the package installs as a plain dependency and activates nothing.

## Adding a tool

```ts
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'hello_greet',
  description: 'Greet a person. Use when the user asks for a greeting.',

  // `parameters` is an IMPLICIT open object: write the property map directly,
  // never wrap it in { type: 'object', properties: ... }.
  parameters: {
    who: {
      type: 'string',
      required: true,          // per-property annotation; there is NO `required: [...]` array
      description: 'Name to greet.',
    },
    style: {
      type: 'string',
      enum: ['plain', 'loud'], // inline literal array infers 'plain' | 'loud' (no `as const` needed)
      description: 'Delivery style.',
    },
    opts: {
      type: 'object',
      additionalProperties: false,   // MANDATORY on every explicit object node
      properties: { times: { type: 'number' } },
    },
  },

  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },

  // exec.signal is a REQUIRED AbortSignal — thread it into every subprocess/fetch.
  async execute(args, exec: ToolRunContext) {
    exec.signal.throwIfAborted()
    const text = `Hello, ${args.who}!`
    return args.style === 'loud' ? text.toUpperCase() : text
  },
}))
```

`register()` returns the exact disposer; cordis calls it on unload. The reserved name `run_code` and
duplicate names within one layer both throw. See `references/tools.md` for the full schema DSL,
`presentCall`/`presentResult` views, `finalizeContent`, `timeoutMs`, and testing a tool directly.

## Hooking an event

```ts
ctx.on('agent/session-start', ({ source }) => {   // emit mode: observe, return nothing
  ctx.logger('dsh-hello').info('session start: %s', source)
})

ctx.on('tools/pre-execute', async (exec, next) => {      // waterfall mode: MUST return next()
  if (exec.name === 'bash') return { kind: 'deny', reason: 'blocked by dsh-hello' }
  return next()                                          // ...unless deliberately vetoing
})
```

Event names are exact and typed — `agent/step` does not exist (`agent/pre-step` does). Listeners are
fiber-owned: unload removes them, no manual disposer.

## Providing a service

```ts
import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { metrics: MetricsService }   // types ctx.metrics for consumers
}

export default class MetricsService extends Service {
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'metrics')      // registers ctx.metrics now; unregisters with the fiber
  }
  record(event: string, value: number) { /* ... */ }
}
```

Consumers write `export const inject = ['metrics']`. Ship the `declare module` block in your published
`.d.ts` or `ctx.metrics` stays untyped downstream. Depth for both: `references/services-and-events.md`.

## Verification ladder

Run in order; each rung catches a class the next cannot. `node $SKILL/scripts/verify.mjs <plugin-dir> --profile web` runs rungs 1-5 for you.

| # | Check | Command |
|---|---|---|
| 1 | Typecheck | `npx tsc -p tsconfig.json --noEmit` |
| 2 | Build | `npm run build` |
| 3 | Unit tests (import from `../dist/*.js`, so they prove the build loads) | `node --test test/*.test.mjs` |
| 4 | **Load-check** — stub Context, real `defineTool()` + real `apply()`, zero boot cost | `node $SKILL/scripts/verify.mjs <plugin-dir>` |
| 5 | Composition — is it in the tree with the right id/name/config? | `$DSH --profile web --dump-config \| tail -20` |
| 6 | Boot | `cd /tmp && $DSH --profile web --help` then `timeout 20 $DSH --profile web --port 0 --no-open` |
| 7 | **Functional** — the model can see and call it | `$DSH plugin --profile headless add -w ./dsh-my-plugin` then `cd <test dir> && $DSH --profile headless "use the <tool_name> tool to <trivial task>"` |

Rung 4 is the cheapest positive proof: `defineTool()` throws on a malformed schema node, and
`mod.Config({})` shows the exact defaults the harness hands to `apply()`. Rung 6 is only *negative*
evidence that `apply()` ran — the default log level hides plugin `info` lines. Rung 7 is the only
end-to-end proof: pass if the tool's rendered output appears in the printed reply. It spends real
provider tokens (trivial task, once, at the end), and it requires the plugin to inject nothing
web-only — injecting a service `headless` never provides means `apply()` never runs there, which
just looks like "the model ignored my tool". Web-only fallback: `references/install-and-verify.md` §4.4.

## Non-negotiable rules

1. **Pin devDeps to the profile's versions.** `npm view @deepseek-ai/dsh-tools dist-tags` → `latest: 0.0.1-rc.1`, but the profile runs `0.1.1-rc.2` (`next` tag). `"*"` or a bare `npm i` gives you a *different API*. Pin `^0.1.1-rc.2` / cordis `^4.0.1` / schemastery `^3.18.1`. Harness packages go in `peerDependencies` as `"*"` **and** `devDependencies` pinned.
2. **`dsh plugin add` needs `-w`.** The profile dir is a pnpm workspace root; without `-w` pnpm fails `ERR_PNPM_ADDING_TO_ROOT` and dsh exits 1. `remove` does not need it.
3. **Rebuild before every install and after every source edit.** A directory spec installs as `link:` (symlink), so `prepare`/`build` never runs.
4. **`additionalProperties: boolean` is mandatory** on every explicit `{type:'object'}` schema node — but never write it at the `parameters` root, which is an implicit open object.
5. **Requiredness is a per-property `required: true` annotation.** No JSON-Schema `required: [...]` array. It is legal only on a key of `parameters` or of an object node's `properties` — not on `items`, `oneOf` branches, or a schema root.
6. **Use `type` aliases, not `interface`, for anything returned through a `{type:'json'}` output node or assigned to `meta`.** An `interface` has no implicit index signature and is not assignable to `JsonValue`. Also: no optional members — an `undefined` property fails a JSON node; use `null`.
7. **`ctx.effect(() => () => cleanup())` for external resources only** (child processes, sockets, watchers). Everything registered via `ctx` is disposed automatically. Disposers run in reverse order.
8. **No `dsh` on PATH.** Invoke `$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js` directly, via the
   `$DSH` handle. Never `DSH="~/..."` — a tilde inside double quotes is not expanded. Keep `node` OUT of
   the handle: `DSH="node /path"` then `$DSH --version` breaks under zsh, which does not word-split an
   unquoted parameter. `lib/bin.js` is the package's declared `bin`, so it is executable on its own.
9. **`export const reusable` / `disposable` / `using` do not exist** in cordis 4.0.1. Neither does `Service.start()`/`stop()`, nor a third `immediate` arg to `super(ctx, name)`. The complete module export set is `name`, `Config`, `inject`, `provide`, `intercept`, `apply`.
10. **`"type": "module"` and `files: ["dist", "cordis.patch.yml"]`.** Omitting the patch from `files` makes a published install a silent non-bundle.

## Deeper reference

| File | Read it when |
|---|---|
| `references/plugin-anatomy.md` | Choosing function/object/class form, `Config` schemas and Schemastery factories, `inject` semantics, `ctx.effect` contract, fiber lifecycle, declaration merging for `Context`/`Events`. |
| `references/tools.md` | Writing any tool: full `ValueSchemaSpec` DSL, `DefineToolOptions` signatures, type inference rules, `ToolRunContext`, result/view types, error classes, unit-testing a `ToolDefinition`. |
| `references/services-and-events.md` | Hooking harness events (dispatch modes, waterfall/`next()` semantics, the full verified event catalog); providing/consuming a service (`ctx.tools`, `ctx.llm`, `ctx.agents`, `ctx.fs`, `ctx.systemPrompt`, ... and which are web-profile-only); **writing an LLM adapter**; and **user-facing surfaces** — settings cards and `ctx.webServer` routes. |
| `references/install-and-verify.md` | Packaging details, `package.json`/`tsconfig` fields, the patch grammar and layer order, `--dump-config`/`--dump-default-config`, git installs and the `onlyBuiltDependencies` build-script gate (dsh's error names a stale key), uninstall and disable-without-uninstall. |
| `references/pitfalls.md` | A plugin installs but never loads, config is ignored, a patch does nothing, types don't compile, or subprocesses are orphaned. Check here first when something is silently wrong. |
