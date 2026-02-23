## Wallacy - Continuous Test Runner for VS Code

Wallacy is a VS Code extension inspired by Wallaby.js that provides continuous test running capabilities with smart test detection and framework support.

### Features

- **Smart Start**: Automatically detects test files and runs their tests continuously
- **Framework Support**: Works with Vitest (primary), Jest, and Jasmine
- **Automatic Framework Detection**: Detects your test framework from configuration files or dependencies
- **File Watching**: Automatically reruns tests when test files are saved
- **Same Config Tracking**: Ensures tests only rerun if they share the same configuration
- **Real-time Feedback**: Shows test results in the output panel as they come in

### Usage

#### Starting Smart Start

1. Open a test file in VS Code (files ending with `.test.ts`, `.spec.ts`, etc.)
2. Press `Ctrl+Shift+T` (or `Cmd+Shift+T` on Mac) or run the command "Wallacy: Smart Start"
3. The extension will automatically:
   - Detect the test framework (Vitest, Jest, or Jasmine)
   - Find the configuration file (vitest.config.ts, jest.config.ts, etc.)
   - Start running the tests
   - Watch for file changes and rerun tests automatically

#### Stopping Smart Start

- Run the command "Wallacy: Stop Engine" to stop the continuous test runner

### Configuration

The extension automatically detects your test configuration from:

1. **Nx Project Configuration** - if using Nx monorepo
2. **Test Config Files** - looks for:
   - `vitest.config.ts`, `vitest.config.js`, `vite.config.ts`
   - `jest.config.ts`, `jest.config.js`, `jest.config.json`
   - `jasmine.json`
3. **Package.json Dependencies** - detects based on installed packages
4. **TypeScript Config** - uses `tsconfig.json` for proper import resolution

### Architecture

The extension is built with a client-server architecture:

- **Extension (Client)**: Runs in VS Code process, handles UI and file watching
- **Core Engine (Server)**: Runs as a separate process, handles test execution
  - Supports Vitest, Jest, and Jasmine adapters
  - Manages test scheduling and execution
  - Provides real-time test results via WebSocket IPC

### Keyboard Shortcuts

- `Ctrl+Shift+T` (Windows/Linux) or `Cmd+Shift+T` (Mac): Start Smart Start
- Available in TypeScript/JavaScript file editors

### Output Channel

The extension provides detailed logging in the "Continuous Test Runner" output channel, showing:

- Engine initialization status
- Connection progress
- Test discovery results
- Individual test results
- File change notifications
- Errors and diagnostics

### Implementation Details

#### New Files

- `src/test-utils.ts` - Utility functions for test file detection
- `src/smart-start-session.ts` - State management for test sessions
- Enhanced `src/smart-start-command.ts` - Command implementation with IPC handlers

#### Modified Files

- `src/core-engine/main.ts` - Added file-changed message handler
- `package.json` - Added keybindings

### Known Limitations

- Currently focuses on single-file testing through Smart Start
- Test framework detection relies on config files or dependencies
- Requires a workspace folder to be open
- Works best with TypeScript test files

### Future Enhancements

- [ ] Multi-file test session management
- [ ] Coverage reporting in editor
- [ ] Test filtering by pattern
- [ ] Performance metrics
- [ ] Failed test debugging information
