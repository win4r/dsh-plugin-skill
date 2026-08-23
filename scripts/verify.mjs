#!/usr/bin/env node
// Verification ladder for a DeepSeek Harness (DSH) plugin.
//
// Usage:
//   node verify.mjs <pluginDir> [--profile web] [--skip-build] [--no-dump]
//
// Rungs (each catches a class the next cannot):
//   1  package.json sanity           HARD
//   2  devDependency pin drift       WARN
//   3  npx tsc --noEmit              HARD
//   4  npm run build + main exists   HARD
//   5  runtime load-check            HARD   <- the high-value rung
//   6  dsh --dump-config             WARN   (only with --profile)
//
// Exits non-zero on the first hard failure. Node ESM, zero dependencies.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const HARNESS_PINS = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']

let warnings = 0

const ok = (msg) => console.log(`PASS  ${msg}`)
const info = (msg) => console.log(`      ${msg}`)
const warn = (msg) => {
  warnings++
  const [head, ...more] = String(msg).split('\n')
  console.log(`WARN  ${head}`)
  for (const line of more) console.log(`      ${line.replace(/^ {6}/, '')}`)
}
function fail(rung, msg, detail) {
  const [head, ...more] = String(msg).split('\n')
  console.log(`FAIL  ${rung}: ${head}`)
  for (const line of more) console.log(`      ${line}`)
  if (detail) console.log(String(detail).split('\n').map((l) => `      ${l}`).join('\n'))
  process.exit(1)
}

function parseArgs(argv) {
  const opts = { dump: true, build: true }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-dump') opts.dump = false
    else if (a === '--skip-build') opts.build = false
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i]
    else rest.push(a)
  }
  opts._ = rest
  return opts
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function dshBin() {
  return path.join(dshHome(), 'profiles/node_modules/@deepseek-ai/dsh/lib/bin.js')
}

function readInstalledVersion(pkg, profile) {
  const home = dshHome()
  const candidates = [
    profile && path.join(home, 'profiles', profile, 'node_modules', ...pkg.split('/'), 'package.json'),
    path.join(home, 'profiles', 'node_modules', ...pkg.split('/'), 'package.json'),
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(fs.realpathSync(file), 'utf8')).version
    } catch {
      /* next */
    }
  }
  return null
}

function run(cmd, args, cwd, timeout = 300_000) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, shell: process.platform === 'win32' })
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
    error: r.error,
  }
}

function tail(text, n = 30) {
  const lines = String(text).split('\n')
  return lines.slice(-n).join('\n')
}

// ---------------------------------------------------------------------------
// Rung 5 support: a stub Context that records everything and names anything
// it was not asked to provide.
// ---------------------------------------------------------------------------

class UnstubbedService extends Error {
  constructor(name) {
    super(
      `the plugin touched ctx.${name}, which the stub Context does not provide.\n` +
        `If ctx.${name} is a real service, add it to \`export const inject\` (every entry is ` +
        `required and blocking) or read it optionally with ctx.get('${name}').`,
    )
    this.serviceName = name
  }
}

function makeRecorder(record, serviceName) {
  // Callable so `ctx.logger('x')` and `ctx.someService()` both work.
  const target = function () {}
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then') return undefined // never look thenable to `await`
      return (...args) => {
        record.calls.push({ service: serviceName, method: String(prop), args })
        return () => true
      }
    },
    apply() {
      record.calls.push({ service: serviceName, method: '(call)', args: [] })
      return makeRecorder(record, `${serviceName}()`)
    },
  })
}

function makeStubContext(injected) {
  const record = { tools: [], services: [], listeners: [], effects: [], calls: [] }

  const collect = (result) => {
    if (typeof result === 'function') record.effects.push(result)
    else if (result && typeof result[Symbol.iterator] === 'function') {
      for (const d of result) if (typeof d === 'function') record.effects.push(d)
    }
  }

  const base = {
    tools: {
      register(definition) {
        if (!definition || typeof definition !== 'object') {
          throw new Error('ctx.tools.register() called with a non-object')
        }
        record.tools.push(definition)
        return () => true
      },
      restrict: () => () => true,
      guard: () => () => true,
      presentAs: () => () => true,
      schemas: () => [],
      get: () => undefined,
    },
    effect(execute, label) {
      if (typeof execute !== 'function') throw new TypeError('ctx.effect(execute) needs a function')
      collect(execute())
      record.calls.push({ service: 'ctx', method: 'effect', args: [label ?? 'anonymous'] })
      return () => Promise.resolve()
    },
    on(name, listener) {
      record.listeners.push(String(name))
      if (typeof listener !== 'function') throw new TypeError(`ctx.on(${name}) needs a listener`)
      return () => true
    },
    once(name, listener) {
      return base.on(name, listener)
    },
    // Optional-dependency probe: undefined is the honest answer under a stub.
    get(name) {
      record.calls.push({ service: 'ctx', method: 'get', args: [String(name)] })
      return undefined
    },
    set: () => undefined,
    provide(name, value) {
      record.services.push(String(name))
      void value
      return () => true
    },
    accessor: () => () => true,
    mixin: () => () => true,
    logger: makeRecorder(record, 'logger'),
    emit: () => undefined,
    parallel: async () => undefined,
    serial: async () => undefined,
    bail: () => undefined,
    waterfall: (...args) => {
      const next = args[args.length - 1]
      return typeof next === 'function' ? next() : undefined
    },
    plugin: () => ({}),
    // ctx.inject(deps, cb) is how the skill tells authors to reach an OPTIONAL
    // service without blocking load on it. The callback receives a context in
    // which those deps exist, so the stub must supply them -- otherwise the
    // prescribed pattern trips UnstubbedService and the failure message tells
    // the reader to add the service to `inject`, which is the opposite of right.
    inject(deps, callback) {
      const names = injectedNames(deps)
      record.calls.push({ service: 'ctx', method: 'inject', args: names })
      if (typeof callback !== 'function') return {}
      const scoped = new Proxy(base, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && names.includes(prop) && !(prop in target)) {
            return makeRecorder(record, prop)
          }
          if (prop in target) return Reflect.get(target, prop, receiver)
          if (typeof prop === 'symbol') return undefined
          if (prop === 'then' || prop === 'constructor' || prop === 'toJSON') return undefined
          throw new UnstubbedService(String(prop))
        },
        has: () => true,
      })
      callback(scoped)
      return {}
    },
    // extend/isolate/intercept never mutate the parent; the stub returns itself.
    extend: () => ctx,
    isolate: () => ctx,
    intercept: () => ctx,
    reflect: {
      provide(name) {
        record.services.push(String(name))
        return () => true
      },
      get: () => undefined,
      set: () => undefined,
      mixin: () => () => true,
      accessor: () => () => true,
    },
    registry: { plugin: () => ({}), inject: () => ({}) },
    events: { on: (n, l) => base.on(n, l), once: (n, l) => base.on(n, l) },
    fiber: { effect: (fn, label) => base.effect(fn, label), uid: 1, name: 'stub' },
    // Optional Context MEMBERS (never services, never legal in `inject`).
    dshHomePath: dshHome(),
    baseUrl: pathToFileURL(`${process.cwd()}/`).href,
    cmdlineArgs: undefined,
    agent: undefined,
  }

  // Anything the plugin explicitly injected gets a recording stub rather than
  // an error -- it legitimately exists at runtime.
  for (const name of injected) {
    if (!(name in base)) base[name] = makeRecorder(record, name)
  }

  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then' || prop === 'constructor' || prop === 'toJSON') return undefined
      throw new UnstubbedService(String(prop))
    },
    has: () => true,
  })

  return { ctx, record }
}

function injectedNames(inject) {
  if (Array.isArray(inject)) return inject.map(String)
  if (inject && typeof inject === 'object') return Object.keys(inject)
  return []
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || opts._.length === 0) {
    console.log('Usage: node verify.mjs <pluginDir> [--profile web] [--skip-build] [--no-dump]')
    process.exit(opts.help ? 0 : 1)
  }
  const dir = path.resolve(opts._[0])
  const profile = opts.profile || null
  if (!fs.existsSync(dir)) fail('setup', `${dir} does not exist`)
  console.log(`Verifying ${dir}${profile ? `  (profile: ${profile})` : ''}\n`)

  // -- 1. package.json sanity ------------------------------------------------
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) fail('1 package.json', `no package.json in ${dir}`)
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    fail('1 package.json', `not valid JSON`, err.message)
  }
  if (manifest.type !== 'module') {
    fail('1 package.json', '"type" must be "module" -- cordis/dsh are ESM-only')
  }
  const mainRel = manifest.main
  if (!mainRel) fail('1 package.json', '"main" is missing (point it at the BUILT entry, e.g. dist/index.js)')
  if (/^(\.\/)?src\//.test(mainRel)) {
    fail('1 package.json', `"main" points at source (${mainRel}); it must point at build output`)
  }
  const patchRel = manifest.dsh?.bundle?.patch
  if (patchRel === undefined) {
    fail(
      '1 package.json',
      'dsh.bundle.patch is missing -- without it the package installs as a plain dependency, ' +
        'not a profile layer (dsh prints "declares no dsh.bundle")',
    )
  }
  const patchPath = path.join(dir, patchRel)
  if (!fs.existsSync(patchPath)) fail('1 package.json', `dsh.bundle.patch points at a missing file: ${patchRel}`)
  const files = manifest.files
  if (Array.isArray(files) && !files.some((f) => path.normalize(f) === path.normalize(patchRel.replace(/^\.\//, '')))) {
    warn(`"files" does not list ${patchRel} -- a published/tarball install would ship no patch`)
  }
  ok(`1 package.json  (name: ${manifest.name}, main: ${mainRel}, patch: ${patchRel})`)

  // Cheap patch sanity: the row's `name` must be the installed package name.
  const patchText = fs.readFileSync(patchPath, 'utf8')
  if (!patchText.includes(manifest.name)) {
    warn(
      `${patchRel} never mentions "${manifest.name}" -- a patch row's \`name\` must be the ` +
        'INSTALLED PACKAGE NAME so Node can resolve it',
    )
  }

  // -- 2. devDependency pin drift (WARN only) --------------------------------
  const dev = manifest.devDependencies ?? {}
  let checked = 0
  const pinWarningsBefore = warnings
  for (const pkg of HARNESS_PINS) {
    const declared = dev[pkg]
    if (declared === undefined) continue
    checked++
    const installed = readInstalledVersion(pkg, profile)
    if (!installed) {
      warn(`2 pin: ${pkg} is not installed under ${dshHome()}/profiles -- cannot check drift`)
      continue
    }
    if (declared === '*' || declared === 'latest') {
      warn(
        `2 pin: ${pkg} is "${declared}" in devDependencies. npm's "latest" dist-tag for ` +
          `@deepseek-ai/dsh-tools is an OLDER API line; the profile runs ${installed}. Pin ^${installed}.`,
      )
      continue
    }
    const bare = declared.replace(/^[\^~=v]+/, '')
    if (bare !== installed) {
      warn(`2 pin: ${pkg} devDep "${declared}" != profile-installed ${installed} -- pin ^${installed}`)
    }
  }
  if (checked === 0) warn('2 pin: no harness packages found in devDependencies')
  else if (warnings === pinWarningsBefore) {
    ok('2 pin: devDependencies match the profile-installed harness versions')
  } else ok('2 pin: checked (see the pin warnings above)')

  // -- 3. typecheck ----------------------------------------------------------
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    fail('3 typecheck', 'node_modules is missing -- run `npm install` in the plugin directory first')
  }
  if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
    const r = run('npx', ['--no-install', 'tsc', '-p', 'tsconfig.json', '--noEmit'], dir)
    if (r.error) fail('3 typecheck', `could not run tsc: ${r.error.message}`)
    if (r.status !== 0) fail('3 typecheck', 'tsc reported errors', tail(r.out, 40))
    ok('3 typecheck: tsc --noEmit clean')
  } else {
    warn('3 typecheck: no tsconfig.json -- skipping (plain-JS plugin?)')
  }

  // -- 4. build --------------------------------------------------------------
  const mainPath = path.join(dir, mainRel)
  if (opts.build && manifest.scripts?.build) {
    const r = run('npm', ['run', 'build'], dir)
    if (r.error) fail('4 build', `could not run npm: ${r.error.message}`)
    if (r.status !== 0) fail('4 build', 'npm run build failed', tail(r.out, 40))
    ok('4 build: npm run build succeeded')
  } else {
    warn(`4 build: skipped (${opts.build ? 'no build script' : '--skip-build'})`)
  }
  if (!fs.existsSync(mainPath)) {
    fail(
      '4 build',
      `main entry ${mainRel} does not exist. A directory install is a SYMLINK, so nothing ` +
        'builds it for you -- run `npm run build` before installing and after every edit.',
    )
  }
  ok(`4 build: ${mainRel} exists`)

  // -- 5. runtime load-check -------------------------------------------------
  let mod
  try {
    mod = await import(pathToFileURL(mainPath).href)
  } catch (err) {
    fail('5 load-check', `importing ${mainRel} threw`, err.stack ?? err.message)
  }

  // Order matters. Every class inherits Function.prototype.apply, so an
  // `mod.default?.apply` probe matches a class-form plugin and then calls the
  // constructor without `new`. Detect the class first, and use an own-property
  // lookup for the object form so inherited `apply` can never be mistaken for it.
  const isClassForm =
    typeof mod.default === 'function' &&
    /^class\s/.test(Function.prototype.toString.call(mod.default))
  const entry =
    typeof mod.apply === 'function'
      ? mod.apply
      : isClassForm
        ? mod.default
        : mod.default && typeof mod.default === 'object' && typeof mod.default.apply === 'function'
          ? mod.default.apply.bind(mod.default)
          : typeof mod.default === 'function'
            ? mod.default
            : null
  if (!entry) {
    fail(
      '5 load-check',
      'no plugin entrypoint. Export `apply(ctx, config)`, or default-export an object with ' +
        '`apply`, or default-export a class.',
    )
  }

  const inject = mod.inject ?? mod.default?.inject ?? entry.inject
  const injected = injectedNames(inject)
  info(`name    : ${mod.name ?? mod.default?.name ?? '(unset)'}`)
  info(`inject  : ${injected.length ? JSON.stringify(injected) : '[]'}`)
  if (inject && !Array.isArray(inject) && ('required' in inject || 'optional' in inject)) {
    warn(
      "5 load-check: inject uses the cordis-3 { required, optional } shape. In cordis 4.0.1 the " +
        'object form maps serviceName -> intercept config, so this plugin will block forever ' +
        'waiting for services literally named "required"/"optional". Use the array form.',
    )
  }

  const ConfigSchema = mod.Config ?? mod.default?.Config ?? entry.Config
  let config = {}
  if (ConfigSchema) {
    if (typeof ConfigSchema !== 'function') {
      fail(
        '5 load-check',
        'Config is not callable. Cordis needs a Standard Schema (v1) implementation ' +
          '(`Schema.object({...})` from @deepseek-ai/schemastery), not a plain object.',
      )
    }
    try {
      config = ConfigSchema({})
    } catch (err) {
      fail('5 load-check', 'Config({}) threw -- a row with no config would fail to load', err.message)
    }
    info(`config  : ${JSON.stringify(config)}`)
  } else {
    info('config  : (no Config schema exported)')
  }

  const { ctx, record } = makeStubContext(injected)
  try {
    const result = isClassForm ? new entry(ctx, config) : entry(ctx, config)
    if (result && typeof result.then === 'function') await result
  } catch (err) {
    if (err instanceof UnstubbedService) fail('5 load-check', err.message)
    fail('5 load-check', 'apply() threw', err.stack ?? err.message)
  }

  const registeredCount = record.tools.length + record.services.length
  if (registeredCount === 0) {
    fail(
      '5 load-check',
      'apply() registered no tool and provided no service. Nothing this plugin does is ' +
        `observable. (listeners registered: ${record.listeners.length})`,
    )
  }

  for (const tool of record.tools) {
    if (typeof tool.name !== 'string' || !tool.name) fail('5 load-check', 'a registered tool has no name')
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      fail('5 load-check', `tool "${tool.name}" has an empty description -- the model uses it to choose`)
    }
    if (typeof tool.execute !== 'function') fail('5 load-check', `tool "${tool.name}" has no execute()`)
    if (tool.name === 'run_code') fail('5 load-check', '"run_code" is reserved and always fails to register')
    info(`tool    : ${tool.name}`)
  }
  for (const name of record.services) info(`service : ctx.${name}`)
  for (const name of record.listeners) info(`listener: ${name}`)
  info(`effects : ${record.effects.length}`)

  // Prove cleanup does not throw -- disposers run in REVERSE registration order.
  for (const dispose of [...record.effects].reverse()) {
    try {
      const r = dispose()
      if (r && typeof r.then === 'function') await r
    } catch (err) {
      fail('5 load-check', 'an effect disposer threw during teardown', err.stack ?? err.message)
    }
  }
  ok(`5 load-check: apply() registered ${record.tools.length} tool(s), ${record.services.length} service(s); teardown clean`)

  // -- 6. composition --------------------------------------------------------
  if (profile && opts.dump) {
    const bin = dshBin()
    if (!fs.existsSync(bin)) {
      warn(`6 dump-config: dsh CLI not found at ${bin}`)
    } else {
      const r = run('node', [bin, '--profile', profile, '--dump-config'], os.tmpdir(), 120_000)
      if (r.status !== 0) {
        warn(`6 dump-config: exited ${r.status}`)
        info(tail(r.out, 15))
      } else if (r.out.includes(manifest.name)) {
        ok(`6 dump-config: "${manifest.name}" appears in the composed tree for profile "${profile}"`)
        const block = r.out
          .split('\n')
          .filter((l, i, all) => l.includes(manifest.name) || (i > 0 && all[i - 1].includes(manifest.name)))
        info(block.slice(0, 8).join('\n      '))
      } else {
        warn(
          `6 dump-config: "${manifest.name}" is NOT in profile "${profile}". Install it:\n` +
            `      node ${bin} plugin --profile ${profile} add -w ${dir}    (-w is MANDATORY)`,
        )
      }
    }
  }

  console.log(`\nDone. ${warnings} warning(s), 0 hard failures.`)
}

main().catch((err) => {
  console.error(`verify: unexpected error\n${err.stack ?? err}`)
  process.exit(1)
})
