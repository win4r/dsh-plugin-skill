# [🚀观看我的哔哩哔哩视频](https://space.bilibili.com/3493277319825652)

# dsh-plugin — DeepSeek Harness (DSH) Plugin Development Skill

A comprehensive Claude Code / Codex skill for scaffolding, building, installing, verifying, and debugging **[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)** plugins.

DeepSeek Harness plugins are built on the **Cordis** microkernel architecture: ES modules exporting `apply(ctx, config)` and declaring `dsh.bundle.patch` so `dsh plugin add` automatically wires them into the profile layer stack.

---

## 🚀 Capabilities

- **Automated Scaffolding**: Fast template generation (`scaffold.mjs`) with live dependency version pinning directly from installed profiles (ensures compatibility with Cordis 4.0.1, Schemastery 3.18.1, `@deepseek-ai/dsh-tools`, etc.).
- **Pre-flight Conformance Verification**: Verification tool (`verify.mjs`) checking bundle manifests, Schemastery schema declarations, bundle patch syntax, and tool definitions before installing into a profile.
- **Deep Reference Guides**:
  - `plugin-anatomy.md`: Plugin structure, `apply(ctx, config)`, lifecycle, and `ctx.effect()`.
  - `tools.md`: Standard schema, tool execution context, concurrency safety, and tool rendering.
  - `services-and-events.md`: Harness event hooks (`tools/pre-execute`, `agent/pre-step`, etc.) and Cordis service definitions.
  - `install-and-verify.md`: Step-by-step profile installation, bundle patch resolution, and troubleshooting.
  - `pitfalls.md`: Known edge cases, reserved tool names, and common mistakes.

---

## 📁 Repository Structure

```
dsh-plugin/
├── SKILL.md                 # Main skill definition & guide
├── references/              # Detailed architectural guides
│   ├── install-and-verify.md
│   ├── pitfalls.md
│   ├── plugin-anatomy.md
│   ├── services-and-events.md
│   └── tools.md
├── scaffold/                # Plugin template files (.tmpl)
│   ├── cordis.patch.yml.tmpl
│   ├── gitignore.tmpl
│   ├── package.json.tmpl
│   ├── README.md.tmpl
│   ├── src/
│   │   ├── config.ts.tmpl
│   │   └── index.ts.tmpl
│   ├── test/
│   │   └── logic.test.mjs.tmpl
│   └── tsconfig.json.tmpl
└── scripts/
    ├── scaffold.mjs         # CLI tool to scaffold new DSH plugins
    └── verify.mjs           # Zero-dependency plugin validator
```

---

## 🛠️ Quick Usage

### 1. Scaffold a New Plugin

```bash
node scripts/scaffold.mjs dsh-my-tool --dir ./projects --profile web
```

### 2. Build & Test

```bash
cd projects/dsh-my-tool
npm install
npm run build
npm test
```

### 3. Verify Before Installation

```bash
node scripts/verify.mjs ./projects/dsh-my-tool --profile web
```

### 4. Install into DSH Profile

```bash
dsh plugin --profile web add -w ./projects/dsh-my-tool
```

---

## 📜 License

MIT
