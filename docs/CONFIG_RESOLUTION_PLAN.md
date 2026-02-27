# Config Resolution Plan — tsconfig & Test Config Discovery

## Problem Statement

When a user opens a test file in their editor and triggers Smart Start, we need to:

1. **Find the closest `tsconfig.json`** — to resolve TypeScript path aliases (`paths` in `compilerOptions`)
2. **Find the closest test framework config** — `vitest.config.ts`, `jest.config.ts`, or `jasmine.json`
3. **Use both** to determine which adapter to use and how to resolve imports

This runs in the **user's workspace** (not this repo), targeting **Nx monorepos** and **single TS projects**.

---

## Gap Analysis

### Gap 1: No tsconfig Resolution

**Current state:** The codebase has no concept of finding or parsing `tsconfig.json`. Path aliases (`@shared/*`, `@app/*`, etc.) are invisible.

**Impact:** Without resolving `paths` from tsconfig, any import like `import { foo } from '@shared/utils'` will fail during static analysis and dependency graph building.

**Solution:** Create a `TsconfigResolver` that walks up from the active file to find the nearest `tsconfig.json`, then parses `compilerOptions.paths` and `baseUrl` to build a path alias map.

### Gap 2: Config Search is Project-Root Only

**Current state:** `SmartStartResolver.resolveConfigPath()` only checks the Nx project root for config files. In Nx workspaces, a library under `libs/my-lib` may inherit a `vitest.config.ts` from the workspace root or an intermediate directory.

**Impact:** Test config files at workspace root (common in Nx with `vitest.workspace.ts`) or shared config files are missed.

**Solution:** Walk up the directory tree from the file → project root → workspace root, checking each level for config files. Also handle `vitest.workspace.ts` / `vitest.workspace.js` patterns.

### Gap 3: No tsconfig Path Alias Map for Adapters

**Current state:** When the adapter runs tests, it doesn't pass tsconfig path information. Vitest resolves paths via its own `resolve.alias` config; Jest uses `moduleNameMapper`. Neither is being read.

**Impact:** If the test framework config references a tsconfig for path resolution (e.g., `vitest.config.ts` with `vite-tsconfig-paths` plugin, or `jest.config.ts` with `pathsToModuleNameMapper`), we need to know the tsconfig location to pass it correctly.

**Solution:** Include `tsconfigPath` in `SmartStartResult` so adapters and the dependency graph can use it.

### Gap 4: Non-Nx Single Project Fallback is Fragile

**Current state:** `FileToProjectMapper.discoverProjectFromFileSystem()` creates a synthetic `NxProjectInfo` with a hardcoded `"vitest:test"` executor, which biases framework detection.

**Impact:** A Jest-only project gets detected as Vitest because the synthetic project has a Vitest executor.

**Solution:** Create the synthetic project with an empty/neutral executor. Let the framework detection pipeline (`detectFromConfigFiles`, `detectFromDependencies`) handle it.

### Gap 5: Duplicate Framework Detection Logic

**Current state:** Framework detection exists in three places:

- `SmartStartResolver.detectFramework()`
- `AdapterAutoDetector.detectFramework()`
- `TestExecutor.getAdapterForProject()`

**Impact:** Inconsistent detection results, maintenance burden.

**Solution:** Consolidate into a single `FrameworkDetector` class used by all consumers.

### Gap 6: No Integration Tests

**Current state:** Only a trivial VS Code extension test exists. No tests exercise the resolution pipeline against real file system structures.

**Impact:** Impossible to verify correctness of tsconfig discovery, config resolution, framework detection across different project layouts.

**Solution:** Create integration tests with mock file system fixtures representing:

- Nx monorepo with multiple projects (vitest + jest mixed)
- Single TS project with vitest
- Single TS project with jest
- Nested tsconfig with path aliases

---

## Architecture

### New: `TsconfigResolver`

```
src/core-engine/config/tsconfig-resolver.ts
```

Responsibilities:

- Walk up directory tree from a file to find the nearest `tsconfig.json`
- Parse `compilerOptions.paths` and `baseUrl`
- Handle `extends` chains (tsconfig can extend another tsconfig)
- Handle tsconfig project references
- Return a `TsconfigInfo` object

### New: `TestConfigResolver`

```
src/core-engine/config/test-config-resolver.ts
```

Responsibilities:

- Walk up directory tree from a file to find the nearest test framework config
- Support vitest.config.ts, jest.config.ts, jasmine.json
- Support vitest.workspace.ts (Nx pattern)
- Return the config path and detected framework

### Updated: `SmartStartResult`

Add `tsconfigPath: string | null` field so downstream consumers know which tsconfig applies.

### Updated: `SmartStartResolver`

Use `TsconfigResolver` and `TestConfigResolver` instead of inline logic.

---

## File System Layouts to Support

### Nx Monorepo (typical)

```
workspace-root/
├── nx.json
├── tsconfig.base.json          ← base paths
├── vitest.workspace.ts         ← optional
├── apps/
│   └── my-app/
│       ├── tsconfig.json       ← extends ../../tsconfig.base.json
│       ├── vitest.config.ts
│       └── src/
│           └── app.spec.ts     ← ACTIVE FILE
└── libs/
    └── shared/
        ├── tsconfig.json
        ├── vitest.config.ts
        └── src/
            └── utils.spec.ts
```

### Single TS Project

```
project-root/
├── package.json
├── tsconfig.json               ← paths here
├── vitest.config.ts            ← or jest.config.ts
└── src/
    ├── utils/
    │   └── helpers.ts
    └── __tests__/
        └── helpers.spec.ts     ← ACTIVE FILE
```

### Nx Monorepo (Jest)

```
workspace-root/
├── nx.json
├── tsconfig.base.json
├── jest.preset.js
├── apps/
│   └── api/
│       ├── tsconfig.json
│       ├── jest.config.ts      ← uses pathsToModuleNameMapper
│       └── src/
│           └── app.spec.ts
```

---

## Implementation Order

1. **`TsconfigResolver`** — find & parse tsconfig, resolve path aliases
2. **`TestConfigResolver`** — find test framework config by walking up dirs
3. **Update `SmartStartResult`** — add `tsconfigPath` field
4. **Update `SmartStartResolver`** — use new resolvers
5. **Fix synthetic project in `FileToProjectMapper`** — remove biased executor
6. **Integration tests** — mock file system fixtures for all layouts
7. **Consolidate framework detection** — single `FrameworkDetector` class
