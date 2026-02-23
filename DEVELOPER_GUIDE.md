## Wallacy Smart Start - Developer Guide

### Quick Start for Development

#### 1. Build the Extension

```bash
npm run compile          # Single build
npm run watch           # Watch mode (recommended)
npm run package         # Production build
```

#### 2. Debug the Extension

1. Press `F5` in VS Code to start debugging
2. New VS Code window opens with the extension loaded
3. Open the "Continuous Test Runner" output channel to see logs

#### 3. Test the Smart Start Feature

**Minimal Test Setup**:

```typescript
// test/sample.test.ts
import { describe, it, expect } from "vitest";

describe("Sample", () => {
  it("should work", () => {
    expect(1 + 1).toBe(2);
  });
});
```

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
});
```

### Architecture Overview

```
┌─────────────────────────────────────────────────┐
│ VS Code Extension (src/extension.ts)            │
│ ┌───────────────────────────────────────────┐   │
│ │ SmartStartCommand                         │   │
│ │  • Execute smart start                    │   │
│ │  • Manage session state                   │   │
│ │  • Watch test files                       │   │
│ │  • Handle IPC messages                    │   │
│ └───────────────────────────────────────────┘   │
│ ┌───────────────────────────────────────────┐   │
│ │ SmartStartSession                         │   │
│ │  • Track current test file                │   │
│ │  • Config/framework state                 │   │
│ │  • Session lifecycle                      │   │
│ └───────────────────────────────────────────┘   │
│ ┌───────────────────────────────────────────┐   │
│ │ IPCClient                                 │   │
│ │  • WebSocket communication                │   │
│ │  • Message routing                        │   │
│ └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
         ↕ WebSocket (IPC Protocol)
┌─────────────────────────────────────────────────┐
│ Core Engine (src/core-engine/main.ts)           │
│ ┌───────────────────────────────────────────┐   │
│ │ IPCServer                                 │   │
│ │  • Handle smart-start-request             │   │
│ │  • Handle file-changed notification       │   │
│ │  • Broadcast results                      │   │
│ └───────────────────────────────────────────┘   │
│ ┌───────────────────────────────────────────┐   │
│ │ SmartStartResolver                        │   │
│ │  • Detect framework                       │   │
│ │  • Find config files                      │   │
│ │  • Resolve project info                   │   │
│ └───────────────────────────────────────────┘   │
│ ┌───────────────────────────────────────────┐   │
│ │ TestScheduler & Executor                  │   │
│ │  • Discover tests                         │   │
│ │  • Execute tests                          │   │
│ │  • Report results                         │   │
│ └───────────────────────────────────────────┘   │
│ ┌───────────────────────────────────────────┐   │
│ │ Test Adapters                             │   │
│ │  • VitestAdapter                          │   │
│ │  • JestAdapter                            │   │
│ │  • JasmineAdapter                         │   │
│ └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### File Structure

```
src/
├── extension.ts                      # Entry point
├── smart-start-command.ts            # Command handler (MODIFIED)
├── smart-start-session.ts            # Session management (NEW)
├── test-utils.ts                     # Test utilities (NEW)
├── ipc-client.ts                     # IPC client
├── core-engine/
│   ├── main.ts                       # Engine startup (MODIFIED)
│   ├── smart-start/
│   │   └── smart-start-resolver.ts   # Project/framework detection
│   ├── scheduler/
│   │   ├── executor.ts               # Test execution
│   │   ├── execution-queue.ts        # Task queue
│   │   └── test-scheduler.ts         # Schedule runner
│   ├── test-adapters/
│   │   ├── vitest/
│   │   ├── jest/
│   │   └── jasmine/
│   └── ...
└── shared-types/                     # Shared interfaces
```

### Key Data Flows

#### Starting a Test Session

```
Command Triggered
    ↓ SmartStartCommand.execute()
    ├─ Validate test file
    ├─ Initialize session
    └─ Send smart-start-request
        ↓ Core Engine processes
        ├─ Resolve project
        ├─ Detect framework
        ├─ Find config
        └─ Broadcast smart-start-response
            ↓ SmartStartCommand handles
            ├─ Store session state
            ├─ Setup file watcher
            ├─ Setup IPC handlers
            └─ Show discovery results
```

#### File Change Rerun

```
File saved (test file)
    ↓ File watcher detects
    ├─ Verify same config
    └─ Send file-changed
        ↓ Core Engine processes
        ├─ Scheduler runs tests
        └─ Broadcast results
            ↓ SmartStartCommand handles
            └─ Show updated results
```

### Debugging Tips

#### 1. Check Extension Logs

- Open "Continuous Test Runner" output channel
- Look for `[Extension]` prefixed messages
- Check for connection status messages

#### 2. Check Engine Logs

- Core engine runs as subprocess
- Logs appear in output channel with `[Core Engine]` prefix
- Check for framework detection and test discovery

#### 3. Common Issues

**Issue**: No output after triggering Smart Start

- Check: Is the file a .test.ts or .spec.ts file?
- Check: Is there a test framework config (vitest.config.ts, jest.config.ts)?
- Check: Are there errors in the output channel?

**Issue**: File watcher not triggering

- Check: Is the session still active?
- Check: Was initialization successful?
- Try: Close and reopen the extension

**Issue**: Framework not detected

- Check: Is a config file present in project?
- Check: Are framework dependencies in package.json?
- Try: Explicitly specify in Nx configuration

### IPC Message Types

#### Extension → Engine

```typescript
// Request to start smart testing
{
  type: 'smart-start-request',
  payload: { file: '/path/to/file.test.ts' }
}

// Notify of file change
{
  type: 'file-changed',
  payload: { filePath: '/path/to/file.test.ts' }
}

// Manual test run
{
  type: 'test-run-request',
  payload: { testIds: [...] }
}
```

#### Engine → Extension

```typescript
// Smart start resolution complete
{
  type: 'smart-start-response',
  payload: SmartStartResult
}

// Test discovery results
{
  type: 'test-discovery',
  payload: TestInfo[]
}

// Individual test result
{
  type: 'test-result',
  payload: TestResult
}

// Run complete
{
  type: 'test-run-complete',
  payload: { duration: number }
}

// Error occurred
{
  type: 'error',
  payload: { message: string }
}
```

### Running Tests

#### Unit Tests

```bash
npm run compile-tests
npm run test
```

#### Watch Tests

```bash
npm run watch-tests
```

### Troubleshooting Builds

#### TypeScript Errors

```bash
npm run check-types
```

#### ESLint Issues

```bash
npm run lint
# Fix automatically:
npm run lint -- --fix
```

#### Full Build

```bash
npm run package
```

### Extension Manifest

Key sections in `package.json`:

- `contributes.commands` - Register "wallacy.smartStart"
- `contributes.keybindings` - Ctrl+Shift+T binding
- `activationEvents` - When extension activates
- `main` - Entry point (dist/extension.js)

### Release Steps

1. Update version in package.json
2. Update CHANGELOG.md
3. Build: `npm run package`
4. Creates `.vsix` file for distribution
5. Install locally: VS Code → Extensions → Install from VSIX

### Performance Profiling

To profile the extension:

1. Run in debug mode (F5)
2. Open DevTools (Developer: Toggle DevTools)
3. Go to Performance tab
4. Record during Smart Start
5. Check for long-running operations

### Future Debugging

If adding new IPC messages:

1. Add message type to shared-types.ts
2. Add handler in SmartStartCommand
3. Log message receipt/processing
4. Test with various file types

## Support

For issues or feature requests, check:

- [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)
- [SMART_START.md](./SMART_START.md)
- Output channel logs
