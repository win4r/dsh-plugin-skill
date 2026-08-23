# Plugin anatomy

Everything a DSH/Cordis plugin module may declare, the Schemastery config contract, the
`cordis.yml` / `cordis.patch.yml` grammar, and the `package.json` `dsh` key.

Verified against the installed profile: `@deepseek-ai/cordis` **4.0.1**,
`@deepseek-ai/schemastery` **3.18.1**, `@deepseek-ai/dsh-tools` **0.1.1-rc.2**.
CLI handle used throughout: `DSH="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"`.
(Tilde does not expand inside double quotes — always spell it `$HOME`. Keep `node` out of the
handle: `bin.js` is the declared `bin`, and `DSH="node /path"` breaks `$DSH ...` under zsh.)

---

## 1. What a plugin is

A plugin is **any module, object, function, or class carrying an entrypoint that receives
`(ctx, config)`**. Cordis loads it into a *fiber*: one live instance with validated config,
lifecycle state, and a set of effects that unwind on unload.

```ts
type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>

interface Plugin.Function<T>    extends Plugin.Base<T> { (ctx: Context, config: T): any }
interface Plugin.Constructor<T> extends Plugin.Base<T> { new (ctx: Context, config: T): any }
interface Plugin.Object<T>      extends Plugin.Base<T> { apply(ctx: Context, config: T): any }
```

An **ES module namespace object is a valid `Plugin.Object`** because it has `apply` — that is why the
"named module exports" style below works and is the default in the shipped docs and in the reference
plugin `dsh-pi-review`.

**`apply` can run many times per process.** If an injected service disappears, dependent fibers are
disposed (effects unwound in reverse order) and re-loaded when it returns. HMR and a config edit do
the same. Write `apply` so that every registration is reversible; never rely on module-level mutable
state surviving a reload.

---

## 2. The three forms

### 2a. Function form (named module exports) — the default

Use this unless the plugin provides a service to other plugins.

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { Config } from './config.js'          // a bare re-export creates no
export { Config }                             // local binding to annotate with
export const name = 'dsh-hello'                // display/logger name
export const inject = ['tools']                // required services

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({ /* ... */ }))
}
```

Metadata may also be attached to the function itself, which matters when you export several plugins
from one module:

```ts
export function apply(ctx: Context, config: Config) { /* ... */ }
apply.inject = ['tools']
apply.Config = Config
```

### 2b. Object form (default export)

```ts
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'

export default {
  name: 'dsh-hello',
  inject: ['tools', 'systemPrompt'],
  Config,
  apply(ctx: Context, config: Config) {
    ctx.tools.register(/* ... */)
  },
}
```

### 2c. Class form — **only** when the plugin provides a service

`super(ctx, name)` registers `ctx.<name>` immediately and unregisters it automatically when the
fiber unloads.

```ts
import { Service, type Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context { metrics: MetricsService }
}

export default class MetricsService extends Service {
  static inject = ['llm']            // services THIS service needs
  static Config = Config             // validated before the constructor runs

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'metrics')            // -> ctx.metrics
  }

  // The ONLY post-construction hook. Runs for class plugins only.
  // May be async; may return a disposer / Effect shape.
  protected async [Service.init]() {
    this.ctx.logger('metrics').info('ready')
  }

  record(event: string, value: number) { /* ... */ }
}
```

`constructor(ctx: Context, name: string)` in cordis 4.0.1 takes **two** parameters. There is no
third `immediate?` argument (cordis 3.x), and there is **no `start()` / `stop()`**. See
`references/services-and-events.md` §2 for the full Service contract.

---

## 3. Every module-level export a plugin may declare

`Plugin.Base` is the complete, authoritative set of metadata the registry reads — nothing else is
consulted.

| Export | Type | Meaning |
| --- | --- | --- |
| `name` | `string?` | Display name for fiber diagnostics and derived logger names. |
| `Config` | `StandardSchemaV1<any, T>?` | Validator run **before** the plugin starts; fills defaults. Satisfied by a Schemastery schema (`'~standard'`). |
| `inject` | `Inject?` | Required services. `(keyof M)[]` or `{ [service]: interceptConfig }`. Plugin does not load until all exist; re-loads on change. |
| `provide` | `string \| string[]?` | Service name(s) this plugin provides (read by `Service` and by loaders). |
| `intercept` | `Dict<boolean>?` | Service names whose intercept config the plugin declares it consumes. |
| *entrypoint* | `apply(ctx, config)` / `(ctx, config)` / `new (ctx, config)` | Exactly one. |

There is also a separate config-transform shape (rarely needed):

```ts
interface Plugin.Transform<S, T> {
  schema?: true
  Config: (config: S) => T   // convert user-facing config to runtime config
}
```

### Exports that do NOT exist in cordis 4.0.1

Do not emit these. They are Koishi / older-cordis folklore; grepping the installed
`@deepseek-ai/cordis/lib/types/**` finds `reusable` nowhere and `disposable` only as internal
`DisposableList` / `_disposables`.

- `export const reusable = true` — **does not exist**
- `export const disposable = true` — **does not exist**
- `export const using = [...]` — **does not exist** (it is `inject`)
- `inject = { required: [...], optional: [...] }` — **cordis 3.x**. In 4.0.1 `Inject.resolve` treats
  every key as a service name, so this blocks forever on services literally named `required` and
  `optional`. Optional deps = omit from `inject` + `ctx.get('name')`.

### Cleanup

Anything registered through `ctx` (tools, event listeners, `ctx.timer.*`, `ctx.provide`,
`ctx.systemPrompt.section`, …) is cleaned up automatically on unload. You only need `ctx.effect()`
for **external** resources:

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => heartbeat(), 5000)
    return () => clearInterval(timer)      // runs on unload / HMR / config edit
  })
}
```

Full `ctx.effect()` contract and disposal ordering: `references/services-and-events.md` §3.

---

## 4. The Config contract (Schemastery)

**Rule: export a TypeScript `interface Config` AND a same-named runtime schema
`export const Config: Schema<Config>`.** Declaration merging gives consumers the type and Cordis the
validator. Exporting a plain object as `Config` does **not** work — Cordis requires a Standard Schema
v1 implementation, which Schemastery provides via `'~standard'`.

```ts
// src/config.ts
import Schema from '@deepseek-ai/schemastery'      // DEFAULT export

export interface Config {
  greeting: string
  maxRetries: number
  mode: 'fast' | 'accurate'
  apiKey?: string
  tags: string[]
  env: Record<string, string>
}

export const Config: Schema<Config> = Schema.object({
  greeting:   Schema.string().default('Hello').description('Greeting prefix.'),
  maxRetries: Schema.number().min(0).max(10).default(3),
  mode:       Schema.union(['fast', 'accurate'] as const).default('fast'),
  apiKey:     Schema.string().role('secret').description('Optional; falls back to env.'),
  tags:       Schema.array(Schema.string()).default([]),
  env:        Schema.dict(Schema.string()).default({}),
})
```

Then in `src/index.ts`: `import { Config } from './config.js'` followed by `export { Config }` --
a bare `export { Config } from './config.js'` re-exports without creating a local binding, so
annotating `config: Config` fails with TS2304 -- and take `config: Config` as the
second `apply` parameter. `apply` always receives complete, validated config.

### 4a. Factories (installed `@deepseek-ai/schemastery` 3.18.1)

| Factory | Produces | Notes |
| --- | --- | --- |
| `Schema.string()` | `string` | `.pattern(re)`, `.role('textarea'\|'secret'\|'url'\|…)` |
| `Schema.number()` | `number` | `.min(n)`, `.max(n)`, `.step(n)` |
| `Schema.natural()` | `number` | non-negative integer |
| `Schema.percent()` | `number` | `0..1`, slider role |
| `Schema.boolean()` | `boolean` | |
| `Schema.date()` | `Schema<string \| Date, Date>` | accepts a string, yields a `Date` |
| `Schema.regExp(flag?)` | `RegExp` | |
| `Schema.arrayBuffer()` / `('hex')` / `('base64')` | `ArrayBuffer` | |
| `Schema.bitset(bits)` | `number` | named flag set |
| `Schema.function()` | `Function` | not serializable — avoid in plugin config |
| `Schema.is(ctorOrName)` | instance check | |
| `Schema.array(inner)` | `T[]` | |
| `Schema.dict(inner, sKey?)` | `Record<string, T>` | |
| `Schema.tuple([a, b])` | `[A, B]` | |
| `Schema.object({...})` | object | the normal top-level shape |
| `Schema.union(list)` | union | bare literals are lifted via `Schema.from` |
| `Schema.intersect([a, b])` | merged object | |
| `Schema.const(v)` | literal | |
| `Schema.any<T>()` / `Schema.never()` | escape hatches | |
| `Schema.transform(inner, cb, preserve?)` | mapped value | |
| `Schema.lazy(() => schema)` | recursive schemas | |
| `Schema.from(source)` | lift a literal/ctor into a schema | |
| `Schema.extend(type, resolve)` / `Schema.resolve(...)` | custom types | advanced |

`Schema.ValidationError` is also exported.

### 4b. Chainables (all return the schema, all composable)

| Chainable | Effect |
| --- | --- |
| `.default(v)` | fill when the user omits the field. **This is how you declare defaults** — not in `apply`. |
| `.required()` | nullable input is invalid unless a default supplies a fallback |
| `.description(text)` | human text shown in settings UIs and `--dump-config` tooling |
| `.comment(text)` / `.link(url)` | extra doc metadata |
| `.min(n)` / `.max(n)` / `.step(n)` | numeric bounds |
| `.pattern(regexp)` | string pattern |
| `.role(text, extra?)` | attach a Web settings-form renderer role (`'textarea'`, `'secret'`, …) |
| `.loose()` | return the default instead of throwing on invalid input |
| `.hidden()` / `.disabled()` / `.collapse()` | settings-form presentation |
| `.deprecated()` / `.experimental()` | badges |
| `.set(key, schema)` / `.push(schema)` | mutate an object/array schema after construction |
| `.simplify(value?)` / `.toString(inline?)` / `.toJSON()` | serialization helpers |
| `.i18n(messages)` / `.extra(key, value)` | localization / arbitrary metadata |

### 4c. Union idioms

```ts
// String-literal union. `as const` keeps the TS type narrow when the tuple is hoisted.
mode: Schema.union(['fast', 'accurate'] as const).default('fast'),

// Tagged / disable union: an object OR `false`.
cache: Schema.union([
  Schema.object({ ttlMs: Schema.number().default(60_000) }),
  Schema.const(false),
]).default(false),
```

### 4d. Validation fails loudly at LOAD time

The schema runs while the plugin loads, before `apply`. An invalid value fails the load:

```
ValidationError: invalid config:
  - $.targets expected array but got not-an-array (at targets)
```

The fiber goes to `FAILED` and the launcher exits nonzero. `await ctx.plugin(p, cfg)` rejects with
the same error. **Async validation is explicitly rejected**
(`TypeError('Async config validation is not supported')`).

Design rule: anything two deployments might want to set differently must be a config field. The
test is *"can `cordis.patch.yml` change this without editing code?"* Express self-contained
constraints in the schema so bad config fails at load; cross-service references need `inject`,
not schema.

### 4e. Config edits hot-reload — but only from the two USER patch files

A config edit that actually reaches the loader hot-replaces the plugin: the framework unloads the old
fiber and loads a new one. Registrations are effects and clean themselves up, so the replacement does
not retain the old instance's tools/listeners.

**What reaches the loader at runtime is much narrower than "edit a yaml, see it live".** Module HMR is
off in both stock profiles: the `hmr` row ships `disabled: true` in the `dsh-web-app` and
`dsh-headless` bundles, and the dsh launcher re-creates `@deepseek-ai/cordis-plugin-hmr` itself with
`config: { root: [] }` — **no module roots are watched**. It then calls `watchUserPatches()` on
exactly **two** files:

1. `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (the profile layer)
2. `$DSH_HOME/cordis.patch.yml` (the home layer)

Consequences:

- Editing either of those two files hot-reloads the rows it touches. That is the **only** live loop.
- Editing **your own package's bundle `cordis.patch.yml` does not reload.** Bundle layers are composed
  once at boot (§5d). Restart the profile.
- **A rebuilt `dist/` is not hot-reloaded either** — with `root: []` no module is watched, so
  `npm run build` alone changes nothing in a running profile. Restart the profile.
- Bundle *membership* changes (adding/removing a plugin package) require a restart as well.

So the fast dev loop is: iterate **config** through the profile-level patch file; **restart** after
every build.

---

## 5. `cordis.yml` / `cordis.patch.yml` grammar

### 5a. The row

A `cordis.yml` is a top-level YAML array of rows. A row has **exactly eight legal keys** — nothing
else. Six are declared on `EntryOptions` in `cordis-plugin-loader`'s
`lib/types/config/entry.d.ts`; `intercept` and `isolate` are **declaration-merged onto the same
interface** by the loader's isolate module (`lib/types/config/isolate.d.ts`), which is always loaded:

```ts
interface EntryOptions {
  id: string                 // stable id inside the entry tree; the patch-override key
  name: string               // Node module specifier
  config?: any               // config passed to the plugin
  group?: boolean | null     // nested rows live in this row's `config` array; ids nest as parent/child
  disabled?: boolean | null  // prevents this entry and descendants from running
  inject?: Inject | null     // services this ROW waits for (also gates its !!js interpolation)

  // contributed by cordis-plugin-loader's isolate module (declaration merging)
  intercept?: Dict | null              // per-service intercept config for this row
  isolate?: Dict<true | string> | null // per-service isolation: `true` = row-local realm,
                                       // a string = named realm shared with rows using the same label
}
```

- `name` is a Node module specifier: an installed **package name** (`dsh-hello-plugin`), a subpath
  (`dsh-hello-plugin/startup`), or an **absolute** filesystem path for a `--patch` dev overlay.
  A relative path resolves against the *profile directory* (via `ctx.baseUrl`), not against the patch
  file — so relative source paths only work by accident. Use package names in a shipped bundle patch
  and absolute paths in a dev overlay.
- A dsh profile's own `cordis.yml` is literally `[]`. **Do not edit it.** Edit `cordis.patch.yml`.
- `isolate:` is therefore a first-class row key, not an extension — it is what §5e's group example uses.

### 5b. The patch file

A `cordis.patch.yml` is a top-level YAML array with **exactly two entry shapes**. Semantics come from
`applyEntryPatches` in `@deepseek-ai/cordis-plugin-include`, shared by boot and by `--dump-config`
so a dump can never drift from what boots.

**Shape 1 — insert.** `insert:` holds a list of full rows.

```yaml
# append to the ROOT entry list
- insert:
    - id: hello
      name: dsh-hello-plugin
      config:
        greeting: 'Hi there'

# append into an existing group's config array
- id: some-group
  insert:
    - id: nested
      name: dsh-other-plugin
```

Warns and skips if the target id is missing or the target is not a group
(`patch insert: entry %C is not a group`). Inserted rows are indexed as they are added, so a later
patch in the same list can target a row an earlier patch inserted.

**Shape 2 — override.** `id:` (REQUIRED) plus any row keys to overwrite.

```yaml
- id: hello
  config:
    greeting: 'Overridden'

- id: hmr
  disabled: true

- id: tools
  config:
    mode: !!js process.env.DSH_TOOLS_MODE
```

Override rules:
- `id` is required for a non-insert patch (`patch: id is required for non-insert patches`).
- An optional `name:` on an override is a **guard, not a rename**: a mismatch warns
  `patch: name mismatch` and skips the whole entry.
- An `id` key *inside* the overrides is silently ignored — rows cannot be renamed.
- **Each targeted key's whole value is replaced. `config` is replaced wholesale, never deep-merged.**
  An override must restate every key the row needs.
- There is **no `remove` / `delete` directive**. Removal is `disabled: true`.
- A patch that matches nothing warns and is skipped — never a hard failure. `--dump-config` reports
  unmatched targets on stderr.

### 5c. `!!js` expressions

Custom YAML tag `tag:yaml.org,2002:js`, parsed into `{ __jsExpr: string }`.

- Legal **only inside `config` values and in a row's `disabled` field.** `name`, `id`, `inject`, and
  other metadata stay static.
- A `config` expression is evaluated against that row's **plugin context**, deferred until the row's
  declared `inject` services are active. A `disabled` expression is evaluated at **every mount
  decision**, against the loader context.
- Available in scope: `ctx`, `process`, and dsh helpers seen in shipped patches (`dshHomePath('storages')`).
- `--dump-config` prints `!!js` **unevaluated**.

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080

- id: bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
```

### 5d. Layer order

Composed over an empty root, in order — later layers win **per row**:

1. each bundle patch in `dsh.profile.bundles` order (`@deepseek-ai/dsh-base` first)
2. the profile's `$DSH_HOME/profiles/<name>/cordis.patch.yml`
3. the home-level `$DSH_HOME/cordis.patch.yml` (machine-local; **outranks** the per-profile layer)
4. each `--patch <path>` overlay, in argv order

App CLI arguments are not a patch layer.

Inspect without booting:

```sh
DSH="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"
$DSH --profile web --dump-default-config   # bundle layers only
$DSH --profile web --dump-config           # + profile patch + home patch + --patch overlays
```

Both print `# == <bundle-name>` provenance comments before each row. A dump never runs app
command-line providers and rejects an invocation carrying app arguments.

### 5e. Service isolation via groups

```yaml
- id: group-a
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config: { timeoutMs: 5000 }
```

This is the declarative form of `ctx.isolate('shell')`.

---

## 6. `package.json` — the `dsh` key

Two mutually exclusive forms. **Nothing is both.**

### 6a. Bundle (what you author)

A package becomes a profile layer **solely** by declaring `dsh.bundle.patch`. After a successful
`dsh plugin` run, `reconcilePlugins()` re-reads the profile manifest and, for every name in its
`dependencies`, calls `exportsPatch(packageName, profileDir)` — which resolves the installed package
directory and tests `readProfileManifest(NAME, dir).dsh?.bundle?.patch !== undefined`. A dependency
that passes is appended to `dsh.profile.bundles`; a listed name that was a dependency and no longer
passes is spliced out. In-box bundles from the profile template are not dependencies and are never
touched.

Without the declaration the package installs as a plain dependency. dsh warns on stderr **once, only
for a dependency that was not present before the run**:

```
dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)
```

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "cordis.patch.yml", "README.md"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "prepare": "npm run build",
    "test": "node --test test/*.test.mjs"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/schemastery": "*"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@types/node": "^26.2.0",
    "typescript": "^5.9.3"
  }
}
```

Hard requirements:
- `"type": "module"` — cordis and dsh are ESM-only.
- `main` / `types` point at **built output**, not `src/`. (The official docs' bundle example shows a
  hand-written plain-JS `index.js`; for a TypeScript plugin that shape produces a package that fails
  to load after a git install.)
- `files` must include **both** the built entry point **and** `cordis.patch.yml`, or the layer is
  missing after install.
- `dsh.bundle.patch` is the only pointer — the composer never resolves the patch through code.
- Harness packages go in **both** `peerDependencies` (as `"*"`) and pinned `devDependencies`. The
  `"*"` peers are harmless only because the profile's `pnpm-workspace.yaml` sets
  `autoInstallPeers: false`.
- **Pinning is mandatory.** `npm view @deepseek-ai/dsh-tools dist-tags` → `latest=0.0.1-rc.1`,
  `next=0.1.1-rc.2`. The profile runs `0.1.1-rc.2`, so `"*"` or a bare `npm i` resolves to a
  *different API*.

Directory layout:

```
dsh-hello-plugin/
├── package.json        # declares dsh.bundle
├── cordis.patch.yml    # the layer applied when a profile lists this bundle
├── tsconfig.json
├── src/                # index.ts, config.ts, ...
├── dist/               # built output (git-ignored)
└── test/               # *.test.mjs importing from ../dist/*.js
```

The bundle's `cordis.patch.yml` must reference the plugin by **package name** so Node resolution
finds the installed code:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
      config:
        greeting: 'Hi there'
```

### 6b. Profile (generated — never hand-written)

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/abs/path/to/hello-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"] } }
}
```

`dsh plugin` creates and maintains this. After every successful run it reconciles
`dsh.profile.bundles` against **installed state** (not against a dependency diff), so an update that
gains a `dsh.bundle` declaration auto-activates and one that drops it auto-deactivates.
`cordis.yml` is never touched — it stays `[]`.

### 6c. Working `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

`moduleResolution: "Bundler"` is what lets source write extensioned `'./config.js'` specifiers
(required for ESM output) while resolving `.ts` on disk. Never `module: "CommonJS"`.

---

## 7. Naming conventions

- Out-of-tree plugin packages: `dsh-<name>`. In-repo: `@deepseek-ai/dsh-<name>`.
  Profiles: `dsh-profile-<name>`.
- Row `id`: short, kebab-case, **stable across versions** — it is the patch-override key
  (`hello`, `pi-review`, `system-prompt`, `tool-bash`).
- `export const name`: the kebab-case capability name (`'greet-tool'`, `'dsh-pi-review'`).
- Service `ctx` keys: **singular** for a single engine/runtime/policy/config (`webStartup`,
  `sandboxPolicy`); **plural** for a registry or multi-member service (`tools`, `agents`, `goals`).
  The class role and key number must agree.
- Name the stable current responsibility, not the first implementation or the Cordis base class.
  Role suffixes with defined meanings: Controller, Store, Directory, Presenter, Registry, Runtime,
  Resolver, Binder, Engine, Policy, Executor, Gateway, Provider, Backend, Handle, Config, and
  Service as a last resort.

---

## 8. Traps checklist

- [ ] `"type": "module"` present.
- [ ] `Config` exported as **both** an interface and a `Schema<Config>`; defaults live on the schema.
- [ ] `inject` is an **array** (or object → intercept config). Never `{required, optional}`.
- [ ] No `reusable` / `disposable` / `using` exports.
- [ ] `files` ships `dist` **and** `cordis.patch.yml`.
- [ ] `dsh.bundle.patch` present, `dsh.profile` absent.
- [ ] Harness devDeps pinned to `^4.0.1` / `^0.1.1-rc.2` / `^3.18.1`.
- [ ] Patch rows use the **package name**; dev `--patch` overlays use an **absolute** path.
- [ ] `dist/` rebuilt after every source edit — a directory install is a `link:` symlink, so
      `prepare` does **not** run on install and stale `dist/` is the #1 cause of "my change did nothing".
- [ ] Profile **restarted** after that rebuild, and after any bundle-patch edit — module HMR is off
      (`hmr` disabled, `root: []`); only the two user patch files are watched (§4e).
- [ ] `dsh plugin --profile <p> add -w <path>` — `-w` is mandatory for `add` (the profile dir is a
      pnpm workspace root). `remove` does not need it.
