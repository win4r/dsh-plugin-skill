# Tools reference (`@deepseek-ai/dsh-tools` 0.1.1-rc.2)

The complete author-facing surface: the schema DSL, `defineTool`, `ToolRunContext`, content blocks,
type inference, a full worked example, and how to unit-test without booting the harness.

Everything below is re-exported from the package root `@deepseek-ai/dsh-tools` **except** the
`ContentBlock` / `CallId` types (they come from `@deepseek-ai/dsh-llm`) and the `JsonValue` runtime
helpers (they come from `@deepseek-ai/dsh-session`; dsh-tools re-exports only the `JsonValue` *type*).
Registration requires `export const inject = ['tools']`.

---

## 1. `ValueSchemaSpec` — the schema DSL

### 1a. Shared annotations (legal on **every** node)

```ts
interface ValueSchemaAnnotations {
  description?: string
  title?: string
  default?: JsonValue     // lossless JSON
  examples?: JsonValue    // lossless JSON
}
```

### 1b. The nine variants

```ts
interface StringValueSchemaSpec  { type: 'string';  enum?: readonly string[];  const?: string }
interface NumberValueSchemaSpec  { type: 'number';  enum?: readonly number[];  const?: number }
interface IntegerValueSchemaSpec { type: 'integer'; enum?: readonly number[];  const?: number }
interface BooleanValueSchemaSpec { type: 'boolean'; enum?: readonly boolean[]; const?: boolean }
interface NullValueSchemaSpec    { type: 'null';    enum?: readonly null[];    const?: null }
interface ArrayValueSchemaSpec   { type: 'array';   items?: ValueSchemaSpec }
interface ObjectValueSchemaSpec  { type: 'object';  properties?: ParameterSchemaSpec
                                   additionalProperties: boolean }        // MANDATORY
interface JsonValueSchemaSpec    { type: 'json' }                          // author-only: any JsonValue
interface OneOfValueSchemaSpec   { oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]] }
```

| Variant | Mandatory | Optional | Infers as |
| --- | --- | --- | --- |
| `string` | `type` | `enum`, `const`, annotations | `string` / literal union / literal |
| `number` | `type` | `enum`, `const`, annotations | `number` / … |
| `integer` | `type` | `enum`, `const`, annotations | `number` / … |
| `boolean` | `type` | `enum`, `const`, annotations | `boolean` / … |
| `null` | `type` | annotations | `null` |
| `array` | `type: 'array'` | `items` (omit ⇒ any JSON item) | `T[]` / `JsonValue[]` |
| `object` | `type: 'object'` **and** `additionalProperties: boolean` | `properties` | see §5 |
| `json` | `type: 'json'` | annotations only | `JsonValue` |
| `oneOf` | `oneOf` with **≥ 2** branches | annotations; `type` **forbidden** alongside | union of branches |

### 1c. Examples of each node

```ts
// scalars
{ type: 'string', description: 'Repo-relative path.' }
{ type: 'string', enum: ['fast', 'thorough'], description: 'Defaults to "fast".' }
{ type: 'string', const: 'v1' }
{ type: 'integer', default: 100, description: 'Max rows.' }
{ type: 'boolean' }
{ type: 'null' }

// array
{ type: 'array', items: { type: 'string' } }
{ type: 'array' }                                  // items unconstrained -> JsonValue[]

// object — additionalProperties is REQUIRED
{ type: 'object', additionalProperties: false, properties: {
    path: { type: 'string', required: true },
    line: { type: 'integer' },
} }
{ type: 'object', additionalProperties: true }     // -> Record<string, JsonValue>

// json — arbitrary lossless JSON, author-only (never for model input you must validate)
{ type: 'json', description: 'Opaque stats blob.' }

// oneOf — at least two branches, no sibling `type`
{ oneOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: false, properties: { url: { type: 'string', required: true } } },
] }
```

### 1d. Requiredness and the `parameters` root

```ts
type ParameterPropertySpec = ValueSchemaSpec & { required?: true }
type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec; [key: symbol]: never }
```

- `parameters` is an **implicit open object root**. Write the property map directly. Never write
  `parameters: { type: 'object', properties: {...} }`.
- Requiredness is the per-property annotation `required: true`. There is **no JSON-Schema
  `required: [...]` array** in the DSL — `parameterSchemaSpecToJsonSchema` builds it for you and
  deliberately emits **no** root `additionalProperties` (the root stays open).
- `required` is **positionally restricted**: the compiler sets `allowRequired` only while descending
  into a *property map*, so `required` is legal only on a direct key of `parameters` or of an object
  node's `properties` — including the `properties` of an object nested under `items` or under
  `output.schema`. It is an author error on `items` itself, on a `oneOf` branch, and at any schema
  root (including `output.schema`), where it is rejected as an unknown key:
  `` `${path}.required is not supported by the value schema DSL` ``. Any value other than literal
  `true` errors: `` `${path}.required must be true when present` ``.

```ts
parameters: {
  path:  { type: 'string', required: true },
  limit: { type: 'integer' },                       // optional -> `limit?: number`
}
```

### 1e. Hard errors thrown when a spec is malformed

`defineTool` compiles the spec eagerly, so these fire at plugin load (and in the stub-context
load-check):

- `` `${path}.additionalProperties must be explicitly true or false` ``
- `` `${path}.oneOf must be an array of at least two value schemas` ``
- `` `${path} cannot declare both type and oneOf` ``
- `` `${path}.enum must be a non-empty array of scalar values` ``
- `` `${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf` ``
- `` `${path} must be a value schema object` `` / `` `${path} is circular` ``
- unknown author keys hard-error via `assertAuthorKeys`, per variant, as
  `` `${path}.${key} is not supported by the value schema DSL` ``. **The enforced JSON Schema
  subset has NO validation keywords beyond `enum` and `const`** — a stray `minLength`, `pattern`,
  `format`, `minimum`, or `minItems` is a hard error, not an ignored hint. Enforce those in
  `execute` and return a domain error.

All of the above are thrown as a `JsonSchemaError` (its `violations` carries the single message).

### 1f. Compilation helpers (exported)

```ts
function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): JsonSchemaNode
function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema
function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[]     // [] === valid
function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path?: string): string[]
function assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode
function assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema
class ToolArgsError extends HarnessError { readonly violations: string[] }    // code 'INVALID_ARGS'
class JsonSchemaError extends HarnessError { readonly violations: string[] }
```

`validateArgs(spec, args)` compiles the spec and calls `validateJsonSchemaValue(..., args, '')` — so
its violation paths are rooted at `''`, and it takes the **author** spec, not `tool.parameters`.

`{type:'json'}` compiles to an **annotation-only** node (no `type` keyword) — "any JSON value".

`JsonValue` (from `@deepseek-ai/dsh-session`, re-exported by dsh-tools):

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
```

Lossless means finite numbers, no `-0`, no sparse/cyclic/exotic values. The two runtime helpers live
in `@deepseek-ai/dsh-session` and are **not** re-exported by dsh-tools — import them from
`@deepseek-ai/dsh-session` directly:

```ts
function snapshotJsonValue<T>(value: T): T | undefined   // undefined == not lossless JSON
function isJsonValue(value: unknown): boolean
```

---

## 2. `DefineToolOptions` — every field, exact signatures

```ts
interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly output: {
    readonly schema: O
    render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue
  }
  readonly timeoutMs?: number
  isConcurrencySafe?(args: InferArgs<S>): boolean
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
}

declare function defineTool<
  const S extends ParameterSchemaSpec,
  const O extends ValueSchemaSpec
>(options: DefineToolOptions<S, O>): ToolDefinition
```

| Field | Purity / timing | Notes |
| --- | --- | --- |
| `name` | — | Unique. `register` fails on a duplicate in the same layer and on the reserved `run_code` (`RUN_CODE_NAME`). |
| `description` | — | Model-visible. This is the tool's whole affordance — say *when* to call it. |
| `parameters` | — | Implicit open object root (§1d). Model-visible. |
| `output.schema` | — | Required. The **registry** validates every successful body value and any post-policy replacement against it → `ToolOutputError`. `defineTool` itself does not validate output. |
| `output.render` | **pure, sync** | Returns `ContentBlock[]`. **This is the only thing the model sees.** The canonical `value` is execution-local and omitted from durable events. |
| `output.presentationMeta` | pure, sync | Computed **only for direct top-level calls** (not nested under a `run_code` transport). Persisted in the session log and handed back to `presentResult` as `result.meta`. The only way structured views survive replay. |
| `timeoutMs` | — | Positive finite ms or `defineTool` throws `defineTool(<name>): timeoutMs must be a positive finite number`. Enforced **cooperatively** by `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper). **Never sent to the model** — `schemas()` whitelists only name/description/parameters. Declaring it asserts you forward `exec.signal`. |
| `isConcurrencySafe` | **pure, sync** | Only a literal `true` opts in. Omission, exceptions, non-`true` returns, and invalid args are all treated as exclusive. Never model-visible. Opted-in bodies must not mutate parent-owned state. |
| `execute` | async | `defineTool` validates args first and rejects with `ToolArgsError`. Must observe/forward `exec.signal` and settle only when its own work is quiescent — the registry never abandons the promise and cannot hard-kill in-process code. |
| `finalizeContent` | **sync, must be TOTAL, must not throw** | Snapshotted when execution starts; invoked exactly once for **every** normalized outcome, including pipeline failures that bypass `tools/post-execute`, immediately before lossless materialization. `exec.arguments` stays `unknown` because invalid-input failures reach it too. Return `undefined` to preserve content; all other result fields stay registry-owned. |
| `presentCall` / `presentResult` | **pure, replay-safe** | Wrapped with **soft** validation: args that no longer validate yield `undefined` (generic card) rather than throwing, because presenters run on session-log replay of possibly-obsolete args. |

### 2a. Registration API — `ctx.tools` (`ToolRuntime`)

```ts
register(definition: ToolDefinition): () => void      // returns the exact disposer
restrict(filter: ToolRestriction): () => void         // { allow?: readonly string[]; deny?: readonly string[] }
guard(guard: ToolGuard): () => void                   // (execution: Readonly<ToolExecution>) => string | undefined
get(name: string, scope?: ScopeKey): ToolDefinition | undefined
schemas(scope?: ScopeKey): ToolSchema[]
execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
presentAs(mode: ToolPresentationMode): () => void
```

`register` is a `ctx` effect — no manual disposal needed. Scoped tools shadow globals. A `ToolGuard`
returning a string **denies**; no guard can force-allow.

The tools plugin's own config: `{ mode?: 'native' | 'code' | 'both'; maxParallelSubCalls?: number }`
(default 10, positive integer; `1` restores serial sub-dispatch).

---

## 3. `ToolRunContext` — fields and cancellation

```ts
type ToolExecutionToken = symbol & { readonly [brand]: true }

interface ToolExecutionInput {
  readonly callId: CallId
  readonly rootCallId?: CallId
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  readonly parent?: ToolExecutionToken
  readonly signal: AbortSignal            // REQUIRED, not optional
}
interface ToolExecution extends ToolExecutionInput {
  readonly rootCallId: CallId             // always resolved here
  readonly token: ToolExecutionToken
}
interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  signal: AbortSignal                     // mutable ONLY inside a tools/execute wrapper
}
interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void
  concludeTurn(): void
}
```

| Member | Use |
| --- | --- |
| `callId` | This invocation's id (branded `CallId` from dsh-llm). Correlates with the `tool-result` block. |
| `rootCallId` | The root model-requested call owning this execution tree. Nested dispatchers propagate it. |
| `name` | The tool name being dispatched. |
| `arguments` | Losslessly JSON-materialized and **deep-frozen** parsed arguments, typed `unknown`. `defineTool` already validated them into the typed `args` parameter — use `args`, not this. |
| `agent` | The `Agent` on whose behalf the call runs. Also the scope routing key for scope-filtered events. |
| `parent` | Opaque token of the enclosing transport execution. It also **marks** a call as a transport sub-dispatch: under `mode: 'code'`, only calls *with* a parent may execute a native tool name — a model-direct call with no parent is denied `UNKNOWN_TOOL` before the policy pipeline. |
| `signal` | Required caller-owned `AbortSignal`. Forward it into every async operation. The registry re-fuses the original caller signal before the body, so a `tools/execute` wrapper cannot detach cancellation. |
| `token` | Registry-assigned identity, shared with nested calls only as their opaque `parent`. |
| `deferContext(msg)` | Attach a `UserMessage` to **this execution's own result**. The loop appends it only *after* the `tool/result`; contexts keep their own source/metadata and emit in call order. Build with `createUserMessage` from dsh-llm. |
| `concludeTurn()` | Mark a **successful** final result terminal for the current agent turn (rides `ToolExecutionSuccess.concludesTurn?: true`). A composite forwards it from a nested result. |

### 3a. Cancellation patterns

```ts
async execute(args, exec) {
  // 1. Bail immediately if already cancelled.
  exec.signal.throwIfAborted()

  // 2. Pass the signal to anything that accepts one.
  const res = await fetch(args.url, { signal: exec.signal })

  // 3. Child processes: kill on abort, and unhook the listener when done.
  const child = spawn(cmd, argv, { signal: exec.signal })   // node >=16 honours `signal`

  // 4. Anything else: race an abort promise.
  await Promise.race([work(), abortPromise(exec.signal)])

  // 5. Re-check across long loops.
  for (const item of items) {
    exec.signal.throwIfAborted()
    await handle(item)
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
```

Cancellation is **cooperative**. The registry never abandons your promise, so a body that ignores
`exec.signal` keeps the turn blocked even after the user hits stop and even after `timeoutMs`.

Canonical error codes: `TOOL_ABORTED = 'ABORTED'` (cancelled after the body was invoked),
`TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'`, `ToolNotFoundError` (`'UNKNOWN_TOOL'`),
`ToolOutputError`, `ToolArgsError` (`'INVALID_ARGS'`), `JsonSchemaError`.

### 3b. Results the pipeline builds

```ts
interface ToolResult { content: ContentBlock[]; isError: boolean; meta?: JsonValue }   // -> presentResult

interface ToolExecutionSuccess {
  readonly isError: false
  readonly value: JsonValue            // execution-local; omitted from durable events
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: true
}
interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure           // { message: string; info?: { name: string; code: string } }
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}
type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
```

Pipeline order: `tools/pre-execute` waterfall → monotonic guards → `tools/execute` waterfall →
`tools/post-execute` waterfall → registry lossless snapshot → definition-owned `finalizeContent`
(sync, content-only) → `tools/result` observation. `ctx.approval` resolves `'ask'` decisions
**before** monotonic guards. Event signatures: `references/services-and-events.md` §5.

---

## 4. `ContentBlock` — what `render()` returns

From `@deepseek-ai/dsh-llm`. Merge-extensible via `ContentBlockMap`, so **switch on `type` and fall
through unknowns**.

```ts
interface TextBlock       { type: 'text';        text: string }
interface ReasoningBlock  { type: 'reasoning';   text: string }
interface ImageBlock      { type: 'image';       attachment: ImageAttachmentRef }  // @deepseek-ai/dsh-attachment
interface ToolCallBlock   { type: 'tool-call';   id: CallId; name: string; arguments: string /* raw JSON */ }
interface ToolResultBlock { type: 'tool-result'; toolCallId: CallId; content: ContentBlock[]; isError?: boolean }
```

In practice a tool's `render` returns `[{ type: 'text', text: ... }]`. `tool-call` / `tool-result`
are produced by the loop, not by a tool body. `image` is role-neutral, but current production
adapters declare text-only tool output, so only user content carries images today.

### 4a. Presentation views (`presentCall` / `presentResult`)

Both unions are tagged by `card`; the two multi-variant cards add a second discriminant (`shape` for
`search`, `kind` for `web`). Every named interface below is re-exported from the dsh-tools root as a
type. `ContentBlock` is **not** — import it from `@deepseek-ai/dsh-llm`.

```ts
type ToolCallKind = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'fetch'|'other'
interface FileLocation { path: string; line?: number }
interface FileDiff { path: string; oldText: string | null; newText: string }
interface ReadFileLine { number: number; text: string }
interface WebSource { url: string; title?: string; snippet?: string; publishedAt?: string }
interface SearchLineMatch { lineNumber: number; line: string }
interface SearchFileMatches { path: string; matches: SearchLineMatch[] }

type ToolCallView =
  | { card: 'generic';  title: string; kind?: ToolCallKind; rawInput?: unknown; content?: ContentBlock[]; locations?: FileLocation[] }
  | { card: 'terminal'; title: string /* the command */; description?: string; cwd?: string }
  | { card: 'diff';     title: string; diffs: FileDiff[]; locations?: FileLocation[] }

type ToolResultView =
  | { card: 'generic';  title?: string; content?: ContentBlock[] }
  | { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }   // exitCode XOR signal
  | { card: 'diff';     title?: string; diffs: FileDiff[] }
  | { card: 'search'; shape: 'matches'; title?: string; files: SearchFileMatches[]; truncated: boolean; total: number }
  | { card: 'search'; shape: 'paths';   title?: string; paths: string[]; truncated: boolean; total: number }
  | { card: 'read'; title?: string; path: string; offset: number; lines: ReadFileLine[]; totalLines: number; lang?: string; content?: ContentBlock[] }
  | { card: 'web'; kind: 'search'; title?: string; sources: WebSource[]; answer?: string; truncated: boolean }
  | { card: 'web'; kind: 'fetch';  title?: string; url: string; statusCode: number; truncated: boolean }
```

Field notes that actually bite:

- **`content` is `ContentBlock[]`, never a bare string** — on `GenericCallView`, `GenericResultView`,
  and `ReadResultView` alike. Write `content: [{ type: 'text', text: … }]`; a plain string does not
  compile. On a call view it is extra blocks shown next to the title; on a result view it is the
  UI-facing reformat of the model-facing result — omit it to let the UI render the raw result
  content. On `ReadResultView` it is specifically the model-facing text with its envelope stripped,
  the fallback for a UI that has no read card.
- **`rawInput` is `unknown`, not `string`** — the one *salient* input to show in a detail/expanded
  view (e.g. a background job id), not the full args object. A **string renders as-is; an object
  renders as pretty JSON**. Omit it to show nothing.
- `title` is **required** on every *call* view and **optional** on every *result* view, where it means
  "replace the pending title"; omit it to keep the title `presentCall` set.
- `TerminalResultView.exitCode` and `.signal` are mutually exclusive — a code when the process exited,
  a signal name when it was killed, neither when unknown.
- `TerminalCallView.cwd`: an absolute path is used as-is, a relative one is resolved by the UI bridge
  against the session workspace; omit it to let the bridge use the workspace.
- `FileDiff.oldText` is `null` for a create **and** for an overwrite — a call-time presenter has no
  access to prior content.
- `WebResultView.kind` is that union's own discriminant, **not** a `ToolCallKind`: only `'search'` and
  `'fetch'` are legal there.
- There is no call-time search/read card. A discovery or read call stays a `GenericCallView`
  (`kind: 'search'` / `'read'`) because the pending state has no matches, paths, or lines yet.

Presenters run on both live streaming and session-log replay. Structured fields the model-facing text
cannot losslessly carry (read lines, search matches, web sources) must go through
`output.presentationMeta` and be narrowed back in `presentResult`.

---

## 5. Type inference rules and their consequences

```ts
type InferValue<S> = InferValueAt<S, []>
type InferArgs<S>  = InferProperties<S, []>
```

1. **`const` beats `enum` beats the base primitive.** `{type:'string', const:'x'}` ⇒ `'x'`;
   `{type:'string', enum:[…]}` ⇒ the union; otherwise `string`.
2. **`required: true` ⇒ required key; anything else ⇒ optional key (`?`).** Required keys carry no
   `| undefined`.
3. **`{type:'json'}` ⇒ `JsonValue`.** `{type:'null'}` ⇒ `null`. `oneOf` ⇒ a plain union (not a
   discriminated-narrowing helper). `{type:'array'}` with no `items` ⇒ `JsonValue[]`.
4. **Open objects widen:**
   - `{additionalProperties: true, properties: {...}}` ⇒ `InferProperties<…> & Record<string, JsonValue>`
   - `{additionalProperties: true}` alone ⇒ `Record<string, JsonValue>`
   - `{additionalProperties: false}` alone ⇒ `Record<string, never>`
5. **`NoInfer<O>`** on `render` / `presentationMeta` / `execute` pins the output type to
   `output.schema` alone — a body returning a wider value is an error instead of silently widening `O`.

### 5a. `as const` on enums — the precise rule

`defineTool` declares `<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>`, so an
array literal written **inline** in the call already infers as a readonly literal tuple. `as const`
is required **only** for a tuple hoisted to a separate `const` binding.

```ts
// inline: no `as const` needed
parameters: { mode: { type: 'string', enum: ['fast', 'thorough'] } }   // args.mode: 'fast' | 'thorough' | undefined

const LOOSE = ['a', 'b']              // string[]              -> args.p : string          ✗
const TIGHT = ['a', 'b'] as const     // readonly ['a','b']    -> args.p : 'a' | 'b'       ✓
```

Verified against the real compiler: only the `LOOSE` case errors
(`TS2322: Type 'string' is not assignable to type '"a" | "b"'`).

### 5b. `interface` vs `type` alias for `{type:'json'}` nodes

A value typed by a TS **`interface`** is not assignable to `JsonValue` — interfaces have no implicit
index signature. Real compiler output:

```
Type 'Bad' is not assignable to type '{ [key: string]: JsonValue; }'.
  Index signature for type 'string' is missing in type 'Bad'.
```

**Use a `type` alias** for any object returned through a `{type:'json'}` node or assigned to `meta`.
Also: a `{type:'json'}` node rejects `undefined` — an absent value must be `null`, so DTOs behind a
json node should have **no optional members**.

```ts
type Stats = { filesReviewed: number; model: string | null; durationMs: number }   // ✓
interface Stats2 { filesReviewed: number }                                         // ✗ not JsonValue
```

### 5c. Missing `additionalProperties` is a compile-time error

```
Property 'additionalProperties' is missing in type '{ type: "object"; properties: {...} }'
  but required in type 'ObjectValueSchemaSpec'.
```

This applies to **explicit `{type:'object'}` nodes only**. The `parameters` root is an implicit open
object and must not be written as an object node.

### 5d. The 16-level depth cap

Inference is capped at exactly **16 container levels**. Each nested array `items`, each object node,
and each `oneOf` adds one level. At level 16 the TS type collapses to `JsonValue`. Runtime validation
is unaffected — only the static type degrades. If you hit this, your schema is too deep for a model
to fill reliably; flatten it.

---

## 6. Complete worked example

A repo-search tool exercising: enum + array + object params, an object output schema with a
`{type:'json'}` node, `render`, `presentationMeta`, `presentCall`, `presentResult` (structured
`SearchResultView` recovered from `meta`), `isConcurrencySafe`, `timeoutMs`, and full `exec.signal`
cancellation through a child process.

```ts
// src/types.ts — `type` aliases, NOT interfaces (JsonValue assignability)
export const MODES = ['literal', 'regex'] as const
export type Mode = (typeof MODES)[number]

export type Match = { path: string; line: number; text: string }
/** No optional members: an `undefined` property fails a lossless-JSON node. */
export type SearchStats = { scannedFiles: number; durationMs: number; truncatedAt: number | null }
export type SearchResult = {
  matches: Match[]
  total: number
  truncated: boolean
  stats: SearchStats
}
```

```ts
// src/index.ts
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config } from './config.js'
import { MODES, type Match, type SearchResult } from './types.js'

export { Config }
export const name = 'dsh-repo-search'
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  // Track live children so an unload / HMR / config edit cannot orphan them.
  const running = new Set<ReturnType<typeof spawn>>()
  ctx.effect(() => () => {
    for (const child of running) child.kill('SIGKILL')
    running.clear()
  })

  ctx.tools.register(defineTool({
    name: 'repo_search',
    description:
      'Search the current git repository for a pattern and return matching lines with file and ' +
      'line number. Use this to locate code before reading or editing it. Prefer it over shelling ' +
      'out to grep: results are structured and capped.',

    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'The text or regular expression to search for.',
      },
      mode: {
        type: 'string',
        enum: MODES,                       // hoisted tuple + `as const` -> 'literal' | 'regex' (§5a)
        description: 'How to interpret `pattern`. Defaults to "literal".',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repo-relative paths to restrict the search to. Defaults to the whole repo.',
      },
      options: {
        type: 'object',
        additionalProperties: false,       // MANDATORY on every object node
        properties: {
          caseSensitive: { type: 'boolean', description: 'Defaults to false.' },
          maxResults: { type: 'integer', description: 'Hard cap on returned matches.' },
        },
      },
      cwd: { type: 'string', description: 'Directory to search from. Defaults to the harness cwd.' },
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          total:     { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          stats:     { type: 'json', required: true },   // -> SearchStats (a `type` alias)
        },
      },

      // The ONLY thing the model sees. Pure and synchronous.
      render: (args, value) => {
        const v = value as SearchResult
        if (v.total === 0) return [{ type: 'text', text: `No matches for ${args.pattern}.` }]
        const lines = v.matches.map((m) => `${m.path}:${m.line}: ${m.text}`)
        const tail = v.truncated ? `\n… truncated at ${v.matches.length} of ${v.total} matches.` : ''
        return [{ type: 'text', text: lines.join('\n') + tail }]
      },

      // Persisted in the session log; replayed back to presentResult as result.meta.
      // Only computed for direct top-level calls.
      presentationMeta: (_args, value) => {
        const v = value as SearchResult
        return { matches: v.matches, total: v.total, truncated: v.truncated }
      },
    },

    // Cooperative budget, enforced by dsh-tool-call-timeout-policy via exec.signal.
    // Never sent to the model. Declaring it asserts the body forwards exec.signal.
    timeoutMs: config.timeoutMs,

    // Pure reads: several may safely overlap. Only a literal `true` opts in.
    isConcurrencySafe: () => true,

    presentCall: (args) => ({
      card: 'generic',
      title: `Search "${args.pattern}"`,
      kind: 'search',
      locations: (args.paths ?? []).map((path) => ({ path })),
    }),

    presentResult: (_args, result) => {
      // meta is JsonValue -> narrow defensively; replay may predate the current shape.
      const meta = result.meta as
        | { matches?: Match[]; total?: number; truncated?: boolean }
        | undefined
      if (!meta?.matches) return { card: 'generic', title: 'Search finished' }
      const files = groupByPath(meta.matches)
      return {
        card: 'search',
        shape: 'matches',
        files,
        total: meta.total ?? meta.matches.length,
        truncated: meta.truncated ?? false,
      }
    },

    async execute(args, exec: ToolRunContext): Promise<SearchResult> {
      const started = Date.now()
      exec.signal.throwIfAborted()

      const mode = args.mode ?? 'literal'                    // args.mode: 'literal' | 'regex' | undefined
      const maxResults = args.options?.maxResults ?? config.maxResults
      const cwd = args.cwd || process.cwd()

      const argv = ['grep', '--line-number', '--no-color']
      if (!args.options?.caseSensitive) argv.push('--ignore-case')
      if (mode === 'literal') argv.push('--fixed-strings')
      else argv.push('--extended-regexp')
      argv.push('-e', args.pattern)
      if (args.paths?.length) argv.push('--', ...args.paths)

      const stdout = await runGit(argv, cwd, exec.signal, running)

      const all: Match[] = []
      for (const raw of stdout.split('\n')) {
        if (!raw) continue
        // Re-check across the parse loop: a large result set is not instantaneous.
        exec.signal.throwIfAborted()
        const first = raw.indexOf(':')
        const second = raw.indexOf(':', first + 1)
        if (first < 0 || second < 0) continue
        all.push({
          path: raw.slice(0, first),
          line: Number(raw.slice(first + 1, second)),
          text: raw.slice(second + 1).trimEnd().slice(0, 400),
        })
      }

      const truncated = all.length > maxResults
      return {
        matches: truncated ? all.slice(0, maxResults) : all,
        total: all.length,
        truncated,
        stats: {
          scannedFiles: new Set(all.map((m) => m.path)).size,
          durationMs: Date.now() - started,
          truncatedAt: truncated ? maxResults : null,     // `null`, never `undefined`
        },
      }
    },
  }))
}

function groupByPath(matches: Match[]) {
  const byPath = new Map<string, { lineNumber: number; line: string }[]>()
  for (const m of matches) {
    const list = byPath.get(m.path) ?? []
    list.push({ lineNumber: m.line, line: m.text })
    byPath.set(m.path, list)
  }
  return [...byPath].map(([path, matches]) => ({ path, matches }))
}

/** Spawns git, forwards cancellation, and always unregisters the child. */
function runGit(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  running: Set<ReturnType<typeof spawn>>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // `signal` makes Node kill the child on abort.
    const child = spawn('git', argv, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    running.add(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', (e) => { running.delete(child); reject(e) })
    child.on('close', (code) => {
      running.delete(child)
      // git grep exits 1 when there are no matches: that is a success with empty output.
      if (code === 0 || code === 1) resolve(out)
      else reject(new Error(`git ${argv[0]} failed (exit ${code}): ${err.trim().slice(0, 500)}`))
    })
  })
}
```

Points the example is making:

- `mode` / `paths` / `options` are optional (`args.mode` is `'literal' | 'regex' | undefined`);
  only `pattern` carries `required: true`.
- Every object node declares `additionalProperties`.
- `stats` goes through a `{type:'json'}` node, so `SearchStats` is a `type` alias with **no optional
  members** — absent values are `null`.
- `render` is the model's whole view; `presentationMeta` carries the structured data forward so
  `presentResult` can rebuild a `SearchResultView` after replay.
- `presentResult` narrows `result.meta` defensively: it is `JsonValue`, and replay may predate the
  current shape.
- `exec.signal` is checked before starting, passed to `spawn`, and re-checked inside the parse loop.
- `ctx.effect` SIGKILLs any surviving child on unload — cancellation is cooperative and a child may
  outlive an abort.

---

## 7. Unit-testing a tool without booting the harness

The package's whole testing surface is `defineContentToolFixture` (marked `@internal`) — a fixture
whose canonical value *is* its `ContentBlock[]`. Its own doc says product tools must declare
domain-owned DTOs instead. Note the package `exports` map declares `.`, `./invariant`, `./types`, `./presentation`, `./src/*` and `./package.json` -- there is no `./testing` subpath -- so import it from the **root**:
`import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'`. There are **no assertion
helpers, no mock `ToolRunContext`, and no fake registry** anywhere in the package. So drive the
`ToolDefinition` directly.

### 7a. A hand-built `exec`

```js
// test/helpers.mjs
export function makeExec(name, args, signal = new AbortController().signal) {
  return {
    callId: 'c1',
    rootCallId: 'c1',
    name,
    arguments: args,
    signal,
    token: Symbol('tok'),
    deferContext() {},
    concludeTurn() {},
  }
}
```

In TypeScript, cast it: `as unknown as ToolRunContext` (the branded `CallId` / `ToolExecutionToken`
types are not constructible from user code).

### 7b. Test the four branches

```js
// test/tool.test.mjs  — run with: node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateArgs, validateJsonSchemaValue, ToolArgsError } from '@deepseek-ai/dsh-tools'

// Import from ../dist so the test also proves the BUILD loads.
import { apply } from '../dist/index.js'
import { makeExec } from './helpers.mjs'

function register() {
  const tools = []
  const ctx = {
    tools: { register: (t) => { tools.push(t); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  }
  apply(ctx, { timeoutMs: 30_000, maxResults: 200 })
  return tools[0]
}

test('model-facing schema is stable', () => {
  const tool = register()
  // tool.parameters is the compiled JSON Schema actually sent to the model. Snapshot it.
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['pattern'])
  assert.equal(tool.parameters.properties.mode.enum.join(','), 'literal,regex')
})

test('rejects bad args with ToolArgsError', async () => {
  const tool = register()
  await assert.rejects(
    () => tool.execute({}, makeExec('repo_search', {})),
    (err) => err instanceof ToolArgsError && err.violations.length > 0,
  )
})

test('output validates against the declared output schema', async () => {
  const tool = register()
  const args = { pattern: 'TODO' }
  const value = await tool.execute(args, makeExec('repo_search', args))
  // defineTool does NOT validate output — the registry does. Do it yourself in tests.
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ''), [])
  const blocks = tool.output.render(args, value)
  assert.equal(blocks[0].type, 'text')
})

test('presenters are total on both valid and obsolete args', () => {
  const tool = register()
  assert.equal(tool.presentCall({ pattern: 'x' }).card, 'generic')
  // Soft validation: obsolete/invalid args yield undefined, never a throw.
  assert.equal(tool.presentCall({}), undefined)
  const view = tool.presentResult({ pattern: 'x' },
    { content: [], isError: false, meta: { matches: [{ path: 'a.ts', line: 1, text: 'x' }], total: 1, truncated: false } })
  assert.equal(view.card, 'search')
})

test('cancellation is honoured', async () => {
  const tool = register()
  const ac = new AbortController()
  ac.abort()
  const args = { pattern: 'TODO' }
  await assert.rejects(() => tool.execute(args, makeExec('repo_search', args, ac.signal)))
})

test('validateArgs mirrors what execute enforces', () => {
  // validateArgs takes the AUTHOR spec (the parameters map you wrote), not the
  // compiled JSON Schema on tool.parameters. [] means valid.
  const spec = { pattern: { type: 'string', required: true } }
  assert.deepEqual(validateArgs(spec, { pattern: 'x' }), [])
  assert.ok(validateArgs(spec, {}).length > 0)
})
```

### 7c. The stub-Context load-check (highest value per second)

Runs `defineTool()` for real — which validates the whole schema DSL and throws on any malformed node
— and `apply()` for real, at zero harness boot cost. It also runs `mod.Config({})` so you see the
exact config the harness will pass.

```js
// scripts/loadcheck.mjs — node scripts/loadcheck.mjs /abs/path/to/plugin
import assert from 'node:assert/strict'
import path from 'node:path'

const pluginDir = process.argv[2] ?? process.cwd()
const mod = await import(path.join(pluginDir, 'dist/index.js'))

assert.ok(typeof mod.apply === 'function', 'plugin must export apply()')
console.log('name   :', mod.name)
console.log('inject :', mod.inject)

const config = mod.Config ? mod.Config({}) : {}      // Schemastery applies every default
console.log('config :', JSON.stringify(config))

const registered = []
const disposers = []
const ctx = {
  tools: { register: (tool) => { registered.push(tool); return () => {} } },
  effect: (fn) => { const d = fn(); if (d) disposers.push(d); return () => {} },
  on: () => () => {},
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}

mod.apply(ctx, config)

assert.ok(registered.length > 0, 'apply() registered no tools')
for (const t of registered) {
  console.log('tool   :', t.name)
  assert.ok(typeof t.description === 'string' && t.description.length > 0)
  assert.ok(typeof t.execute === 'function')
}
for (const d of disposers) d()
console.log('LOAD-CHECK OK')
```

### 7d. Verification ladder

```sh
DSH="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"
npx tsc -p tsconfig.json --noEmit      # 1. types
npm run build                          # 2. dist/
node --test test/*.test.mjs            # 3. unit tests (import ../dist -> proves the build loads)
node scripts/loadcheck.mjs "$PWD"      # 4. stub-Context load-check: real defineTool + real apply
$DSH --profile web --dump-config       # 5. composition (look for "# == <your-package>")
$DSH --profile web --help              # 6. boot smoke test
```

A clean profile boot is only **negative** evidence that `apply` ran — the default log level does not
surface a plugin's `log.info()`. Rung 4 is the positive proof.

---

## 8. Prior art in the installed profile

Read these under
`$HOME/.dsh/profiles/node_modules/@deepseek-ai/` (use `find -L`; the profile entries are
symlinks and plain `find` returns nothing):

| Package | Why read it |
| --- | --- |
| `dsh-tool-todo` | Simplest complete tool plugin. |
| `dsh-tool-web` | A tool that injects another service (`ctx.web`). |
| `dsh-tool-fs`, `dsh-tool-fs-search` | Rich presentation views (`read`, `search` cards) via `presentationMeta`. |
| `dsh-tool-bash` | `terminal` call/result cards; subprocess + signal handling. |
| `dsh-tool-call-timeout-policy` | How `timeoutMs` is actually enforced (a `tools/execute` wrapper). |
| `dsh-tools/lib/types/{schema,index,presentation,json-schema,testing}.d.ts` | The authoritative types quoted above. |
| `/Users/charlesqin/orca/projects/DSH-Project/dsh-pi-review` | A verified, installed end-to-end example. |
