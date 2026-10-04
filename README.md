# Sekai Code

A coding agent for your terminal, with a desktop companion. Read a project, make
focused changes, run commands, and review the results from `sekai`.

Requires **Node.js 22.19 or newer**. The CLI runs on Node directly and does not need
Electron or a graphical session.

## Install the CLI

With **Node.js 22.19 or newer** and npm installed, run this one-line installer
on Linux, macOS, or Windows (PowerShell):

```sh
npm install --global --omit=dev --ignore-scripts https://github.com/SEKAI-MIRROR/sekai-code/releases/latest/download/sekai-code.tgz
```

Then run `sekai --help` or `sekai login`. Run the same installer again to update.
The package comes from [GitHub Releases](https://github.com/SEKAI-MIRROR/sekai-code/releases)
and installs only the CLI and its runtime dependencies; Electron is not required.
npm supports installing packages directly from a
[tarball URL](https://docs.npmjs.com/cli/v11/commands/npm-install/).

If your global npm directory is not writable, use a user-local install on
Linux/macOS:

```sh
npm install --global --prefix "$HOME/.local" --omit=dev --ignore-scripts https://github.com/SEKAI-MIRROR/sekai-code/releases/latest/download/sekai-code.tgz && export PATH="$HOME/.local/bin:$PATH"
```

Add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file to keep
`sekai` available in new terminals. To pin a release, replace `latest/download`
with `download/cli-v1.3.0` in the URL. Each release includes `SHA256SUMS` for
verifying a manually downloaded package.

### Install from a checkout

```sh
npm ci --omit=dev
npm link --omit=dev --ignore-scripts
sekai --help
```

For a user-local install when the global npm prefix is not writable:

```sh
npm install --global --prefix "$HOME/.local" --omit=dev .
export PATH="$HOME/.local/bin:$PATH"
sekai --help
```

Or run it without installing a global command:

```sh
node cli/main.js --help
npm run cli -- --help
```

The npm package contains the CLI and model adapters, rather than the desktop UI.
`npm pack` builds an installable local package. Tagged CLI releases are published
to GitHub Releases; the package is not published to the npm registry.

## Connect to Sekai Gateway

**Sekai Gateway is the default provider**, using
`https://api.sekaigateway.xyz/v2` and the model `cx/gpt-5.6-sol`.
Login asks for your own SaaS API key without displaying it:

```sh
sekai login
sekai auth status
sekai models
sekai
```

`sekai login` checks the key against the model list before saving it, and selects
a model available to that account. To change models, use
`sekai config set model <model-id>` or `/model <model-id>` during chat.
For automation, supply `SEKAI_API_KEY`, or pipe a key from a secret manager into
`sekai login --key-stdin`. Keys are never embedded in source code or npm packages.
`sekai logout` removes the selected provider's local saved key; an environment
key remains active until you unset it.

OpenAI, Anthropic, and DeepSeek remain optional providers. Set `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, or `DEEPSEEK_API_KEY`, or use `sekai login --provider <name>`.
To select an optional provider manually:

```sh
sekai config set provider anthropic
sekai models
sekai config set model <model-id-from-the-list>
```

On PowerShell, set the gateway key using `$env:SEKAI_API_KEY = 'your-key'`.
Changing the saved provider clears the old model, endpoint, and effort defaults.
CLI authentication uses API keys; ChatGPT browser sign-in is currently a desktop
feature. No credentials are copied from another coding agent.

## Work in a project

```sh
sekai -C /path/to/project
sekai "Explain this repository"
sekai exec "Review this project and identify likely bugs"
sekai exec "Add a README example" --approval auto
cat task.txt | sekai exec - --approval auto
sekai exec "Summarize the architecture" --json
sekai sessions
sekai resume
sekai resume latest
sekai resume <session-id>
```

Interactive chat uses [Pi's TUI library](https://github.com/earendil-works/pi/tree/main/packages/tui)
and its fullscreen viewport, editor, working indicator, dark theme, and syntax
highlighting. The conversation scrolls independently while the multiline editor
and model/token footer stay fixed at the bottom. Streaming updates only changed
screen rows, including when older tool results change outside the viewport.
The compact welcome header sits just above the input, shows the current
permission mode (including YOLO), and disappears when the conversation begins.
Essential shortcuts fit on one line; `/help` shows the full list.
Use the mouse wheel or Page Up / Page Down to read history, and End to follow
new output. On exit, the fullscreen TUI closes and restores the previous terminal
screen, without printing the conversation or clearing terminal history.
Use `sekai resume` to pick a saved conversation, or `/resume` while chatting.
Search by title, project path, model, or session ID; Enter selects and Esc cancels.
The list shows parent sessions, newest first. `--plain` offers a numbered list.
`sekai resume latest` and `/resume latest` open the most recent parent session;
pass a full session ID to open a specific conversation, including a child session.
Resuming restores the project directory, messages, tool results, model, and usage.
CLI provider/model overrides still apply, and `--yolo` works with resume.
If no sessions exist, the CLI stays open for a new conversation.
File changes show a diff before approval; **Enter**
defaults to denying the action, and **y** allows it once.
Choose **Auto-approve session** to enable `full` mode for all remaining tools
and workers in the current CLI session. In `--plain` mode, type `full` at the
approval prompt. Use `/permissions ask` to restore confirmations.

| Shortcut | Action |
| --- | --- |
| Enter | Send a prompt; queue a follow-up while the agent is working |
| Shift+Enter / Ctrl+J | Insert a newline (Ctrl+J works on older terminals) |
| Tab | Complete commands and file paths |
| Up / Down | Browse prompt history at the edge of the editor |
| Ctrl+O | Expand or collapse tool output |
| Ctrl+T | Expand or collapse thinking text |
| Page Up / Page Down / mouse wheel | Scroll the conversation without moving the editor |
| End | Jump to the latest output and follow streaming |
| Esc | Stop the current task and clear queued prompts; cancel a picker |
| Ctrl+C | Stop a task, clear an idle draft, or exit with an empty editor |
| Ctrl+D | Exit with an empty editor |

Draft text is preserved while approving actions or choosing a model. Sessions
are saved as work progresses; resuming shows recent messages and tool results.
Use `sekai --plain` for the basic readline interface (end a line with `\` for
multiline input). Dumb terminals and redirected output use the basic interface
automatically. `sekai exec` and `--json` retain stream-friendly output.

| Command | Purpose |
| --- | --- |
| `/help` | Show interactive commands |
| `/model [id]` | Open the searchable model picker, or set an explicit ID |
| `/provider <name>` | Change provider and clear model/endpoint selection |
| `/permissions [ask\|auto\|full]` | Inspect or change permissions |
| `/resume [id\|latest]` | Pick or continue a saved conversation |
| `/status` | Show project, session, model, and token usage |
| `/agents` | Show sub-agent tasks, statuses, IDs, and token usage; available during generation in the TUI |
| `/diff` | Show unstaged and staged tracked-file changes |
| `/new` | Start a fresh conversation |
| `/q`, `/exit`, `/quit` | Exit |

The agent reads `AGENTS.md` from the working directory and its ancestors. Its
instructions also require checking for nested instructions before editing a
subdirectory. Available tools: `read_file`, `list_files`, `write_file`,
`edit_file`, `run_command`, `git`, and `fetch_url`.

## Delegate to sub-agents

The CLI can run independent tasks concurrently through `spawn_agent`,
`wait_agents`, `list_agents`, and `cancel_agent`. Ask for delegation in your prompt:

```sh
sekai "Use two sub-agents: one reviews the CLI, the other reviews provider adapters. Combine their findings."
sekai --max-agents 2
sekai config set maxAgents 3
```

Each worker gets a separate conversation and saved session, plus the parent
request and its assigned task. It inherits the parent's provider, model,
endpoint, and approval mode; Sekai Gateway remains the default. Workers share
the project directory, so assign separate files when editing. File writes,
shell commands, and Git operations are serialized across the agent team, and
approval dialogs are presented one at a time with the worker's name.

The default limit is **three active workers**; `--max-agents` accepts 0–8, with
0 disabling delegation. Each user turn can spawn at most four times that limit.
A worker may make up to 20 model calls, further limited by `--max-turns`, and
cannot spawn more workers. The parent collects reports before completing the
turn. Failed workers return an error report instead of silently disappearing.

Worker cards show live activity; `/agents` lists their IDs and status. **Esc**
stops the parent and all its workers. Completed edits remain on disk. Token
totals include worker usage. Child sessions carry a parent ID; `sekai sessions`
and `sekai resume latest` select parent conversations. An individual child can
be opened explicitly with `sekai resume <child-id>`. Saved running workers are
marked interrupted when the parent runs again; processes are not resumed in
the background.

## Permissions

| Mode | Behavior |
| --- | --- |
| `ask` (default) | Read project files; ask for writes, outside reads, shell, Git, and network tools |
| `auto` | Also allow project file writes; changes under `.git` or `.sekai` still ask |
| `full` | Run every tool without confirmation |

To skip confirmations for commands such as `run_command`, start with
`sekai --yolo` (equivalent to `sekai --approval full`), or enter
`/permissions full` in chat. To make this
the default for future launches, run `sekai config set approval full`.
`--yolo` also works with `sekai exec "task" --yolo` and `sekai resume --yolo`.
It overrides the saved approval mode for this invocation without changing
configuration. Combining it with an explicit `--approval ask` or `auto` is rejected.
The **Auto-approve session** dialog option changes only the running CLI;
it does not change saved configuration or grant permissions when resuming later.

File checks resolve symlinks, including dangling ones. Edit previews are followed
by a check that the file has not changed while waiting for approval. Commands
have timeouts, bounded output, and cancellation of their process group.

These permissions are an application approval policy, **not an OS sandbox**.
An approved shell or Git command has the same access as your user account.
Model API requests use the configured provider in every mode. Without an
interactive terminal, actions needing approval are denied and the denial is
returned to the agent. `--approval auto` is suitable for unattended file edits;
use `full` only when you intend to authorize all available tools.

## Configuration and automation

```sh
sekai config
sekai config set approval auto
sekai config set maxTurns 60
sekai --provider openai --model <id> --base-url https://your-endpoint.example/v1
```

Options override saved configuration. Supported defaults: `provider`, `model`,
`approval`, `maxTurns`, `baseUrl`, and `effort`. Sekai Gateway uses
`/chat/completions` and `/models` under `/v2`, including streamed function calls.
It has its own adapter, without DeepSeek-specific request options. Requests never
fall back to a direct upstream provider. Optional OpenAI endpoints must support
Responses; DeepSeek uses Chat Completions, and Anthropic uses Messages.
`sekai models` lists the selected endpoint's available models.

`sekai exec --json` writes one JSON event per line to stdout: `turn_start`,
`request_start`, `request_end`, `content`, `reasoning` (when supplied), `tool_start`, `tool_end`, `usage`,
`turn_end`, or `error`. Human tool
activity goes to stderr in ordinary text mode, leaving streamed answer text on
stdout. Exit status is `0` for a completed agent turn, `1` for a CLI/provider
failure or turn limit, and `130` for cancellation. A denied tool or failed shell
command is reported as a tool result; inspect those results when automating.

State is stored under `~/.sekai`, or the directory specified by `SEKAI_HOME`:

- `config.json`: defaults, without API keys.
- `credentials.json`: keys explicitly saved by login, bound to their API origin.
- `sessions/<id>.json`: conversation, tool results, project path, and usage.

State files are written atomically with mode `0600`, in directories created with
mode `0700` where supported. Prompts and tool outputs can contain sensitive
project data; sessions and the CLI credential file are not encrypted. Environment
API keys take precedence over saved credentials. A saved key is not sent to a
different API origin after `--base-url` changes; login to that endpoint explicitly
or supply an environment key. Keys are not written into session configuration.
Resume reuses conversation context,
while permissions and endpoint selection come from the current invocation.

## Desktop companion

```sh
npm ci
npm start
```

The desktop app uses the Sekai Code name, a new bracket logo, a mint workbench
theme, and a static welcome screen. It retains the original desktop agent's
browser, attachments, rich rendering, and provider settings. Sekai Gateway is
first in provider settings and is the default for new chats. A desktop without
its own gateway key can use `SEKAI_API_KEY` or a CLI login for the default gateway
origin. Clearing the desktop key prevents automatic reimport on the next launch;
an explicitly set environment key still takes precedence. CLI and desktop have
separate sessions and model preferences. The renamed desktop app uses a
new application identity and does not automatically migrate original app data.

Build on the target platform:

```sh
npm run dist        # Windows installer
npm run dist:mac    # macOS DMG
npm run dist:linux  # Linux tarball
```

Artifacts are written to `dist/Sekai-Code-*`. Linux's desktop executable is named
`sekai-code`; the terminal command is `sekai`.

## Development and validation

```sh
npm run check
npm test
python3 test/tui-pty.py
python3 test/subagents-pty.py
python3 test/resume-pty.py
```

### GitHub Actions builds and releases

The [CLI build and release workflow](https://github.com/SEKAI-MIRROR/sekai-code/actions/workflows/cli.yml)
runs on pushes, pull requests, and manual dispatches. It checks syntax, runs the
Node.js tests and all three PTY suites on Node.js 22 and 24, then builds the
`sekai-cli` artifact containing `sekai-code.tgz` and `SHA256SUMS`. The packaged
CLI is installed and smoke-tested on Linux, macOS, and Windows with both Node.js
versions, including loading the TUI without Electron.

To publish a CLI release, update `version` in `package.json` and
`package-lock.json`, commit the changes, and push a matching `cli-v` tag:

```sh
git tag cli-v1.3.0
git push origin main cli-v1.3.0
```

Use a new version/tag for each subsequent release. The tag must match
`package.json`. After all checks and installation tests pass, the workflow
publishes a GitHub Release and the one-line installer picks it up automatically.
Publishing uses the repository's `GITHUB_TOKEN`; no npm token is needed.
Ordinary branch builds only upload workflow artifacts. Desktop builds remain
in the separate Build workflow.

The CLI modules separate terminal I/O, the agent loop, tools, configuration, and
provider transport. Sekai Gateway, OpenAI, and Anthropic share transport adapters
with the desktop application.
Tests use local mock provider streams and temporary projects, without paid API
calls, and cover real file edits, tool approvals, cancellation, session history,
JSONL automation, and provider failures.

Current CLI limits: text input/output, no embedded browser, no image/PDF tools,
and no automatic context compaction. Long sessions may need `/new` when the
provider's context window is reached. `--max-turns` caps model calls per task.

## Attribution

Derived from OpenGhost's source code, copyright (c) 2026 Andrew. This is an
independent modification. Original copyright and license terms remain in
[LICENSE](LICENSE); see [NOTICE](NOTICE) for attribution and asset notes.
