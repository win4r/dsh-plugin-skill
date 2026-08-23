# Build → Install → Verify → Uninstall

Everything here is literal. Copy the commands.

## 0. Environment

There is **no `dsh` on PATH**. Every invocation is a `node` call against the installed CLI:

```bash
DSH="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"
```

Define it **once** per shell and reuse `$DSH` everywhere below. Two things the handle must get right:

- Use `$HOME`, not `~`: a tilde does **not** expand inside double quotes, so `DSH="~/.dsh/..."`
  produces a literal `~` and `Error: Cannot find module '~/.dsh/...'`.
- Hold only the **path**, never `DSH="node /path/bin.js"`. `lib/bin.js` is the package's declared
  `bin` and carries a `#!/usr/bin/env node` shebang, so it runs on its own. Baking `node` into the
  variable makes `$DSH --version` fail under zsh (`no such file or directory: node /...`), because
  zsh — unlike bash — does not word-split an unquoted parameter expansion.

| Thing | Path |
|---|---|
| DSH install root (shared `node_modules`) | `~/.dsh/profiles/node_modules/@deepseek-ai` |
| Profiles | `~/.dsh/profiles/web`, `~/.dsh/profiles/headless` |
| Profile package manager | pnpm (the profile dir is a pnpm **workspace root**) |
| Plugin-local package manager | npm |

Profile layout (`$DSH_HOME` defaults to `~/.dsh`):

```
~/.dsh/
  cordis.patch.yml          # home-level user layer (outranks the per-profile layer)
  .credentials.yaml  .env  settings.yaml
  profiles/
    node_modules/           # maintained installation fallback (one symlink per package)
    web/
      package.json          # dependencies + dsh.profile.bundles
      cordis.yml            # ALWAYS []. Do not edit.
      cordis.patch.yml      # the per-profile user layer. Edit this.
      pnpm-workspace.yaml   # packages: [.]   <- why `add` needs -w
      pnpm-lock.yaml  node_modules/
```

## 1. Read the profile's real versions (do this first, every time)

```bash
for p in cordis dsh-tools schemastery dsh-llm dsh-session; do
  echo -n "$p: "
  node -p "require('$HOME/.dsh/profiles/node_modules/@deepseek-ai/$p/package.json').version"
done
```

Current values on this machine:

```
cordis: 4.0.1
dsh-tools: 0.1.1-rc.2
schemastery: 3.18.1
dsh-llm: 0.1.1-rc.2
dsh-session: 0.1.1-rc.2
```

### Why devDeps must be pinned to exactly these

`npm view @deepseek-ai/dsh-tools dist-tags` → `latest: 0.0.1-rc.1`, `next: 0.1.1-rc.2`.

The registry's `latest` tag points at the **old** line. So `npm i @deepseek-ai/dsh-tools`, or a
`"*"` devDependency, installs `0.0.1-rc.1` — a different API — and you typecheck against a harness
you will never run on. The failure is silent at build time and loud at boot.

Rules:

- `devDependencies`: **pin to the profile's versions** (`^4.0.1`, `^0.1.1-rc.2`, `^3.18.1`).
- `peerDependencies`: `"*"` is fine and documents "the host supplies these". Harmless only because
  `~/.dsh/profiles/<p>/pnpm-workspace.yaml` sets `autoInstallPeers: false`.
- Harness packages belong in **both** lists.

`scripts/scaffold.mjs` reads these versions off disk and writes them into the generated
`package.json`, so a scaffolded plugin cannot drift on day one. `scripts/verify.mjs` re-checks the
pin on every run (WARN, not a hard failure).

## 2. Build

`dist/` is git-ignored but **required at install time** — a directory install is a symlink, so no
build hook ever runs (see §4).

```bash
P=/abs/path/to/dsh-my-plugin
cd $P
npm install
npm run build          # tsc -p tsconfig.json  → dist/*.js + dist/*.d.ts
```

Rebuild after **every** source edit. A stale `dist/` is the single most common cause of
"my change did nothing".

## 3. Install into a profile

```bash
cd /parent/dir/containing/the/plugin
$DSH plugin --profile web add -w ./dsh-my-plugin
```

**`-w` is mandatory for `add`.** Without it:

```
ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root...
dsh: pnpm failed in profile directory /Users/charlesqin/.dsh/profiles/web
# exit code 1
```

Success looks like:

```
dependencies:
+ dsh-my-plugin 0.1.0 <- ../../../abs/path/to/dsh-my-plugin
```

### What `add` mutates

Two independent actors write to `~/.dsh/profiles/web/package.json`:

1. **pnpm** adds the dependency, rewriting your relative spec into an absolute `link:`:
   ```json
   "dependencies": { "dsh-my-plugin": "link:/abs/path/to/dsh-my-plugin" }
   ```
2. **dsh's `reconcilePlugins()`** (runs only when pnpm exits 0) appends the *installed package name*
   to the bundle list:
   ```json
   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-my-plugin"] } }
   ```

Also written: `pnpm-lock.yaml`, and a `node_modules/dsh-my-plugin` **symlink**.
**`cordis.yml` is never touched** — it stays `[]`.

Reconciliation is by *installed state*, not dependency diff: the promotion key is
`package.json → dsh.bundle.patch`. A package without it installs as a plain dependency and dsh
prints `warning: <pkg> declares no dsh.bundle`.

### Path anchoring

`dsh plugin` spawns pnpm with `cwd = the profile directory`, but first rewrites any argument
matching `^(file:|link:)?\.{1,2}([/\\].*)?$` against **your** invoking cwd. So `.`, `./plugin` and
`../plugin` are anchored correctly; everything else (registry names, `git+…`, tarballs) passes
through verbatim.

### Other install forms

```bash
$DSH plugin --profile web add -w dsh-my-plugin@0.2.0            # npm registry
$DSH plugin --profile web add -w github:you/repo#<commit-sha>   # git — pin the SHA
```

Git installs fetch **sources, not build output**, so the package needs a self-contained `prepare`
script. pnpm ≥10 then refuses to run it until you allowlist the build in
`~/.dsh/profiles/<p>/pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - dsh-my-plugin
```

…and re-run the add. Note the key: pnpm here is **10.4.1**, whose key is `onlyBuiltDependencies`
(a **list** of package names). dsh's own failure message suggests the stale `allowBuilds: {name: true}`
form, which does not exist anywhere in pnpm 10.4.1 and is silently ignored — copy the key **pnpm**
itself prints, not the one dsh suggests.

Publishing to npm, or `pnpm pack`-ing a tarball, avoids the allowance entirely.

`dsh plugin --profile <p> <args...>` forwards `<args...>` verbatim to pnpm with the profile dir as
cwd, so any pnpm verb works (`list`, `why`, `update`, …).

## 4. Verify

Run the ladder in order. Each rung catches a class the next cannot.

```bash
P=/abs/path/to/dsh-my-plugin
DSH="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"

cd $P && npx tsc -p tsconfig.json --noEmit     # 1. typecheck
cd $P && npm run build                          # 2. build
cd $P && node --test test/*.test.mjs            # 3. unit tests (import ../dist/*.js)
node .../scripts/verify.mjs $P --profile web    # 4. runtime load-check (see §4.2)
$DSH --profile web --dump-config                # 5. composition
cd /tmp && $DSH --profile web --help            # 6. profile composes + app constructs
#                                               # 7. functional: the model calls it (see §4.4)
```

Or run the bundled script. It performs its own six checks — package.json sanity (HARD),
devDependency pin drift (WARN), `tsc --noEmit` (HARD), `npm run build` + main-exists (HARD), the
runtime load-check (HARD), and `--dump-config` (WARN, only with `--profile`) — which covers ladder
rungs **1, 2, 4 and 5**. It does **not** run your unit tests (rung 3), the boot smoke test (rung 6)
or the functional check (rung 7); run those yourself.

```bash
node /Users/charlesqin/orca/projects/DSH-Project/.claude/skills/dsh-plugin/scripts/verify.mjs \
  /abs/path/to/dsh-my-plugin --profile web
```

### 4.1 Reading `--dump-config`

```bash
$DSH --profile web --dump-config | tail -30
```

Output is the fully composed cordis entry tree, with a provenance comment naming the layer each
entry came from:

```yaml
# == @deepseek-ai/dsh-base
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config: { mode: native }
...
# == dsh-my-plugin
- id: my-plugin
  name: dsh-my-plugin
  config:
    defaultMode: upper
    maxLength: 10000
```

What to check:

- A `# == <your-package-name>` block exists → the bundle layer activated.
- `name:` equals the **installed package name** (Node must be able to resolve it).
- `id:` is what later patch layers target.
- `config:` shows the *patched* values only. Schemastery defaults are applied later, at load.
- `!!js` expressions print **unevaluated**; a dump never evaluates them.

Layer order composed over an empty root:

1. each bundle patch in `dsh.profile.bundles` order (`@deepseek-ai/dsh-base` first)
2. the profile's `cordis.patch.yml`
3. the home-level `$DSH_HOME/cordis.patch.yml` (outranks the per-profile layer)
4. each `--patch <path>` overlay, in argv order

Later layers win per row. Two related flags:

```bash
$DSH --profile web --dump-default-config   # bundle layers ONLY (no user patches)
$DSH --profile web --dump-config           # + profile patch + home patch + --patch overlays
```

A dump never runs app command-line providers and rejects an invocation carrying app arguments.
Patches that match nothing warn on stderr and are skipped — they are never a hard failure.

Dev overlay without installing:

```bash
$DSH --profile web --patch /abs/path/to/dev.patch.yml --dump-config
```

The `name:` in a `--patch` overlay row **must be an absolute path** if it points at a source file —
a patch contributes configuration but does not change the directory the loader resolves module
paths from.

### 4.2 The runtime load-check (highest value rung)

Idea: import the built entry, call `apply()` against a **stub Context**, and assert it registered
something. This runs `defineTool()` for real — which is what validates the schema DSL and throws on
malformed nodes — and runs `apply()` for real, at zero harness boot cost.

```bash
node scripts/verify.mjs /abs/path/to/dsh-my-plugin
```

The stub supplies `tools.register`, `effect`, `on`, `get` and `logger`, records every call, and is
wrapped in a `Proxy` so an unstubbed `ctx.<service>` access reports the service name instead of
throwing a bare `TypeError`. After `apply()` it:

- asserts at least one tool or service was registered, and prints their names
- prints the config Schemastery produced from `{}` (i.e. every default, exactly as the harness will
  pass it)
- runs the collected `ctx.effect` disposers to prove cleanup does not throw

Minimal hand-rolled version, if you want it inline:

```js
import path from 'node:path'
const mod = await import(path.join(pluginDir, 'dist/index.js'))
const config = mod.Config ? mod.Config({}) : {}
const registered = [], disposers = []
const ctx = {
  tools: { register: (t) => (registered.push(t), () => {}) },
  effect: (fn) => { const d = fn(); if (d) disposers.push(d); return () => {} },
  on: () => () => {},
  logger: () => ({ info(){}, warn(){}, error(){}, debug(){} }),
}
await mod.apply(ctx, config)
for (const d of disposers) d()
```

### 4.3 Boot smoke test

```bash
cd /tmp
$DSH --profile web --help                       # composes the profile, constructs the app
timeout 20 $DSH --profile web --port 0 --no-open
#   → dsh web: http://127.0.0.1:62335
```

- `--port 0` takes an ephemeral port so a running instance does not collide.
- `--no-open` suppresses the browser launch — always use it in an agent/CI context.
- Stop it with Ctrl-C, or `timeout N` as above, or `kill <pid>` on a backgrounded run.
- Headless profile: `$DSH --profile headless --help`.

**Honest limit:** a clean boot is only *negative* evidence that `apply()` ran — the default log
level does not surface a plugin's `log.info()`. §4.2 is the positive proof; boot only proves
nothing else in the tree rejects the new layer.

### 4.4 Functional — the model can actually see and call it

Every rung above proves the plugin *loads*. None proves the **model** is offered the tool, picks it,
and that its rendered output reaches the answer. The cheapest end-to-end proof is one headless turn:

```bash
DSH="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"

cd /parent/dir/containing/the/plugin
$DSH plugin --profile headless add -w ./dsh-my-plugin     # install into headless too

cd /abs/path/to/a/scratch/dir
$DSH --profile headless "use the <tool_name> tool to <trivial task>"
```

Pass if the tool's **rendered output** shows up in the printed answer — that is the only signal that
the tool was registered, exposed to the model, invoked, and presented.

Two honest caveats:

- **It spends provider tokens.** This is a real model turn, not a stub. Keep the task trivial and
  run it once, at the end — not in a tight loop.
- **It only works if the plugin injects nothing web-only.** A plugin whose `inject` names a service
  the headless profile never provides will simply never run its `apply()` there, and the run will
  look like "the model ignored my tool".

Fallback for a web-only plugin: boot the web surface (`$DSH --profile web --port 0 --no-open`), open
a session in the browser, and confirm the tool appears in the session's tool list / is callable
there.

And repeating the §4.3 limit, because it bites hardest here: your plugin's own `log.info()` is
**not** evidence either way. The default log level never surfaces it, so a silent console says
nothing about whether `apply()` ran. Only the tool's rendered output in the answer counts.

## 5. Iterating

**Module HMR is off in both stock profiles.** Only two files are live: the two *user-layer* patch
files the launcher watches explicitly. Everything else needs a restart.

| Change | What to do | Live? |
|---|---|---|
| `src/` edit | `npm run build` **and restart the harness** | no |
| **your** package's `cordis.patch.yml` (`dsh.bundle.patch`) | restart the harness | no |
| `$HOME/.dsh/profiles/<p>/cordis.patch.yml` or `$HOME/.dsh/cordis.patch.yml` | just save the file | **yes** |
| bundle membership (add/remove) | re-run `plugin add`/`remove`, then restart | no |

Why, so you can re-verify it:

- The shared HMR entry is **disabled in both stock bundles** — `- id: hmr` / `disabled: true` at
  `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:22` and
  `.../dsh-headless/cordis.patch.yml:14`.
- The launcher then re-creates it itself with **no module roots watched**:
  `ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })` in
  `~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/profile-boot-DG5t9aNs.js` (~line 259). An empty
  `root` means no source tree is watched, so a rebuilt `dist/` is **never** hot-reloaded.
- Immediately after, that same function calls `watchUserPatches(ctx, …)` **twice, on exactly two
  paths**: `composed.profile.patchPath` (= `~/.dsh/profiles/<p>/cordis.patch.yml`) and
  `homePatchPath()` (= `~/.dsh/cordis.patch.yml`). That watch is what keeps the user layers live even
  with the `hmr` row disabled — and it covers nothing else.
- Bundle layers (including **your** package's patch) are composed **once, at boot**, before that
  watch is installed. Editing your own bundle patch and saving changes nothing until you restart.

**Practical consequence:** do not iterate config by editing your package's bundle patch. Put the
values you are tuning in the profile **user layer** (`~/.dsh/profiles/<p>/cordis.patch.yml`),
targeting your row's `id` — that loop is save-and-see. When the values settle, fold them back into
your bundle patch and restart once to confirm they compose the same way.

Disable without uninstalling — append to `~/.dsh/profiles/<p>/cordis.patch.yml`:

```yaml
- id: my-plugin
  disabled: true
```

(That is exactly how the `dsh-web-app` layer disables the `hmr` entry.)

## 6. Uninstall

```bash
$DSH plugin --profile web remove dsh-my-plugin
```

- **No `-w` needed** for `remove` (the workspace-root guard is `add`-specific).
- Remove by **installed package name**, not by the path you added.

Both edits are undone: pnpm drops the dependency (and the whole `dependencies` key if it was the
only one) and drops the `node_modules` symlink and lockfile entry; `reconcilePlugins()` drops the
name from `dsh.profile.bundles`. `cordis.yml` is untouched.

Confirm:

```bash
$DSH --profile web --dump-config | grep -c 'dsh-my-plugin'   # → 0
```

Clean up any `cordis.patch.yml` override still targeting the removed row's `id` — otherwise you
leave a dangling patch target that warns on every boot.
