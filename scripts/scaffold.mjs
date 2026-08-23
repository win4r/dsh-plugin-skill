#!/usr/bin/env node
// Scaffold a DeepSeek Harness (DSH) plugin from the templates in ../scaffold.
//
// Usage:
//   node scaffold.mjs <plugin-name> [--dir <parent>] [--profile web]
//                     [--tool <tool_name>] [--id <row-id>] [--description <text>] [--force]
//
// The generated package.json devDependencies are PINNED to the versions actually
// installed in the named profile, so a fresh plugin can never drift from the harness.
//
// Node ESM, zero dependencies.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_DIR = path.resolve(HERE, '..', 'scaffold')

// Harness packages: pinned from the live install. '*' is a LAST resort.
const HARNESS_PACKAGES = {
  __CORDIS_VERSION__: '@deepseek-ai/cordis',
  __DSH_TOOLS_VERSION__: '@deepseek-ai/dsh-tools',
  __SCHEMASTERY_VERSION__: '@deepseek-ai/schemastery',
}
// Toolchain packages: not harness API, so a static default is fine.
const TOOLCHAIN_DEFAULTS = {
  __NODE_TYPES_VERSION__: { pkg: '@types/node', fallback: '^26.2.0' },
  __TYPESCRIPT_VERSION__: { pkg: 'typescript', fallback: '^5.9.3' },
}

function die(msg) {
  console.error(`scaffold: ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = { profile: 'web', dir: process.cwd(), force: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force' || a === '-f') opts.force = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const value = argv[++i]
      if (value === undefined) die(`--${key} needs a value`)
      opts[key] = value
    } else rest.push(a)
  }
  opts._ = rest
  return opts
}

const USAGE = `Usage: node scaffold.mjs <plugin-name> [options]

Options:
  --dir <parent>         Parent directory for the new plugin (default: cwd)
  --profile <name>       Profile to read installed versions from (default: web)
  --tool <tool_name>     Tool name registered by the plugin (default: derived)
  --id <row-id>          cordis.patch.yml row id (default: name without a dsh- prefix)
  --description <text>   Package description
  --force, -f            Overwrite an existing directory
`

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Read a package version from the profile, then from the shared installation. */
function readInstalledVersion(pkg, profile) {
  const home = dshHome()
  const candidates = [
    path.join(home, 'profiles', profile, 'node_modules', ...pkg.split('/'), 'package.json'),
    path.join(home, 'profiles', 'node_modules', ...pkg.split('/'), 'package.json'),
  ]
  for (const file of candidates) {
    try {
      // realpath: every @deepseek-ai entry under profiles/node_modules is a symlink.
      const resolved = fs.realpathSync(file)
      const version = JSON.parse(fs.readFileSync(resolved, 'utf8')).version
      if (typeof version === 'string' && version) return { version, source: file }
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** JSON string-body escaping, for values substituted into a .json template. */
function jsonEscape(value) {
  const quoted = JSON.stringify(String(value))
  return quoted.slice(1, -1)
}

/**
 * Escaping for a value substituted INSIDE a single-quoted TypeScript string.
 * Free text (--description) reaches src/index.ts this way, so an apostrophe or a
 * backslash would otherwise emit source that does not parse.
 */
function tsEscape(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '')
    .replace(/\n/g, ' ')
}

/** Escaping for a value substituted into a double-quoted YAML scalar. */
function yamlEscape(value) {
  return jsonEscape(value)
}

/** Pick the escaper by OUTPUT file type, not by template name. */
function escaperFor(outPath) {
  if (outPath.endsWith('.json')) return jsonEscape
  if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(outPath)) return tsEscape
  if (/\.ya?ml$/.test(outPath)) return yamlEscape
  return (v) => String(v)
}

function substitute(content, map, outPath) {
  const escape = escaperFor(outPath)
  let out = content
  for (const [placeholder, value] of Object.entries(map)) {
    out = out.split(placeholder).join(escape(value))
  }
  return out
}

function walk(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, acc)
    else if (entry.isFile() && entry.name.endsWith('.tmpl')) acc.push(path.relative(base, full))
  }
  return acc
}

/** scaffold/gitignore.tmpl -> .gitignore ; scaffold/src/index.ts.tmpl -> src/index.ts */
function targetName(relTemplatePath) {
  const stripped = relTemplatePath.replace(/\.tmpl$/, '')
  const dir = path.dirname(stripped)
  const base = path.basename(stripped)
  const renamed = base === 'gitignore' ? '.gitignore' : base
  return dir === '.' ? renamed : path.join(dir, renamed)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || opts._.length === 0) {
    console.log(USAGE)
    process.exit(opts.help ? 0 : 1)
  }
  if (opts._.length > 1) die(`unexpected extra argument "${opts._[1]}"`)

  const pluginName = opts._[0]
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pluginName)) {
    die(`"${pluginName}" is not a valid package name (lowercase, kebab-case, no scope)`)
  }
  if (!pluginName.startsWith('dsh-')) {
    console.warn(
      `scaffold: warning: out-of-tree plugin packages are conventionally named "dsh-<name>" ` +
        `(got "${pluginName}")`,
    )
  }

  const pluginId = opts.id || pluginName.replace(/^dsh-/, '')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pluginId)) die(`row id "${pluginId}" must be short kebab-case`)

  const toolName = opts.tool || `${pluginId.replace(/-/g, '_')}_transform`
  if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
    die(`tool name "${toolName}" must be lower_snake_case`)
  }
  if (toolName === 'run_code') die('"run_code" is a reserved tool name and always fails to register')

  const description = opts.description || `DeepSeek Harness plugin: ${pluginName}.`
  const targetDir = path.resolve(opts.dir, pluginName)

  if (fs.existsSync(targetDir) && !opts.force) {
    die(`${targetDir} already exists (pass --force to overwrite)`)
  }

  // --- resolve versions from the live install -------------------------------
  const versions = {}
  let drifted = false
  for (const [placeholder, pkg] of Object.entries(HARNESS_PACKAGES)) {
    const found = readInstalledVersion(pkg, opts.profile)
    if (found) {
      versions[placeholder] = `^${found.version}`
    } else {
      drifted = true
      versions[placeholder] = '*'
      console.warn(
        `scaffold: WARNING: ${pkg} not found under profile "${opts.profile}" ` +
          `(${dshHome()}/profiles) -- pinning to "*".\n` +
          `scaffold:          "*" resolves the npm "latest" dist-tag, which for ` +
          `@deepseek-ai/dsh-tools is an OLDER, incompatible API line.\n` +
          `scaffold:          Fix the version by hand before building.`,
      )
    }
  }
  for (const [placeholder, spec] of Object.entries(TOOLCHAIN_DEFAULTS)) {
    const found = readInstalledVersion(spec.pkg, opts.profile)
    versions[placeholder] = found ? `^${found.version}` : spec.fallback
  }

  const map = {
    __PLUGIN_NAME__: pluginName,
    __PLUGIN_ID__: pluginId,
    __TOOL_NAME__: toolName,
    __DESCRIPTION__: description,
    ...versions,
  }

  // --- render ---------------------------------------------------------------
  const templates = walk(SCAFFOLD_DIR).sort()
  if (templates.length === 0) die(`no *.tmpl files found in ${SCAFFOLD_DIR}`)

  const written = []
  for (const rel of templates) {
    const outRel = targetName(rel)
    const outPath = path.join(targetDir, outRel)
    const raw = fs.readFileSync(path.join(SCAFFOLD_DIR, rel), 'utf8')
    const rendered = substitute(raw, map, outPath)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, rendered)
    written.push(outRel)
  }

  // Fail loudly rather than shipping a package.json that npm will reject.
  const manifestPath = path.join(targetDir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    die(`generated package.json is not valid JSON: ${err.message}`)
  }
  if (manifest.dsh?.bundle?.patch === undefined) {
    die('generated package.json is missing dsh.bundle.patch (the bundle declaration)')
  }

  // --- report ---------------------------------------------------------------
  console.log(`\nCreated ${targetDir}`)
  for (const rel of written) console.log(`  ${rel}`)
  console.log(`\n  package  ${pluginName}`)
  console.log(`  row id   ${pluginId}          (cordis.patch.yml / patch overrides target this)`)
  console.log(`  tool     ${toolName}`)
  console.log(`  profile  ${opts.profile}`)
  console.log('\n  pinned devDependencies:')
  for (const [placeholder, pkg] of Object.entries(HARNESS_PACKAGES)) {
    console.log(`    ${pkg.padEnd(28)} ${versions[placeholder]}`)
  }
  if (drifted) {
    console.log('\n  !! at least one harness version could not be read from the profile.')
    console.log('  !! edit devDependencies by hand before building.')
  }

  const relative = path.relative(process.cwd(), targetDir)
  const rel = !relative ? '.' : relative.startsWith('..') ? targetDir : relative
  const dsh = `node ${path.join(dshHome(), 'profiles/node_modules/@deepseek-ai/dsh/lib/bin.js')}`
  const verify = path.join(HERE, 'verify.mjs')

  console.log(`
Next:

  cd ${rel}
  npm install
  npm run build                       # rebuild after EVERY source edit (installs are symlinks)
  npm test

  node ${verify} ${targetDir} --profile ${opts.profile}

  cd ${path.resolve(opts.dir)}
  ${dsh} plugin --profile ${opts.profile} add -w ./${pluginName}     # -w is MANDATORY for add
  ${dsh} --profile ${opts.profile} --dump-config | grep -A6 '${pluginName}'

To remove it again:

  ${dsh} plugin --profile ${opts.profile} remove ${pluginName}
`)
}

main()
