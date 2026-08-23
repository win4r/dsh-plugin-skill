# Services and events

Dependency injection, defining a service, `ctx.effect()` disposal, the event system, the full
extension-point catalog, and the `ctx.*` service catalog.

Verified against `@deepseek-ai/cordis` **4.0.1** and `dsh-*` **0.1.1-rc.2** as installed in
`/Users/charlesqin/.dsh/profiles/node_modules/@deepseek-ai/`.

---

## 1. `inject` — declaring dependencies

```ts
type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }
```

Both forms declare **required, blocking** dependencies. The framework waits for every named service
before running `apply`, disposes the plugin when one disappears, and re-runs `apply` when it returns.

### 1a. Array form (the default)

```ts
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)      // guaranteed present
}
```

### 1b. Object form = service name → **intercept config**

The object form is **not** a required/optional split. Every key is a **required** service, exactly as
in the array form; the **value is that service's intercept config**, merged into the plugin's own
context. `null` means "required, no intercept config".

```ts
export const inject = {
  tools: null,                 // required, no intercept config
  fs: null,                    // required, no intercept config
}
```

A **non-`null`** value is only meaningful for a service that declares an intercept-config type — one
extending `Service<TConfig>`. Cordis narrows exactly those to `InjectKey`:

```ts
export type InjectKey = keyof {
  [K in keyof Context & string as Context[K] extends { [symbols.config]: any } ? K : never]: any
}
```

In this installation **no `dsh-*` service declares one** (the sole `extends Service<T>` in the tree is
`TypertRemoteService`), so in practice every value you write is `null` — and the array form is then
the better spelling. Never put a non-service name here; see §1f.

`Fiber`'s constructor does literally this:

```ts
this.ctx[Context.intercept] = Object.create(parent[Context.intercept])
for (const [name, config] of injectEntries) {
  if (isNullable(config)) continue
  this.ctx[Context.intercept][name] = config
}
```

### 1c. ⚠ `{ required: [...], optional: [...] }` does not exist

That is cordis 3.x. `Inject.resolve` treats every key as a service name. Verified at runtime against
the installed 4.0.1:

```
> Inject.resolve({ required: ['a'], optional: ['b'] })
[Object: null prototype] { required: [ 'a' ], optional: [ 'b' ] }
```

A plugin written that way **silently never loads** — it blocks forever on services literally named
`required` and `optional`.

### 1d. Optional dependencies

Omit the service from `inject` and query at the use site.

```ts
export const inject = ['tools']                 // hard requirement

export function apply(ctx: Context) {
  const ws = ctx.get('workspaceRegistry')       // web-profile-only service
  if (ws) { /* enhanced path */ }

  // Or: run a sub-plugin that loads and unloads with the optional service.
  ctx.inject(['storage'], (scoped) => {
    scoped.storage.mount(/* ... */)             // this callback re-runs when `storage` changes
  })
}
```

```ts
get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
```

`strict` defaults to `true`: only implementations whose providing fiber is currently **ACTIVE** are
returned. Returns `undefined` when not (yet) provided. `ctx.get` is the only way to read a service
you did not inject.

### 1e. Where `inject` may be declared

| Form | Declaration |
| --- | --- |
| Function plugin | `export const inject = ['tools']`, or `apply.inject = ['tools']` |
| Object plugin | `{ name, inject, Config, apply }` |
| Class plugin / Service | `static inject = ['llm']` (prototype-chained; parent-class injections are inherited) |
| Loader row | `inject: [svc]` on a `cordis.yml` / patch row — also what defers that row's `!!js` config |
| Ad hoc | `ctx.inject(deps, callback)` — shorthand for `ctx.plugin({ inject: deps, apply: callback })` |

`@Inject(name, config?)` decorator: on a **class** it contributes to a prototype-chained
`static inject` map; on a **method** it registers an init hook that runs the method body inside
`ctx.inject(inject, cb)`, deferring and re-running it as services change. Anything else throws
`Error('@Inject() can only be used on class or class methods')`.

### 1f. Never inject these

**Cordis core members are plain properties, not `provide()`d services:** `logger`, `events`,
`reflect`, `registry`, `fiber`, `root`. They are assigned directly onto the root context —
`LoggerService` does not extend `Service`, so it is never `provide()`d — which is why `ctx.logger`
works while `ctx.get('logger')` is `undefined`. Injecting any of them blocks forever: a plugin
declaring `inject: ['logger']` **never runs its `apply()`**, silently. They are always present and
need no `inject` at all — see §6a.

Optional `Context` members are **not provided services** and are illegal in an `inject` list:
`agent?`, `dshHomePath?`, `cmdlineArgs?`, `appExit?`, `launchEnvironment?`, `baseUrl?`,
`configuredAgentIdentities?`, `launcherSessionQueryPath?`.

Services declared by installed packages but mounted by **neither** stock profile — injecting them
makes a plugin silently never load: `ctx.terminals`, `ctx.authorization`, `ctx.invariants`.

---

## 2. Defining a service

### 2a. The `Service` base class

```ts
abstract class Service<out T = never> {
  protected ctx: Context
  name: string
  constructor(ctx: Context, name: string)      // TWO parameters. No `immediate?` (that was cordis 3.x).
  static readonly init | check | config | invoke | extend | tracker | resolveConfig: unique symbol
}
```

- `super(ctx, name)` calls `ctx.reflect.provide(name, self, this[Service.check])` **unconditionally
  and immediately**, so `ctx.<name>` is live as soon as the constructor returns and disappears
  automatically when the fiber unloads.
- **There is no `start()` and no `stop()`** in 4.0.1. The only post-construction hook is
  `[Service.init]`, invoked only for class plugins. Its return value goes through the same effect
  collector, so it may be async and may return a disposer.
- Teardown otherwise goes through `ctx.effect()`.

| Symbol | Purpose |
| --- | --- |
| `Service.init` | Post-construction hook (class plugins only). May be async; may return a disposer. |
| `Service.check` | `() => boolean` availability predicate handed to `provide()`; dependents wait on it. |
| `Service.invoke` | Call body making the service callable — this is how `ctx.logger('name')` works. |
| `Service.config` | Phantom key carrying `Service<T>`'s intercept-config type; what puts the name in `InjectKey` and types `ctx.intercept(name, cfg)`. |
| `Service.resolveConfig` | Merges ancestors' `ctx.intercept()` entries with base/head. |
| `Service.tracker` | `{ associate, property }` — makes methods see the caller's context via `this.ctx`. |
| `Service.extend` | Derive a per-context extended instance. |

### 2b. Canonical service plugin (compiles clean under `strict`)

```ts
// src/index.ts
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
  interface Events {
    'metrics/flushed'(count: number): void
  }
}

export interface Config { flushIntervalMs: number }
export const Config: Schema<Config> = Schema.object({
  flushIntervalMs: Schema.number().min(1000).default(60_000),
})

export default class MetricsService extends Service {
  static inject = ['llm']            // services THIS service needs
  static Config = Config

  private buffer: { event: string; value: number }[] = []

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'metrics')            // -> ctx.metrics, registered immediately
  }

  protected async [Service.init]() {
    this.ctx.effect(() => {
      const t = setInterval(() => this.flush(), this.config.flushIntervalMs)
      return () => { clearInterval(t); this.flush() }
    }, 'metrics:flush-timer')
  }

  record(event: string, value: number) {
    this.buffer.push({ event, value })
  }

  private flush() {
    const n = this.buffer.length
    this.buffer = []
    this.ctx.emit('metrics/flushed', n)
  }
}
```

Consumers then write `export const inject = ['metrics']` and call `ctx.metrics.record(...)`.

### 2c. Declaration merging — the exact pattern

Augment the **package specifier** `'@deepseek-ai/cordis'`, not an internal path. Both `Context` and
`Events` are open interfaces. This is exactly what the shipped packages do (`dsh-tools` →
`interface Context { tools: ToolRuntime }`, `dsh-session` → `sessions: SessionStore`, `dsh-llm` →
events only).

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
  interface Events {
    // Method-shorthand form additionally types `this` (what harness packages use):
    'metrics/flushed'(count: number): void
    'metrics/transform'(input: string, next: () => Promise<string>): Promise<string>   // waterfall
  }
}
```

Gotchas:
- The augmenting file must be a **module** (have a top-level `import`/`export`), otherwise
  `declare module` is a module *declaration*, not an augmentation.
- The augmentation applies only where the file is in the program. Ship it in your published `.d.ts`
  so consumers get `ctx.metrics` typed.
- To get an intercept-config type (and appear in `InjectKey`), extend `Service<TConfig>`.

### 2d. `provide` / `set` / `accessor` without subclassing

```ts
provide(name: string, value?: any): () => void    // fiber-owned; returns a disposer that also wakes dependents
set(name: string, value: any): void               // ONLY the providing fiber may call this; throws otherwise
accessor(name: string, options): void             // getter/setter-backed pseudo-service
```

`provide` throws if the name is already provided in that isolation scope or is declared as an
accessor.

### 2e. Context scoping

```ts
extend(meta?: {}): this                   // child ctx (prototypal); parent untouched
isolate(name: string, label?: symbol): this  // child ctx with an independent service scope for `name`
intercept<K extends InjectKey>(name: K, config): this
static Context.is(value): value is Context   // global-symbol brand; works across duplicate cordis copies
```

`ctx` is a **Proxy**: property reads go through the service resolver. `extend` / `isolate` /
`intercept` never mutate the parent. Passing the same `label` symbol to two `isolate()` calls joins
their scopes. The declarative equivalent is a `cordis-plugin-group` row with `group: true` and an
`isolate:` map.

---

## 3. `ctx.effect()` — contract and disposal ordering

```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect,     label?: string): AsyncDisposable<Promise<void>>

type Disposable<T = any> = () => T
type SyncEffect<T = any>  = Disposable<T> | Iterable<Disposable<T>, void, void>
type AsyncEffect<T = any> = Promise<Disposable<T>> | AsyncIterable<Disposable<T>, void, void>
type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>
```

`label` defaults to `'anonymous'` and shows up in `ctx.fiber.getEffects()`.

**Contract:**
- `execute` runs **immediately and synchronously**.
- The disposers it produces run in **reverse registration order**, either when the returned disposer
  is called or when the fiber unloads — **whichever comes first**.
- The returned disposer is **idempotent**; a second call returns the in-flight disposal task.
- Throws `CordisError('INACTIVE_EFFECT')` if the fiber is disposed **or already UNLOADING**.
- Throws `TypeError('Invalid effect')` if `execute` returns any other shape.
- Nested effects registered inside `execute` become `EffectMeta.children`.
- If `execute` throws synchronously, already-collected disposers are rolled back and the error rethrown.

Accepted `execute` return shapes:

```ts
() => {}                                   // nothing to dispose
() => () => cleanup()                      // one disposer
() => Promise.resolve(() => cleanup())     // awaited, then collected
function* () { yield d1; yield d2 }         // generator: each yielded disposer collected as produced
async function* () { yield d1 }             // async generator
```

### 3a. When you actually need it

Anything registered through `ctx` (tools, `ctx.on`, `ctx.provide`, `ctx.timer.*`,
`ctx.systemPrompt.section`, `ctx.commands.register`, …) already returns a fiber-owned disposer and
cleans itself up. `ctx.effect()` is for **external** resources:

- child processes (`spawn`) — kill on unload, or HMR orphans them
- sockets, servers, file watchers
- raw `setInterval` / `setTimeout` (or use `ctx.timer.interval`, which is already disposable)
- native handles, DB connections, subscriptions to non-cordis emitters

```ts
const running = new Set<ChildProcess>()
ctx.effect(() => () => {
  for (const child of running) child.kill('SIGKILL')
  running.clear()
}, 'kill-orphans')
```

### 3b. `ctx.effect()` vs returning a disposer from `apply()`

Same collector, different granularity. A disposer returned from `apply` lands flat on
`fiber._disposables`.

| | `return () => …` from `apply` | `ctx.effect(() => () => …, 'label')` |
| --- | --- | --- |
| When it can be registered | once, at the end of `apply` | any time while the fiber is active |
| Early teardown | no — only on fiber unload | yes — call the returned disposer |
| Labeled in `getEffects()` | no | yes, with nesting |
| Idempotency wrapper | none | yes |

Verified teardown order — an effect registered first inside `apply`, plus a disposer returned from
`apply`:

```
effect A up
apply-returned disposer      <- runs first (registered last)
effect A down
```

Rule: if teardown **order** matters, keep the related work inside **one** `ctx.effect()` so disposal
unwinds in the intended sequence.

### 3c. All fiber-owned disposal mechanisms

`ctx.on` / `ctx.once` · `ctx.provide` · `ctx.accessor` · `ctx.mixin` · returning an `Effect` shape
from the plugin body / `apply()` / `[Service.init]` · `Service` subclass instances ·
`ctx.effect()` · `fiber.dispose(): Promise<void>`. All run in reverse registration order; async
disposers are awaited.

---

## 4. The event system

Event methods live on `ctx.events` (an `EventsService`) and are mixed onto `ctx`, so
`ctx.on === ctx.events.on`.

```ts
type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
```

**The dispatch mode is part of an event's public contract** (declared with a `@mode` JSDoc tag).
Dispatching an event with the wrong method is an error.

| Method | Awaited | Order | Returns |
| --- | --- | --- | --- |
| `ctx.emit(name, ...args)` | no | registration order, sync; return values ignored | `void` |
| `ctx.parallel(name, ...args)` | yes | all listeners started concurrently | `Promise<void>` |
| `ctx.serial(name, ...args)` | yes | registration order, one at a time, stops at the first bail value | `Promisify<ReturnType<Events[K]>>` |
| `ctx.bail(name, ...args)` | no (sync) | registration order until the first bail value | `ReturnType<Events[K]>` |
| `ctx.waterfall(name, ...args)` | depends on the event's own return type | outermost → innermost around-chain | outermost listener's return value |

A **bail value** is any result other than `null`, `false`, or `undefined`. `0` and `''` **do** bail.
`isBailed(value)` is exported.

Each method also has a `thisArg`-first overload:
`emit<K>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args)`, etc.

### 4a. Registration

```ts
on  <K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean

interface EventOptions {
  prepend?: boolean   // insert before existing listeners for the same event
  global?: boolean    // receive the event regardless of context filter checks
}
```

- A bare boolean third argument is shorthand for `prepend`.
- Returns a disposer that yields `true` if the listener was still registered.
- Listeners are **fiber-owned**: `EventsService.on` calls `ctx.fiber.assertActive()` and registers via
  `ctx.fiber.effect(...)` with label `ctx.on("<name>")`, so they are removed automatically on unload.
  Registering on a disposed fiber throws `CordisError('INACTIVE_EFFECT')`.
- Every dispatch consults `Context[symbols.filter]` (`Context.filter`) — this is how
  `@deepseek-ai/dsh-scope` delivers agent-scoped events to only that agent's listeners.
  `{ global: true }` opts out of that filtering.

### 4b. `waterfall` and `next()`

`ctx.waterfall` is **around-middleware, not a value fold.**

- The event's declared signature ends with a `next` continuation. A listener receives `(...args, next)`.
- `await next()` invokes the next listener. **The innermost `next` is the built-in/default
  behavior**, passed as the final argument at the dispatch site.
- **Not calling `next()` vetoes / short-circuits the chain**, including the built-in behavior. That is
  the intended mechanism for single-decision events.
- A listener may transform or fully replace `next()`'s result.
- A listener that only observes or annotates **must** delegate.
- Use `{ prepend: true }` only when the listener must run before ordinary registrations.

```ts
// dispatch — the final argument IS the innermost next
const out = await ctx.waterfall('my-plugin/transform', input, async () => input)

// observe + transform (delegates)
ctx.on('my-plugin/transform', async (_input, next) => {
  const downstream = await next()
  return downstream.trim()
})

// veto (does NOT call next)
ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.name === 'bash' && isDangerous(exec.arguments)) {
    return { kind: 'deny', reason: 'blocked by policy' }
  }
  return next()
})
```

Note: whether a waterfall dispatch must be awaited depends entirely on the event's declared return
type. Every harness waterfall event listed in §5 returns a Promise and **must** be awaited.

### 4c. Typing your own events

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready'(payload: { id: string }): void                                  // emit
    'my-plugin/check'(input: string): boolean | undefined                             // bail
    'my-plugin/transform'(input: string, next: () => Promise<string>): Promise<string> // waterfall
  }
}
```

Document the mode in a JSDoc `@mode` tag on each declaration, as the harness packages do.

### 4d. Cordis built-in `internal/*` events

```ts
'internal/plugin'(fiber: Fiber): void                        // plain
'internal/status'(fiber: Fiber, oldValue: FiberState): void  // plain
'internal/config'(this: Fiber, config, next): any                       // waterfall
'internal/update'(this: Fiber, config, noSave: boolean, next): void|Promise<void>  // waterfall; skipping next() VETOES the update
'internal/get'(ctx, name, error, next): any                             // waterfall
'internal/set'(ctx, name, value, error, next): boolean                  // waterfall
'internal/listener'(this: Context, name, listener, prepend): void        // bail; a non-null result REPLACES the registration
'internal/service'(this: Context, name, value): void                     // interception hook, no core producer
'internal/dispatch'(mode, name, args, thisArg): void                     // fires for NON-internal events only
```

---

## 5. Extension-point catalog

All verified from the installed `declare module '@deepseek-ai/cordis' { interface Events }` blocks.
`Scoped<T>` comes from `@deepseek-ai/dsh-scope`: agent-scoped listeners receive only their agent's
events unless marked UNFILTERED or registered with `{ global: true }`.

### 5a. `@deepseek-ai/dsh-tools`

| Event | Mode | Signature / notes |
| --- | --- | --- |
| `tools/pre-execute` | **waterfall** | `(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>` — allow/deny/ask before dispatch. `next()` delegates to allow. With no approval service present, `'ask'` becomes a denial. Async gates MUST observe `exec.signal`. |
| `tools/execute` | **waterfall** | `(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>` — around-dispatch (timeout/retry/metrics). Wrappers may change **only** `exec.signal`; call identity is immutable and the registry re-fuses the caller signal before the body. |
| `tools/post-execute` | **waterfall** | `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>` — accept/replace/enrich/block. Tools that throw reach it as errors. |
| `tools/code-dispatch-log` | **waterfall** | `(dispatch: CodeDispatchLog, next: () => Promise<ContentBlock[]>) => Promise<ContentBlock[]>` — rewrites **only** the durable log copy of a `run_code` sub-dispatch. The program already got the full value; the model sees neither. A throwing listener falls back to the original content. |
| `tools/result` | emit | `(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => undefined` — deep-frozen lossless-JSON final outcome; listener failures contained. |
| `tools/change` | emit | `() => void` — takes no arguments and is deliberately **UNFILTERED**: scoped listeners see every registry change. |

```ts
type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block';  feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

Pipeline order: `tools/pre-execute` → monotonic guards → `tools/execute` → `tools/post-execute` →
registry lossless snapshot → definition-owned `finalizeContent` → `tools/result`.
`ctx.approval` resolves `'ask'` **before** monotonic guards.

### 5b. `@deepseek-ai/dsh-agent`

| Event | Mode | Signature / notes |
| --- | --- | --- |
| `agent/created` | emit | `(this: Scoped<Agent>, payload: { agent: Agent }) => void` — a **synchronous throw VETOES** publication; a returned-promise rejection is only reported. |
| `agent/disposed` | emit | `(this: Scoped<Agent>, payload: { agent: Agent }) => void` — after driver quiescence, before session detach. |
| `agent/status` | emit | `(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }) => void`, `AgentStatus = 'idle' \| 'running'`. |
| `agent/session-start` | emit | `(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource }) => void`, `SessionStartSource = 'startup'\|'resume'\|'clear'\|'compact'`. Fires once before the first turn. A **notification, not a veto** — the place to call `agent.inject()` to seed model-facing context. |
| `agent/inbox/inserted` | emit | `(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }) => void` |
| `agent/inbox/claimed` | emit | `(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage; turn: number }) => void` |
| `agent/inbox/discarded` | emit | `(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }) => void` |
| `agent/pre-step` | **waterfall** | `(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>` — reject the step or replace its messages. `next()` preserves the current messages. |
| `agent/request` | **waterfall** | `(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>` — replaces the frozen call configuration. **Cannot mutate messages** — model-visible content must go through logged channels. |
| `agent/request-error` | **waterfall** | `(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; provider: string; failure: LlmFailure; retryPolicy: ResolvedRetryPolicy \| undefined; signal: AbortSignal }, next: () => Promise<RequestErrorAction>) => Promise<RequestErrorAction>` — a listener that owns recovery returns `{ kind: 'retry' }` **without** calling `next()`; the default `undefined` leaves the failure terminal. |
| `agent/turn-stopping` | **serial** | `(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }) => Promise<void> \| void` — awaited at the stop boundary. A listener that objects calls `agent.steer(...)` and the machine re-reads its inbox; **listener order cannot change the outcome** because data decides. The inverse control is a tool result carrying `concludesTurn`. |
| `agent/error` | emit | `(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; error: unknown }) => void` |

```ts
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }
type RequestErrorAction = { kind: 'retry' } | undefined
```

**Every row carries `this: Scoped<Agent>`** — `dsh-agent`'s `declare module` block declares the
`this` type on all twelve, so an agent-scoped listener sees only its own agent's events.

⚠ **The twelve rows above are the complete `dsh-agent` event set.** In particular **there is no
`agent/step` event**: the official docs list one, it does not exist in the installed `dsh-agent`
0.1.1-rc.2, and a listener registered for it never fires. `step/*` exists only as a durable
`SessionEvent` type — observe it via `session/event` (§5c).

### 5c. `@deepseek-ai/dsh-session`

| Event | Mode | Signature / notes |
| --- | --- | --- |
| `session/created` | emit | `(this: Scoped<Session>, session: Session) => void` — a synchronous throw **vetoes** and rolls back with a paired disposal. |
| `session/disposed` | emit | `(this: Scoped<Session>, session: Session) => void` |
| `session/event` | emit | `(session: Session, event: SessionEvent) => void` — post-commit fire-and-forget append feed; observer failures contained. |
| `session/flush` | **parallel** | `(session: Session) => Promise<void> \| void` — an awaited durability checkpoint, no veto. |

**`turn/*`, `step/*`, `tool/call`, `tool/result`, and `compaction/*` are durable `SessionEvent`
TYPES, not Cordis events.** Observe them by listening to `session/event` and switching on
`event.type`. `session/event` is the replayable transcript API; `agent/*` is the live coordination
API.

### 5d. `@deepseek-ai/dsh-llm`

| Event | Mode | Signature / notes |
| --- | --- | --- |
| `llm/stream` | **waterfall** | `(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>` — around every streaming model call (retry/replay/routing). Loop-built requests carry the `markAgentLoopRequest` identity and arrive **deep-frozen**; mutation throws. Read them, never rewrite. |
| `llm/adapters-updated` | emit | `() => void` — payload-free; re-read `listProviders()` / `listModels()` / `listConfigurableProviders()`. |

### 5e. LLM adapters

Adding a model provider is a **service call, not an event**: implement `LlmAdapter` and hand it to
`ctx.llm.registerAdapter(...)`.

```ts
export const inject = ['llm']                     // dsh-llm-deepseek declares exactly this

export function apply(ctx: Context) {
  ctx.llm.registerAdapter(['my-provider'], new MyAdapter(/* … */))
}
```

```ts
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle

interface AdapterRegistrationHandle {
  (): void                              // release every route this registration holds
  replace(providers: string[]): void    // atomic route swap, same adapter instance
}
```

- **It is a `ctx.effect()`** — internally `this.ctx.effect(function* () { … }, 'llm.registerAdapter()')`
  — so the routes are released when your fiber unloads. You do not have to hold the disposer.
- An **empty** initial `providers` array throws `LlmError` with code `INVALID_ADAPTER`; a route another
  adapter already owns throws `DUPLICATE_ADAPTER` and registers **none** of the set (all-or-nothing).
- `replace([])` **is** legal (a settings section that emptied holds zero routes while staying
  registered). Calling `replace` after the disposer ran throws `REGISTRATION_DISPOSED`.
- Every route change publishes `llm/adapters-updated` (§5d).

`abstract class LlmAdapter` has **one abstract method and five overridable ones**. The adapter-side
names differ from the `ctx.llm` facade's — do not confuse them:

| Member | Signature | One line |
| --- | --- | --- |
| `stream` | `abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>` | **The only required method** — streams one call, honoring `options.signal`. |
| `providerInfo` | `providerInfo(provider: string): LlmProviderInfo` | Display metadata for one owned route; the returned `id` must equal `provider`. Defaults to `{ id: provider, name: provider }`. |
| `listModels` | `listModels(provider: string): Promise<readonly LlmModelInfo[]>` | Advisory catalog, default `[]`; absence must never turn into request rejection. |
| `resolveModel` | `resolveModel(provider, model, signal?): Promise<LlmResolvedModelInfo>` | All metadata for one exact model — the facade surfaces this as `ctx.llm.resolveModelInfo(...)`. |
| `prepareCall` | `prepareCall(provider, model, signal?): Promise<PreparedAdapterCall>` | Binds model metadata and the eventual dispatch to **one adapter generation**; override only for dynamic adapters. |
| `providerRetryPolicy` | `providerRetryPolicy(provider): ResolvedRetryPolicy \| undefined` | Provider-owned retry policy; `undefined` = normal defaults. |

**Two non-negotiable rules for provider HTTP requests:**

1. **Every request must carry the call's `AbortSignal`.** `GenerateOptions.signal` is the caller's
   cancellation — pass it straight through: `fetch(url, { signal: options.signal, … })`, or the client
   library's equivalent option. The same holds for `resolveModel` / `prepareCall`, whose `signal`
   parameter asynchronous implementations must settle promptly after. An adapter that drops the
   signal turns every user cancel into a leaked in-flight request that keeps billing.
2. **Every request must include `attributionHeaders()`** (exported from `@deepseek-ai/dsh-llm`) —
   merged into the wire request's headers, or added in the client library's header hook.

Prior art to copy:

| I want to… | Read |
| --- | --- |
| A complete adapter **implementation** | `dsh-llm-deepseek` — `inject = ['llm']`, `DeepSeekAdapter extends LlmAdapter`, plus `registerConfigurableProviders` and a settings section for the user-supplied key (§6f) |
| A library-backed adapter | `dsh-llm-pi-ai` |
| **Interception** without owning a provider | `dsh-llm-retry` — an `llm/stream` waterfall (`inject = ['agents']`); the model for retry / replay / routing |

### 5f. Other harness events

| Event | Mode | Package / signature |
| --- | --- | --- |
| `system-prompt/assemble` | **waterfall** | dsh-system-prompt — `(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next) => Promise<PromptAssembly>` |
| `system-prompt/change` | emit | `() => void` |
| `approval/request` | **waterfall** | dsh-user-approval — `(req: ApprovalRequest, next) => Promise<ApprovalOutcome>`; absence fails closed to unavailable |
| `fs/write-intent` | **waterfall** | dsh-fs — `(target: FsTarget, actor: object \| undefined, next) => Promise<FsWriteIntent \| undefined>` |
| `fs/edit-intent` | **waterfall** | dsh-fs — same shape |
| `fs/observed` | emit | `(target: FsTarget, observation: FsObservation, actor) => void` |
| `subagent/provider-added` / `-removed` | emit | `(provider)` / `(name: string)` |
| `subagent/start` / `subagent/end` | emit | `(info: SubagentRunInfo)` / `(info: SubagentRunEndInfo)` |
| `skills/change` | emit | dsh-skill — note the **plural** `skills/`, unlike `tools/change`, `commands/change`, `system-prompt/change` |
| `commands/change` | emit | `() => void` |
| `settings/updated` | emit | `(ns, next: unknown, prev: unknown, source: SettingsUpdateSource) => void` |
| `settings/document-updated` | emit | `(ns: SettingsNamespace, revision: number) => void` |
| `credentials/reference-updated` / `record-updated` | emit | `(ref)` / `(key)` |
| `authorization/settled` | emit | `(key: CredentialKey, settlement: AuthorizationSettlement) => void` |
| `agent-preset/selected` | emit | `(sessionId: SessionId, agentPreset: string) => void` |
| `agent-loop/config-start-failed` | emit | dsh-agent-loop |
| `goal/changed` | emit | dsh-goal — `(this: Scoped<Agent>, payload)` |
| `domain/changed` | emit | dsh-storage-domain — `(change: DomainChanged) => void` |
| `session-telemetry/record` | **waterfall** | `(record: SessionTelemetryRecord, next) => SessionTelemetryRecord` |
| `workflow/start\|phase\|log\|agent-start\|agent-end\|end` | emit | dsh-workflow |
| `webserver/index-inject` | emit | `(table: IndexInjection[]) => void` |
| `hmr/change` | plain | `(url: string) => void` |
| `hmr/reload` | plain | `(reloads: Map<Plugin, Reload>) => void`, `Reload = { filename: string; runtime?: Plugin.Runtime }` |
| `hmr/config-update-failed` | **parallel** | `(filename: string, error: Error) => Promise<void> \| void` |
| six `cordis/*` events | emit | dsh-cordis-host-runner (dynamic-runner plumbing) |

**Choosing a seam:** prefer **events** for interception and policy; prefer **service methods** for
direct capability calls.

---

## 6. Service catalog (`ctx.*`)

`H` = mounted in the `headless` profile, `W` = mounted in `web`. **95 distinct `ctx.*` members**
exist across the installation; the ones below are the ones a plugin realistically touches.

### 6a. Cordis core — always present, no `inject` needed

| `ctx.*` | Purpose | Key API |
| --- | --- | --- |
| `logger` | Callable logging service. | `ctx.logger('my-plugin').info(...)`; `ctx.logger.info(...)`; `exporter(e)` |
| `events` | Event bus; mixes `on/once/parallel/emit/serial/bail/waterfall` onto `ctx`. | see §4 |
| `reflect` | Service store behind the `ctx` proxy; mixes `get/set/provide/accessor/mixin`. | see §2d |
| `registry` | Plugin registry; mixes `inject/plugin`. | `ctx.plugin(p, cfg)`, `ctx.inject(deps, cb)` |
| `fiber` | The owning fiber; mixes `runtime` and **`effect`**. | `ctx.effect(...)`, `fiber.getEffects()`, `fiber.dispose()` |
| `root`, `baseUrl?` | Root context / base URL for relative specifiers. | properties |
| `timer` (+`interval`,`timeout`,`throttle`,`debounce`) **H W** | Fiber-scoped disposable timers (cordis-plugin-timer). | `timeout(cb, ms): () => void`; `interval(cb, ms): () => void`; `interval(ms): AsyncIterableIterator<void>` |
| `hmr` | Hot-module reload. **Disabled in BOTH stock profiles** — the `hmr` row is `disabled: true` in the `dsh-web-app` *and* `dsh-headless` bundles, and the launcher re-creates `cordis-plugin-hmr` with `{ root: [] }` (no module roots watched). A rebuilt `dist/` is **not** hot-reloaded: restart. | property |

### 6b. Mounted in BOTH profiles — safe to inject

| `ctx.*` | Package | Purpose | Key methods |
| --- | --- | --- | --- |
| **`tools`** | dsh-tools | Tool registry + execution pipeline. The #1 extension point. | `register(def): () => void` · `get(name, scope?)` · `schemas(scope?)` · `execute(exec)` · `guard(g)` · `restrict(f)` · `presentAs(mode)` |
| **`llm`** | dsh-llm | Provider/adapter registry + streaming completions. | `stream(options): AsyncIterable<StreamChunk>` · `registerAdapter(providers, adapter)` · `listProviders()` · `listModels(p)` · `resolveModelInfo(p, m, signal?)` · `prepareCall(config, signal?)` |
| **`agents`** | dsh-agent | Live `Agent` registry + the "who initiated this" ambient. | `create(opts)` · `resume(opts)` · `get(id)` · `list()` · `roots()` · `currentInitiator()` · `requireInitiator()` · `withInitiator(agent, op)` |
| **`sessions`** | dsh-session | In-memory store of session event logs. | `create(id?, opts?)` · `prepare(id?, opts?)` · `get(id)` · `list()` · `fork(src, boundary?, childId?)` · `flush(session)` |
| **`systemPrompt`** | dsh-system-prompt | Compose the system prompt. Lowest-risk composition point after tools. | `section(s): () => void` · `context(c)` · `variable(name, provider)` · `tools(provider)` · `assemble(context?)` |
| **`commands`** | dsh-commands | Slash commands. | `register(def): () => void` · `list(agent)` · `find(agent, name)` · `execute(agent, line, images, signal)` |
| **`skills`** | dsh-skill | Skill catalog (markdown skill packs). | `register(skill)` · `registerProvider(create)` · `list(opts?)` · `get(name, opts?)` · `snapshot(opts?)` |
| **`settings`** | dsh-settings (impl `-file`) | Namespaced, schema-validated user settings. **abstract**. | `register<T>(ns, schema: z<T>, opts?): SettingsScope<T>` · `get(ns)` · `update(ns, patch, rev?)` · `describe(opts?)` |
| **`credentials`** | dsh-credentials (impl `-local`) | Secret storage. **abstract**. | `resolve(ref)` · `set(ref, value)` · `unset(ref)` · `describe(ref)` · `listRecords()` |
| **`fs`** | dsh-fs (impl `-sandbox` → `-local`) | Sandbox-aware filesystem. **The member is `fs`, never `filesystem`.** | `resolve(path, opts?)` · `readText(target, signal?)` · `writeText(...)` · `editText(...)` · `stat(...)` · `listDir(...)` · `readBytes(...)` · `get sandboxMode()` |
| **`shell`** | dsh-shell (impl `dsh-bash-sandbox` / `dsh-pwsh-sandbox`) | Shell execution. **abstract**. | `resolve(request)` · `run(spec)` · `start(spec): ShellProcess` |
| **`subprocess`** | dsh-subprocess (impl `-local`) | Raw process spawning below `shell`. **abstract**. | `spawn(spec)` · `spawnTerminal(spec)` · `resolveExecutable(cmd, env?, signal?)` |
| `shellEnv` | dsh-shell-env | Contribute env vars into shell/tool executions. | `register(contributor)` · `collect(execution)` · `list()` |
| **`sandbox`** | dsh-sandbox (impl `-local`) | Wraps an argv in OS confinement. Exactly **one** abstract method. | `confine(argv, policy): ConfinedArgv` |
| `sandboxPolicy` | dsh-sandbox-policy | Resolves the effective sandbox mode. | `resolve(request?)` · `overrideOf(session)` · `defaultMode` · `workspaceRoot` |
| **`approval`** | dsh-user-approval | User permission prompts. **Singular `approval`, not `approvals`.** | `request(req): Promise<ApprovalOutcome>` · `setPolicy(agent, policy)` · `overrideOf(session)` |
| `permissionPresets` | dsh-permission-presets | Named sandbox+approval bundles. | `set(session, name)` · `resolve(name)` · `current(events)` · `names` |
| `userQuestions` | dsh-user-questions | Ask the user a structured question mid-run. | `ask(request)` · `registerProvider(p)` |
| **`web`** | dsh-web | Web search + fetch abstraction. | `search(request, signal?)` · `fetch(request, signal?)` · `registerSearchProvider(p)` · `registerFetchProvider(p)` |
| **`jobs`** | dsh-jobs (impl `-local`) | Background job registry. **abstract**. | `start(spec)` · `list(caller?)` · `read(id, caller?)` · `kill(id, ...)` · `wait(id, timeoutMs, ...)` · `onJobDone(l)` |
| **`subagents`** | dsh-subagent | Spawn/fork child agents; route follow-ups and reports. | `start(name, request)` · `startContinuable(spec)` · `followup(parent, childId, content, opts)` · `reportFrom(child, content, opts)` · `listChildren(id, signal?)` · `registerProvider(p)` |
| **`agentLoop`** | dsh-agent-loop | The turn loop / `AgentFactory`. **Bundle** — extension plugins depend on `dsh-agent`, never on this. | `create(id, opts?, meta?)` · `createAgent(ownerCtx, opts)` · `resume(ownerCtx, opts)` |
| **`sessionPersistence`** | dsh-session-persistence (impl `-jsonl`) | Durable append-only session log. **abstract**. | `append(id, events)` · `load(id)` · `inspect(id, signal?)` · `readFrom(id, fromSeq, signal?)` · `list(signal?)` · `create(meta)` |
| `goals` | dsh-goal | Long-running goal tracking per agent. | `create(agent, req)` · `get(agent)` · `edit/pause/resume/complete` · `block(...)` · `clear(...)` |
| `planMode` | dsh-plan-mode | Read-only "plan first" toggle per agent. | `get(agent)` · `set(agent, active)` |
| `attachments` | dsh-attachment (impl `-local`) | Immutable image/binary attachments. **abstract**. | `saveImage(input)` · `saveImages(inputs)` · `readImage(ref, signal?)` · `validateImage(input)` · `imageLimits` |
| `compaction` | dsh-compaction (impl `-basic`) | Context-window compaction. **abstract**. | `compactIfNeeded(agent, trigger, signal)` · `compactNow(...)` · `compactRegion(...)` |
| `tokenMeter` | dsh-token-meter | Token accounting over a session. | `measure(session, header?)` · `estimateMessage(message)` |
| `spillStore` | dsh-spill (impl `-local`) | Offload huge text to disk, return a ref. **abstract**. | `saveText(input): Promise<SpillRef>` |
| `codeRuntime` | dsh-code-runtime (impl `-worker-thread`) | Sandboxed code execution for Code Mode. **abstract**. | `run(request)` · `language` · `isolation` |
| `workflowEngine` | dsh-workflow (impl `-worker-thread`) | Declarative multi-step workflow runs. **abstract**. | `start(request): WorkflowRun` |
| `sessionTitle` | dsh-session-title | Session titles. | `get(session)` · `rename(session, title)` · `refresh(session, signal?)` · `register(provider)` |
| `sessionProjections` | dsh-session-projection | Reducers folding session events into typed state. | `register(def)` · `stateOf(session, key)` · `snapshot(session)` · `checkpoint(session)` · `onChanged(l)` |
| `sessionQuery` | dsh-session-query (impl `-sqlite`) | Search/read historical sessions. **abstract**. | `searchSessions(req, exec?)` · `searchEvents(req, exec?)` · `listSessions(signal?)` · `readSession(id)` · `traceSession(id, signal?)` |
| `sessionTelemetry` | dsh-session-telemetry (impl `-otel`) | Telemetry sink. **abstract**. | `emit(record)` · `flush?()` · `shutdown()` |
| `agentDefaultModel` | dsh-agent-default-model | Default provider/model for new agents. | `currentSelection()` · `saveSelection(next)` |

### 6c. Web-profile ONLY (absent in `headless`)

Injecting any of these makes a plugin silently never load under `--profile headless`. Treat them as
optional via `ctx.get(...)`.

| `ctx.*` | Package | Purpose | Key methods |
| --- | --- | --- | --- |
| **`webServer`** | dsh-host-webserver | The HTTP server. **The member is `webServer` — there is no `ctx.http` or `ctx.server`.** | `register(route): () => void` · `registerUpgrade(route)` · `registerFallback(handler)` · `tapIndex(transform): () => void` · `get port()` · `get host()` |
| **`workspaceRegistry`** | dsh-workspace | Workspaces = named project roots with archived sessions. | `create(path, title?)` · `get(id)` · `list()` · `delete(id)` · `resolveByPath(path)` · `archiveSession(id)` |
| **`storage`** | dsh-storage | Pluggable storage forms/backends. | `mount<K>(form, facility): () => void` · `form<K>(form)` · `get domain` |
| `storageDomain` | dsh-storage-domain | Typed key/value domains over `storage`. | `open<S>(spec)` · `get(name)` · `closeAll()` |
| `agentPresets` | dsh-agent-presets | User-authorable agent presets. | `list()` · `resolve(id?)` · `mount(agentCtx, id?)` · `read(id)` · `copy(...)` · `remove(id)` |
| `fileReferences` | dsh-file-reference (impl `-local`) | `@file` mention candidates. **abstract**. | `list(agent, query, signal)` |
| `sessionReferenceResolver` | dsh-session-reference | `@session` mentions. | `listCandidates(...)` · `prepare(agent, content, refs, signal?)` |
| `messageFeedback` | dsh-message-feedback | Thumbs up/down per message. | `list(req)` · `put(req)` · `delete(req)` |
| `directoryPicker` | dsh-host-directory-picker (impl `-auto`) | Directory picking. **abstract**. | `capability()` |
| `sessionProjectionCache` | dsh-session-projection-cache | Warm-start cache for projections. | `cachedSnapshot(meta)` · `write(session)` · `coldSnapshot(id, signal?)` |

### 6d. Do not inject

- **Not mounted by either stock profile:** `terminals` (dsh-terminal), `authorization`
  (dsh-authorization), `invariants` (dsh-invariants). Injecting them = the plugin never loads unless
  you also patch in the provider.
- **Internal RPC/transport plumbing:** `typert`, `typertGateway`, `apiProxy`, `connection`, `remote`,
  `clientModules`, `modules`, `cordisInspect`, `dynamicCordisRunner`.
- **Browser-bundle-only** (`dsh-client-ui-*`): `conversation`, `layout`, `slots`, `theme`, `locale`,
  `uiRenderer`, `commandUi`, `settingsSchema`, … — these are not on the host context.
- **Optional `Context` fields, not services** (illegal in `inject`): `agent?`, `dshHomePath?`,
  `cmdlineArgs?`, `appExit?`, `launchEnvironment?`, `baseUrl?`, `configuredAgentIdentities?`.
- **Infrastructure below the agent layer** — read at most; *replacing* one means subclassing the
  abstract base and mounting your class as the provider, not calling into it:
  `sessionPersistence`, `sandbox`, `compaction`, `toolResultPruner`, `sessionTelemetry`.

### 6e. Architectural classification

- **Core spine services** (exactly one owner): `ctx.tools`, `ctx.sessions`, `ctx.agents`,
  `ctx.systemPrompt`, `ctx.commands`, `ctx.planMode`, `ctx.shellEnv`, `ctx.sandboxPolicy`,
  `ctx.goals`, `ctx.tokenMeter`, `ctx.invariants`.
- **Swappable capability seams** (accept alternative implementation packages): `ctx.llm`, `ctx.fs`,
  `ctx.shell`, `ctx.subprocess`, `ctx.approval`, `ctx.sandbox`, `ctx.skills`, `ctx.web`,
  `ctx.subagents`, `ctx.jobs`, `ctx.settings`, `ctx.credentials`, `ctx.sessionPersistence`,
  `ctx.storage`, `ctx.terminals`, `ctx.compaction`, `ctx.codeRuntime`, `ctx.attachments`,
  `ctx.spillStore`, `ctx.sessionQuery`, `ctx.sessionTitle`, `ctx.userQuestions`,
  `ctx.workflowEngine`, `ctx.fileReferences`, `ctx.directoryPicker`, `ctx.sessionTelemetry`,
  `ctx.authorization`.
- **Bundle:** `ctx.agentLoop` is the single one. Extension plugins must depend on `dsh-agent` events
  and services, **never** on `dsh-agent-loop`.

### 6f. User-facing surfaces

Three ways an out-of-tree plugin can reach a human — and the one boundary it cannot cross.

#### (a) Settings — `ctx.settings`

```ts
register<T>(ns: SettingsNamespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T>

interface SettingsRegisterOptions<T> {
  base?: Partial<T>                 // composition layer, resolved BELOW the user layer
  applies?: 'live' | 'restart'      // owner's effect timing, surfaced to config UIs; defaults to 'live'
  validate?: (value: T) => void     // cross-field check the schema cannot express; THROW to refuse the write
}
```

Resolution order is **schema defaults → `base` → user document section**.

```ts
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'

const NS = settingsNamespace('my-plugin')          // lowercase kebab-case, like a plugin short name

export function apply(ctx: Context) {
  ctx.inject(['settings'], (sctx) => {             // optional dependency — see §1d
    const scope = sctx.settings.register(NS, Schema.object({
      enabled: Schema.boolean().default(true),
    }), { applies: 'restart' })

    scope.get()                                    // resolved value
    scope.watch((next, prev) => { /* committed changes, one at a time, in commit order */ })
  })
}
```

- ⚠ **`z` here is NOT zod.** `dsh-settings` declares `import type z from '@deepseek-ai/schemastery'`
  — the alias reads like zod, the library is **schemastery**. Zod's API against it does not compile:
  there is no `z.infer`, no `.parse`, no `.optional()` in that shape. Write
  `Schema.object / string / number / boolean / array` from `@deepseek-ai/schemastery`, exactly as
  plugin `Config` schemas do.
- `register` is an **effect on the calling fiber**: the namespace and its observers vanish on unload.
- Duplicate `ns` **fails loud**. A stored section that fails the schema — or `validate` — at
  registration time **rejects the registration itself**; afterwards, a bad section keeps the
  namespace's last good value and warns.
- Prefer **`applies: 'restart'`** for anything you read **once** in `apply()`. That flag is what the
  configuration UI tells the user; claiming `'live'` while never re-deriving state is a lie to them.
  Use `'live'` only when you actually re-derive inside `scope.watch(...)`.
- Related events: `settings/updated`, `settings/document-updated` (§5f).

#### (b) HTTP — `ctx.webServer` (dsh-host-webserver)

```ts
register(route: { kind: 'exact' | 'prefix'; path: string; handler(req, res): void | Promise<void> }): () => void
registerUpgrade(route: { path: string; handler(req, socket, head): void | Promise<void> }): () => void
tapIndex(transform: (html: string) => string): () => void
```

`path` is an absolute pathname with **no trailing slash**; a duplicate `(kind, path)` throws, because
route patterns are a composition-level contract. `'prefix'` path `p` matches `p` and `p/<anything>`,
longest prefix wins after an exact-table miss. `tapIndex` transforms run in registration order
**after** the structured `webserver/index-inject` rows are rendered (§5f).

These disposers are **plain returns, not fiber-owned** — wrap them in `ctx.effect()`.

`webServer` is **web-profile only** (§6c), so a plugin that must also load under `--profile headless`
reaches it through `ctx.get('webServer')` / `ctx.inject([...], cb)`, never a top-level `inject`:

```ts
export function apply(ctx: Context) {
  ctx.inject(['webServer'], (wctx) => {            // this sub-plugin simply never loads in headless
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/my-plugin/status',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      },
    }))
  })
}
```

`dsh-host-frontend-static` (`inject = ['webServer']`, `registerFallback` + `renderIndex` inside
`ctx.effect`) is the worked example.

#### (c) The boundary — an out-of-tree plugin cannot ship UI

The `dsh-client-ui-*` services (`conversation`, `layout`, `slots`, `theme`, `uiRenderer`,
`commandUi`, `settingsSchema`, …) live in the **browser bundle**, on a different context in a
different process. They are unreachable from an out-of-tree **host** plugin: no `inject` and no
`ctx.get` will ever find them (§6d). The available answers are exactly three:

| You want | Do this |
| --- | --- |
| User-editable configuration | Register a **settings namespace** (a) — the settings UI renders your schema for you |
| Data, or an endpoint something else calls | A **`webServer` route** (b) |
| Markup in the served `index.html` | **`tapIndex`** (b), or a `webserver/index-inject` row |

---

## 7. Prior art — which installed package to read

Read under `/Users/charlesqin/.dsh/profiles/node_modules/@deepseek-ai/`. **Use `find -L`** — every
entry there is a symlink into `~/.npm/_npx/<hash>/node_modules/@deepseek-ai/`, so a plain `find`
returns zero results.

| I want to… | Read |
| --- | --- |
| Register a tool (simplest complete plugin) | `dsh-tool-todo` |
| Register a tool that uses another service | `dsh-tool-web` (injects `ctx.web`) |
| Build rich tool presentation views | `dsh-tool-fs`, `dsh-tool-fs-search` |
| Wrap tool dispatch (timeout/retry/metrics) | `dsh-tool-call-timeout-policy` (a `tools/execute` waterfall) |
| Gate tool execution by policy | `dsh-user-approval` (`tools/pre-execute` + `approval/request`) |
| Write an LLM provider adapter | `dsh-llm-deepseek`; retry semantics in `dsh-llm-retry` |
| Wrap model streaming | `dsh-llm-retry` (`llm/stream` waterfall) |
| Provide a service by subclassing an abstract base | `dsh-fs-local` / `dsh-fs-sandbox`; `dsh-jobs-local` (`LocalJobRegistry extends JobRegistry`) |
| Contribute system-prompt content | `dsh-agent-instructions`, `dsh-persona` (`ctx.systemPrompt.section`) |
| Observe the durable transcript | `dsh-session-projection`, `dsh-session-stats` (`session/event`) |
| Intercept the agent loop | `dsh-compaction-basic` (`agent/pre-step` + `agent/request-error`) |
| Add a slash command | `dsh-command-compact`, `dsh-command-goal` |
| Register user-editable settings | any plugin calling `ctx.settings.register(ns, schema)` |
| Serve HTTP routes (web profile) | `dsh-host-frontend-static`, `dsh-host-apiproxy` (`ctx.webServer.register`) |
| A complete, verified end-to-end plugin | `/Users/charlesqin/orca/projects/DSH-Project/dsh-pi-review` |
| The authoritative cordis semantics | `@deepseek-ai/cordis/src/{context,service,events,fiber,registry,reflect,logger}.ts` — the full TS sources ship in the package |
