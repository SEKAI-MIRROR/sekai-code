# Repository Guidelines

## Project Structure & Module Organization

Sekai Code combines a Node.js CLI and an Electron desktop application.

- `cli/`: command parsing, authentication, sessions, agent loop, tools, and terminal UI. `cli/main.js` provides the `sekai` command; `cli/tui.mjs` handles interactive rendering.
- `cli/config.js`: configuration, origin-bound credentials, and persisted sessions. `cli/resume.js` handles session selection and prepares restored conversation settings.
- `cli/agent.js` coordinates tool execution and approvals; `cli/subagents.js` manages workers sharing the project directory. `cli/terminal.js` provides the plain readline and JSONL interfaces.
- `cli/pi/`: adapted upstream Pi components, theme, and highlighting utilities. Preserve attribution in `NOTICE`.
- `desktop/`: Electron main/preload code and provider adapters, including the shared Sekai Gateway adapter in `desktop/sekai.js`.
- Root JavaScript, HTML, and CSS files implement the desktop renderer. `images/` and `desktop/icon.*` contain assets.
- `test/` contains automated tests; `scripts/` contains validation helpers. Generated packages belong in ignored `dist/`.

## Build, Test, and Development Commands

Use Node.js **22.19 or newer**.

- `npm ci`: install locked dependencies. Use `npm ci --omit=dev` for CLI-only work.
- `npm run cli -- --help`: inspect CLI commands; `npm run cli` opens interactive chat.
- `npm run cli -- --yolo`: open chat with all tools approved for this invocation.
- `npm run cli -- resume`: choose a saved conversation; append `latest` or a full session ID to resume directly. Add `--yolo` to resume without tool confirmations.
- `npm start`: launch the Electron desktop application.
- `npm run check`: syntax-check JavaScript and ES modules.
- `npm test`: run the Node.js test suite.
- `python3 test/tui-pty.py`: exercise startup, approvals, streaming, resize, cancellation, and shell restoration in a pseudo-terminal on Linux/macOS.
- `python3 test/subagents-pty.py`: verify concurrent workers, serialized approvals, and worker cancellation.
- `python3 test/resume-pty.py`: verify session selection, restored context, project switching, YOLO, and plain-mode resume.
- `npm pack --dry-run`: inspect CLI package contents.
- `npm run dist`, `npm run dist:mac`, `npm run dist:linux`: build desktop packages without publishing.

## Coding Style & Naming Conventions

Follow nearby code: handwritten JavaScript generally uses one-space indentation, single quotes, and semicolons. Use CommonJS in Node `.js` modules and ES modules in `.mjs` files. Preserve upstream formatting in `cli/pi/`. Prefer descriptive kebab-case filenames, camelCase functions, and PascalCase classes. No formatter or lint configuration is enforced; `npm run check` checks syntax only.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`, with filenames such as `test/gateway.test.js`. Use temporary directories, mock providers, and isolated `SEKAI_HOME` state. No coverage threshold is configured. Add behavioral regression tests for bugs; run relevant tests and required CI checks. For TUI changes, verify streaming, resize, cancellation, and exit restoring the shell without printing editor/footer remnants.

CLI CI runs syntax checks, the full Node.js suite, all three PTY scripts, CLI help, and `npm pack --dry-run` on Node.js 22 and 24. Keep session and approval tests independent of real provider accounts. Optional terminal captures use `SEKAI_TUI_CAPTURE` or `SEKAI_RESUME_CAPTURE`; save captures outside tracked source files.

## CLI Behavior to Preserve

- Approval modes are `ask` (default), `auto` (project file edits), and `full` (all tools). `auto` still requires approval for shell, Git, network, external paths, and changes under `.git` or `.sekai`. `--yolo` is an alias for `--approval full`; reject conflicting explicit approval modes.
- **Auto-approve session** enables `full` for the running CLI and its workers without modifying saved configuration. `/permissions ask` restores confirmations. Keep approvals serialized across workers, default dialogs to deny, and ensure cancellation cannot enable auto-approval.
- `sekai resume` and `/resume` open a searchable parent-session picker, newest first. `latest` resumes the newest parent; a full ID can open a specific parent or child. Plain mode offers a numbered list. Cancellation leaves the current conversation intact.
- Resume restores messages, tool results, usage, project directory, and saved provider/model unless overridden by CLI flags. Permissions, credentials, and endpoints come from the current invocation. Validate the session and project directory before replacing active state; update file completion and Git branch context when switching projects.
- Keep the welcome header compact and responsive above the input, with an ASK/AUTO/YOLO indicator. It disappears when the transcript has content. Keep full keyboard help in `/help`, the editor and footer fixed at the bottom, and streaming updates limited to changed rows.

## Commit & Pull Request Guidelines

History uses imperative subjects, such as “Never publish from a build,” without mandatory Conventional Commit prefixes. Keep changes focused. PR descriptions should explain the problem, resulting behavior, and validation; link issues and include screenshots or terminal captures for visual changes.

## Security & Configuration

Sekai Gateway is the default provider. Use `sekai login` or `SEKAI_API_KEY`; never commit credentials, session transcripts, or real keys in fixtures. Preserve origin-bound credential handling and tool approval checks. Retain `LICENSE` and `NOTICE` when distributing adaptations.
