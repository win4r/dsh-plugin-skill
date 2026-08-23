# Pitfalls

Each entry: **symptom → cause → fix.** Ordered roughly by how often they bite.

## Symptom index

Find the row that matches what you *observe*, then read that section.

| What you see | Go to |
|---|---|
| **Installed fine, `--dump-config` shows my block, but the tool never appears / the plugin seems dead** — no error, no log line | **[#15](#15-ctxapproval-vs-approvals-ctxfs-vs-filesystem-ctxwebserver-vs-http)** (injected a service nothing provides, or a cordis core member like `logger`), then **[#12](#12-inject-object-form-is-not--required-optional-)** (`{required,optional}` inject shape), then **[#7](#7-assuming-processcwd-is-the-sessions-workspace)** (injected a web-only service in headless) |
| `apply()` never runs, but only sometimes / it loads and unloads repeatedly | [#6](#6-forgetting-ctxeffect-cleanup--orphaned-child-processes-on-hmr) — a required service is coming and going |
| `ERR_PNPM_ADDING_TO_ROOT` on install | [#2](#2-err_pnpm_adding_to_root--add-needs--w) — `add` needs `-w` |
| `dsh: command not found` | [#8](#8-no-dsh-path-shim) — no PATH shim; invoke by path |
| pnpm refuses to run `prepare` on a git-hosted install | [#9](#9-a-directory-install-is-a-symlink--moving-the-plugin-breaks-the-profile) — `onlyBuiltDependencies`, **not** the `allowBuilds` dsh's error text names |
| Source edits have no effect / "cannot find module .../dist/index.js" | [#9](#9-a-directory-install-is-a-symlink--moving-the-plugin-breaks-the-profile) — directory installs are symlinks; rebuild `dist/` |
| My patch set one key and everything else reverted to defaults | [#16](#16-patch-overrides-replace-they-do-not-merge) — patches replace, never merge |
| My patch appears to do nothing at all | [#16](#16-patch-overrides-replace-they-do-not-merge) — unmatched patches warn and skip; `name:` is a guard, not a rename |
| `additionalProperties is missing` / `must be explicitly true or false` | [#3](#3-missing-additionalproperties-on-an-object-schema-node) |
| `required` rejected as an unknown key, or every arg is silently optional | [#4](#4-json-schema-required--array-instead-of-per-property-required-true) — no JSON-Schema `required: [...]` array |
| `not assignable to type 'never'` / `execute` returns `Promise<never>` | [#5](#5-interface-breaks-assignability-to-a--type-json--output-node) — use `type`, not `interface` |
| `args.mode` widened to `string`, `switch` lost exhaustiveness | [#10](#10-enum-arrays-need-as-const--but-only-when-hoisted) — hoisted enums need `as const` |
| `TypeError` at load, or config arrives with no defaults | [#13](#13-config-exported-as-a-plain-object) — `Config` must be a Standard Schema |
| `ValidationError: invalid config:` and the launcher exits non-zero | [#13](#13-config-exported-as-a-plain-object) |
| Builds clean, then `defineTool` throws at boot on a schema TS accepted | [#1](#1-version-drift-between-plugin-devdeps-and-the-profile) — devDeps drifted from the profile |
| Listener return ignored / `await ctx.emit` resolves instantly / veto does nothing | [#14](#14-wrong-dispatch-method-for-an-event) |
| `ctx.on('agent/step', …)` never fires | [#14](#14-wrong-dispatch-method-for-an-event) — `agent/step` does not exist; use `session/event` |
| Tool reports success on empty/garbage output; a provider 401 reads as "no findings" | [#11](#11-external-clis-that-exit-0-on-failure) — exit 0 is not a success signal |
| The tool reads the wrong directory | [#7](#7-assuming-processcwd-is-the-sessions-workspace) — `process.cwd()` is not the workspace |
| Stray child processes pile up across reloads | [#6](#6-forgetting-ctxeffect-cleanup--orphaned-child-processes-on-hmr) — wrap externals in `ctx.effect` |

The sections below stay organised by **cause**.

---

## 1. Version drift between plugin devDeps and the profile

**Symptom.** The plugin typechecks and builds cleanly, then at boot `defineTool` throws on a schema
that TypeScript accepted, or a type that exists locally is missing at runtime, or `ctx.tools` has a
method your editor knows about and the harness does not.

**Cause.** `npm view @deepseek-ai/dsh-tools dist-tags` → `latest: 0.0.1-rc.1`, `next: 0.1.1-rc.2`.
The registry's `latest` tag points at the **older** line. So `npm i @deepseek-ai/dsh-tools`, or a
`"*"` devDependency, resolves `0.0.1-rc.1` — a genuinely different API — while the profile runs
`0.1.1-rc.2`. This is a dist-tag problem, not just semver prerelease matching.

**Fix.** Read the profile's versions and pin them:

```bash
for p in cordis dsh-tools schemastery dsh-llm dsh-session; do
  echo -n "$p: "
  node -p "require('/Users/charlesqin/.dsh/profiles/node_modules/@deepseek-ai/$p/package.json').version"
done
```

```jsonc
"devDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh-tools": "^0.1.1-rc.2",
  "@deepseek-ai/schemastery": "^3.18.1"
},
"peerDependencies": {          // "*" is fine here — the profile sets autoInstallPeers: false
  "@deepseek-ai/cordis": "*",
  "@deepseek-ai/dsh-tools": "*",
  "@deepseek-ai/schemastery": "*"
}
```

`scripts/scaffold.mjs` writes these pins from disk; `scripts/verify.mjs` re-checks them (WARN).

Related: the plugin's own `node_modules/@deepseek-ai/*` are visible to Node's resolver first. If
they drift from the profile you get two copies of a harness package in one process. `import type`
is erased and immune; runtime imports like `defineTool` are not.

---

## 2. `ERR_PNPM_ADDING_TO_ROOT` — `add` needs `-w`

**Symptom.**

```
ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root...
dsh: pnpm failed in profile directory /Users/charlesqin/.dsh/profiles/web
# exit 1
```

**Cause.** `dsh plugin` forwards to pnpm with the profile directory as cwd, and
`~/.dsh/profiles/<p>/pnpm-workspace.yaml` contains `packages: [.]` — the profile dir **is** a pnpm
workspace root, so pnpm demands the explicit `-w` acknowledgement. This is undocumented; it is an
environment fact, not something the DSH docs mention.

**Fix.**

```bash
$DSH plugin --profile web add -w ./dsh-my-plugin
```

`-w` is required for **`add` only**. `remove` works without it. dsh does propagate the failure
correctly (exit 1) — if you saw exit 0, you measured `$?` after a pipe.

---

## 3. Missing `additionalProperties` on an object schema node

**Symptom.** Compile error:

```
Property 'additionalProperties' is missing in type '{ type: "object"; properties: {...}; }'
  but required in type 'ObjectValueSchemaSpec'.
```

or, if you got past TS, a runtime author error at `defineTool()`:
`<path>.additionalProperties must be explicitly true or false`.

**Cause.** `additionalProperties: boolean` is a **required** field of every explicit
`{ type: 'object' }` node. There is no default.

**Fix.** Write it on every object node, at every depth:

```ts
output: {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: false, properties: { /* … */ } },
      },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
```

**Do not** apply this to the tool's `parameters`. `parameters` is an *implicit open object root*:
you write the property map directly, never `{ type: 'object', properties: { … } }`. The compiler
deliberately emits no root `additionalProperties`.

---

## 4. JSON-Schema `required: [...]` array instead of per-property `required: true`

**Symptom.** TS rejects `required: ['a','b']` as an unknown key, or at runtime
`<path>.required must be true when present`. Or worse: it compiles because you put the array
somewhere unchecked, and every argument silently becomes optional in the inferred `args` type.

**Cause.** The DSL is not JSON Schema. Requiredness is a **per-property annotation**
(`ParameterPropertySpec = ValueSchemaSpec & { required?: true }`).

**Fix.**

```ts
parameters: {
  path:  { type: 'string', required: true, description: 'Repo-relative file path.' },
  limit: { type: 'number', description: 'Optional cap.' },
}
```

Positional restriction — `required` is legal **only** on a direct key of `parameters` or of an
object node's `properties`. It is an author error on `items`, on `oneOf` branches, and at a schema
root. Any value other than literal `true` errors.

Also: the enforced subset has **no** validation keywords beyond `enum` and `const`. No `minLength`,
`pattern`, `format`, `minimum`, `minItems`. Unknown author keys hard-error.

---

## 5. `interface` breaks assignability to a `{ type: 'json' }` output node

**Symptom.** Any of:

```
Type 'Bad' is not assignable to type '{ [key: string]: JsonValue; }'.
  Index signature for type 'string' is missing in type 'Bad'.
```

```
Type 'X' is not assignable to type 'never'.
```

```
execute(...) is declared to return Promise<never>
```

The `never` / `Promise<never>` shapes are the confusing ones: the object node's inferred value type
collapses once one property fails to unify with `JsonValue`.

**Cause.** TypeScript gives object **type aliases** an implicit index signature; it does **not**
give one to `interface` declarations (they are open to declaration merging, so an index signature
cannot be inferred soundly). `JsonValue` requires one.

**Fix.** Use `type` aliases — not `interface` — for anything that flows through a `{ type: 'json' }`
node, through `output.presentationMeta`, or into `result.meta`.

```ts
// ✗
export interface Stats { filesReviewed: number }

// ✓
export type Stats = {
  filesReviewed: number
  model: string | null      // NOT `model?: string` — see below
}
```

Second trap in the same family: an `undefined` property does not satisfy a JSON node. Absent values
must be `null`, so give JSON-bound types **no optional members**.

`JsonValue` = `null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }`, and
"lossless" additionally means finite numbers, no `-0`, no sparse/cyclic/exotic values.

---

## 6. Forgetting `ctx.effect` cleanup — orphaned child processes on HMR

**Symptom.** After editing config or saving a file (HMR), stray `pi` / `git` / whatever processes
keep running, keep holding a paid provider session, and pile up across reloads. Or: a required
service disappears, your plugin unloads, and its timers keep firing.

**Cause.** `apply()` can run **many times per process**. When a required (injected) service
disappears at runtime, dependent plugins dispose and unwind, then load again when it returns.
Anything registered through `ctx` (listeners, tools, timers) is cleaned up automatically — anything
you created yourself is not.

**Fix.** Wrap external resources in `ctx.effect`. `execute` runs immediately; the disposers it
produces run in **reverse** order on either the returned disposer or fiber unload, whichever comes
first.

```ts
const running = new Set<ChildProcess>()
ctx.effect(() => () => {
  for (const child of running) child.kill('SIGKILL')
  running.clear()
})
```

Notes:

- Accepted body shapes: a disposer `() => void`, an iterable of disposers, a `Promise<Disposable>`,
  or an async iterable. Anything else throws `TypeError('Invalid effect')`.
- `ctx.effect(fn, label?)` — the label shows in `fiber.getEffects()`; a disposer merely *returned*
  from `apply()` lands flat on the fiber, gets no label, and cannot be released early. Prefer
  `ctx.effect`.
- Calling on an already-disposed or unloading fiber throws `CordisError('INACTIVE_EFFECT')`.
- If teardown order matters, keep the related work inside **one** `ctx.effect()`.

Do **not** reach for `export const disposable` / `export const reusable` / `using` — those are
Koishi / older-cordis concepts and do not exist in cordis 4.0.1. The complete module-export set is
`name`, `Config`, `inject`, `provide`, `intercept`, plus the entrypoint.

---

## 7. Assuming `process.cwd()` is the session's workspace

**Symptom.** The tool reads or diffs the wrong directory: it works when you launch dsh from the
project root and silently reads elsewhere otherwise. Paths resolve relative to the harness process,
not the user's project.

**Cause.** `process.cwd()` is the directory the *harness* was launched from. It may be any
subdirectory, or a completely unrelated one, and one harness process can serve several workspaces.

**Fix, in order of preference:**

1. Take an explicit `cwd`/`path` tool parameter and prefer it: `const cwd = args.cwd || fallback`.
2. Normalize immediately to a stable root rather than trusting the raw value, e.g.
   `git rev-parse --show-toplevel`, and run every subsequent call from that root.
3. `ctx.workspaceRegistry` (`WorkspaceRegistry`) is the real workspace source of truth —
   `resolveByPath(path)`, `get(id)`, `list()`. **But it is web-profile only**: `dsh-workspace` is not
   mounted in the headless profile. Never put it in `inject` unless the plugin is web-only (a plugin
   injecting a service that no profile mounts simply never loads, silently). Query it optionally:

```ts
const workspaces = ctx.get('workspaceRegistry')
const ws = await workspaces?.resolveByPath(cwd)
```

Same rule for `ctx.storage` and `ctx.storageDomain` (web-only), and for `ctx.terminals`,
`ctx.authorization`, `ctx.invariants` (declared by installed packages but mounted by **neither**
stock profile).

---

## 8. No `dsh` PATH shim

**Symptom.** `dsh: command not found`, or a doc example that simply does not run.

**Cause.** The DSH docs are written assuming a PATH-resolvable `dsh`. This installation has none.

**Fix.** Always invoke the CLI by path:

```bash
DSH="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"
$DSH --profile web --dump-config
```

The same reasoning propagates *into* your plugin: the harness's `PATH` may differ from your shell's,
so a config field naming an external binary should accept an absolute path, and an `ENOENT` from
`spawn` should be turned into an actionable message naming the install command.

---

## 9. A directory install is a symlink — moving the plugin breaks the profile

**Symptom.** Any of:

- Source edits have no effect at all.
- After moving/renaming/deleting the checkout, the profile fails to boot, or the plugin vanishes
  from `--dump-config`.
- A fresh `git clone` + install produces "cannot find module .../dist/index.js".

**Cause.** A directory spec installs as **`link:` (symlink), not `file:` (copy)** — and pnpm rewrites
your relative `./plugin` into an absolute `link:/abs/path`. Consequences:

- `prepare` / `build` **does not run** on install. `dist/` must exist beforehand.
- `dist/` is git-ignored, so a fresh clone has none.
- The profile now depends on that absolute path continuing to exist.

**Fix.**

```bash
cd $P && npm install && npm run build     # before install, and after EVERY source edit
```

If you move the checkout: `remove` then `add -w` from the new location. For anything you want to be
durable, publish to npm or `pnpm pack` a tarball instead of linking.

Inverse trap for git-hosted installs: `prepare` **does** run, and pnpm ≥10 blocks it until the
package is allow-listed. **dsh's own error message tells you the wrong key.** It prints "add the
exact key pnpm printed above under `allowBuilds`" — `allowBuilds` does not exist in pnpm 10.4.1
(it appears nowhere in `pnpm.cjs`) and a `pnpm-workspace.yaml` containing it is silently inert. The
working key is `onlyBuiltDependencies`, and it takes a **list of package names**:

```yaml
# ~/.dsh/profiles/<p>/pnpm-workspace.yaml
packages: [.]
onlyBuiltDependencies:
  - dsh-my-plugin        # the package name pnpm printed as blocked
```

Then re-run the add. Pin a commit SHA. Also make `prepare` self-contained — a git install fetches
sources with no sibling monorepo checkout.

---

## 10. Enum arrays need `as const` — but only when hoisted

**Symptom.**

```
error TS2322: Type 'string' is not assignable to type '"a" | "b"'.
```

…or `args.mode` inferring as `string` instead of the literal union, so your `switch` loses
exhaustiveness.

**Cause.** `defineTool` is declared `<const S extends ParameterSchemaSpec, const O extends
ValueSchemaSpec>`. The `const` type parameters mean an array literal written **inline** in the
`defineTool` call already infers as a readonly literal tuple. A tuple **hoisted** to a separate
`const` binding is inferred before it reaches `defineTool`, so it widens to `string[]`.

**Fix.**

```ts
// inline — no `as const` needed, infers 'fast' | 'accurate'
parameters: { mode: { type: 'string', enum: ['fast', 'accurate'] } }

// hoisted — `as const` is REQUIRED
export const MODES = ['fast', 'accurate'] as const
parameters: { mode: { type: 'string', enum: MODES } }
```

Hoisting is worth it when the same tuple feeds both `parameters` and `output.schema` and a TS union
(`type Mode = (typeof MODES)[number]`) — just never forget the `as const`.

Unrelated but adjacent: in Schemastery, `Schema.union(['fast','accurate'] as const)` builds the
string-literal union for the settings form.

---

## 11. External CLIs that exit 0 on failure

**Symptom.** The tool reports success with empty or nonsense content. A provider 401 comes back as
"no findings".

**Cause.** Many agent CLIs (the `pi` binary among them) return exit code **0** even when the
underlying provider call failed. The exit code is not the success signal.

**Fix.** Decide what your real success signal is, parse it, and unit-test the failure shape.

```ts
// pi --mode json: the event stream is the source of truth, not the exit code
for (const event of parseEventStream(stdout)) {
  if (event.type === 'message_end' && event.message?.stopReason === 'error') {
    throw new Error(event.message.errorMessage ?? 'agent reported an error')
  }
}
```

Adjacent subprocess traps worth encoding at the same time:

- **Promise that never settles.** If you guard with a `settled` flag, make sure the `close` handler
  can still reject — a `fail()` helper that no-ops when `settled === true` will hang the tool.
- **Thread `exec.signal`.** `ToolRunContext.signal` is a **required** `AbortSignal`. Pass it into
  every subprocess and network call, and honour it in loops. Cancelled-after-dispatch surfaces as
  `TOOL_ABORTED`.
- **Never truncate silently.** If you drop content for a size budget, name what you dropped, both in
  the value returned to the model and in the rendered content.

---

## 12. `inject` object form is *not* `{ required, optional }`

**Symptom.** The plugin never loads. No error, no log line — `apply()` simply never runs, and the
tool never appears.

**Cause.** cordis 4.0.1 declares `type Inject<M> = (keyof M)[] | { [K in keyof M]?: M[K] }`. The
object form maps **service name → intercept config**. The cordis-3 `{ required: [...], optional:
[...] }` shape is gone: `Inject.resolve({required:['a'],optional:['b']})` returns
`{ required: ['a'], optional: ['b'] }`, i.e. the fiber blocks forever waiting on services literally
named `required` and `optional`.

**Fix.** Every entry in `inject` is required and blocking. Use the array form:

```ts
export const inject = ['tools']
```

For an optional dependency, **omit it** and query at the use site:

```ts
const metrics = ctx.get('metrics')   // undefined unless a provider fiber is ACTIVE
metrics?.record(/* … */)
```

or nest: `ctx.inject(['metrics'], (ctx) => { /* re-runs as the service comes and goes */ })`.

Also never put optional Context *members* in `inject` — `agent`, `dshHomePath`, `cmdlineArgs`,
`appExit`, `launchEnvironment`, `baseUrl`, `configuredAgentIdentities` are not services.

---

## 13. Config exported as a plain object

**Symptom.** `TypeError` at load, or the config arrives raw with no defaults applied.

**Cause.** Cordis requires `Config` to be a **Standard Schema (v1)** implementation — it calls into
`'~standard'`. A plain object literal is not one.

**Fix.** Export both a TypeScript `interface Config` and a same-named runtime schema (declaration
merging does the rest):

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string; maxLength: number }

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello').description('…'),
  maxLength: Schema.number().min(1).default(10_000),
})
```

Defaults go on the field (`.default(x)`); requiredness is `.required()`. The schema runs at plugin
**load** time; an invalid config fails the load with `ValidationError: invalid config:` plus
per-path violations, sends the fiber to FAILED, and exits the launcher non-zero. Async validation is
explicitly rejected.

---

## 14. Wrong dispatch method for an event

**Symptom.** A listener's return value is ignored, or `await ctx.emit(...)` resolves immediately, or
a veto silently does nothing.

**Cause.** The dispatch mode is part of the event's public contract (declared with an `@mode` JSDoc
tag). There are exactly five: `emit` (sync, ignores returns), `parallel` (awaits all concurrently),
`serial` (awaits in order until a bail), `bail` (sync, stops at the first bail value), `waterfall`
(around-middleware). Dispatching with the wrong method is an error.

**Fix.** Check the declared mode before writing the listener. Specifically:

- `ctx.waterfall` is **around-middleware, not a value fold**. The listener receives `(...args, next)`.
  `await next()` continues the chain (the innermost `next` is the built-in behavior). **Not** calling
  `next()` vetoes/short-circuits — that is the intended mechanism for single-decision events.
- A "bail value" is anything other than `null`, `false`, or `undefined`. **`0` and `''` do bail.**
- `agent/turn-stopping` is `serial`, not waterfall — a listener that objects calls `agent.steer(...)`;
  listener order cannot change the outcome.
- `agent/step` **does not exist** despite appearing in one docs page. `step/*` and `turn/*` are
  durable `SessionEvent` *types* — observe them via `ctx.on('session/event', (session, event) => …)`
  and switch on `event.type`.
- Registry-change event names: `tools/change`, `commands/change`, `system-prompt/change` — but
  `skills/change` (plural).

---

## 15. `ctx.approval` vs `approvals`, `ctx.fs` vs `filesystem`, `ctx.webServer` vs `http`

**Symptom.** `Cannot read properties of undefined`, or the plugin never loads because it injected a
service name nothing provides.

**Cause.** Folklore names that do not exist.

**Fix.** The real names:

| Wrong | Right | Notes |
|---|---|---|
| `ctx.approvals` | `ctx.approval` | singular; `dsh-user-approval` |
| `ctx.filesystem` | `ctx.fs` | `dsh-fs` |
| `ctx.http` / `ctx.server` | `ctx.webServer` | **web profile only** |
| `ctx.storage`, `ctx.workspaceRegistry`, `ctx.storageDomain` | exist, but **web profile only** | query with `ctx.get(...)` |
| `ctx.terminals`, `ctx.authorization`, `ctx.invariants` | declared, **mounted by neither** stock profile | injecting them = never loads |

### Never inject a cordis core member

`logger`, `events`, `reflect`, `registry`, `fiber`, `root` are **plain properties assigned directly
on the root context**, not services. `LoggerService` does not extend `Service`, so it is never
`provide()`d — empirically `ctx.get('logger') === undefined` while `ctx.logger` is present and
usable (it is a function: `ctx.logger('my-plugin')`).

**Symptom of getting this wrong: the plugin silently never loads. No error, no log line, no warning
— `apply()` simply never runs and the tool never appears.** The fiber blocks forever waiting for a
service that will never be provided.

```ts
export const inject = ['tools', 'logger']   // ✗ apply() NEVER runs
export const inject = ['tools']             // ✓ then just use ctx.logger('my-plugin')
```

| Never in `inject` | Why | Use instead |
|---|---|---|
| `logger` | plain property on root ctx; `LoggerService` is not a `Service` | `ctx.logger('id')` directly |
| `events`, `reflect`, `registry` | cordis internals, plain properties | access directly, always present |
| `fiber`, `root` | per-context members, plain properties | access directly, always present |

These are always present on every context, so there is nothing to wait for — injecting them buys
nothing and costs you the whole plugin.

Confirm before injecting:

```bash
$DSH --profile headless --dump-config | grep dsh-workspace   # → nothing
```

Never inject the RPC/transport internals (`typert`, `apiProxy`, `connection`, `remote`,
`clientModules`, `dynamicCordisRunner`) or any `dsh-client-ui-*` service (browser bundle only).

---

## 16. Patch overrides replace, they do not merge

**Symptom.** You add a patch that sets one config key and every other key reverts to schema defaults.
Or a patch silently does nothing.

**Cause.** A patch entry replaces each targeted key's **whole value** — `config` is replaced
wholesale, never deep-merged. And several things fail *quietly*:

- A patch that matches nothing **warns and is skipped**, never a hard failure.
- On a non-`insert` entry, `id` is required (`patch: id is required for non-insert patches`).
- An optional `name:` on an override is a **guard, not a rename**: a mismatch warns
  `patch: name mismatch` and skips the whole entry.
- An `id` inside the overrides is silently ignored — rows cannot be renamed.
- There is **no** `remove` / `delete` directive. Removal is `disabled: true`.

**Fix.** Restate every key the row needs, and check the result:

```yaml
- id: my-plugin
  config:
    defaultMode: lower
    maxLength: 4000      # restate this even if only defaultMode changed
```

```bash
$DSH --profile web --dump-config      # unmatched targets are reported on stderr
```

A row has exactly **eight** keys: `id`, `name`, `config`, `group`, `disabled`, `inject`, plus
`intercept` and `isolate`. Nothing else. The first six are `EntryOptions` in
`cordis-plugin-loader/lib/types/config/entry.d.ts`; `intercept?: Dict | null` and
`isolate?: Dict<true | string> | null` are declaration-merged onto `EntryOptions` by the loader's
isolate module (`.../types/config/isolate.d.ts`), so they are legal on any row — `isolate` gives the
entry its own realm for the named services, `intercept` sets per-entry intercept config.
`!!js` expressions are legal only inside `config` values and in `disabled`.
