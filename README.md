# Sekai CLI

A terminal coding agent powered by [Sekai Gateway](https://sekaigateway.xyz/).
Explore a project, edit files, run commands, and continue saved conversations
with `sekai`.

Sekai Gateway is the default AI provider for Sekai CLI. The service gives you
access to models from OpenAI, Anthropic, Google, and DeepSeek through one API,
with Coding Plans or pay-as-you-go billing in Indonesian rupiah and PAYG top-ups
via QRIS.

[Website](https://sekaigateway.xyz/) · [Models & pricing](https://sekaigateway.xyz/id/models) · [API documentation](https://sekaigateway.xyz/id/docs)

Requires **Node.js 22.19+** and npm. Runs on Linux, macOS, and Windows.

## Install the CLI

### From a release

Install the latest release on Linux, macOS, or Windows (PowerShell):

```sh
npm install --global --ignore-scripts https://github.com/SEKAI-MIRROR/sekai-code/releases/latest/download/sekai-code.tgz
```

Then run `sekai --help` or `sekai login`. Run the installer again to update.
No GitHub account or GitHub CLI is required. Packages and checksums are available in
[GitHub Releases](https://github.com/SEKAI-MIRROR/sekai-code/releases).

### From source

From a checkout of this repository:

```sh
npm ci
npm link --ignore-scripts
sekai --help
```

To run directly from the checkout, use `npm start` or `npm start -- --help`.
If the global npm directory is not writable on Linux/macOS, install locally:

```sh
npm install --global --prefix "$HOME/.local" --ignore-scripts .
export PATH="$HOME/.local/bin:$PATH"
```

Add the `export` line to your shell startup file to keep `sekai` on your PATH.

## Quick start

Create an account at [Sekai Gateway](https://sekaigateway.xyz/id/register),
choose a Coding Plan or fund your PAYG balance, and create an
[API key](https://sekaigateway.xyz/id/api-key). Then connect the CLI:

```sh
sekai login
sekai models
sekai -C /path/to/project
```

The CLI connects to `https://api.sekaigateway.xyz/v2` by default.
`sekai login` prompts for your Sekai Gateway API key, verifies it, and selects
an available model. `sekai models` lists the models available to your account;
use `/model` during chat to choose another model.

For automation, set `SEKAI_API_KEY` or pipe a key into `sekai login --key-stdin`.
Use `sekai auth status` to check authentication and `sekai logout` to remove the
saved key. Environment keys remain active until unset.

## Usage

```sh
sekai "Explain this repository"
sekai exec "Add tests for the parser" --approval auto
cat task.txt | sekai exec - --approval auto
sekai exec "Summarize the architecture" --json
```

Interactive chat supports multiline input, file completion, streaming responses,
and tool diffs. Use `sekai --plain` for a basic readline interface.
Run `sekai --help` for all command-line options.

### Sessions

```sh
sekai sessions
sekai resume
sekai resume latest
sekai resume <session-id>
```

Resume restores the conversation, project directory, model, and usage.
Permissions and endpoints come from the current invocation; explicit provider
and model flags override saved settings. Use `/resume` to switch sessions in chat.

### Interactive commands

| Command | Action |
| --- | --- |
| `/help` | Show commands and keyboard shortcuts |
| `/model [id]` | Choose or change the model |
| `/provider <name>` | Switch provider |
| `/permissions [mode]` | View or change approvals |
| `/resume [id\|latest]` | Continue a saved conversation |
| `/status` | Show project, session, model, and usage |
| `/agents` | Show worker tasks and status |
| `/diff` | Show tracked Git changes |
| `/new` | Start a fresh conversation |
| `/q` | Save and exit |

**Enter** sends a prompt; **Shift+Enter / Ctrl+J** inserts a newline.
**Tab** completes commands and paths. **Esc** stops a task.
**Ctrl+O** toggles tool output; **Ctrl+T** toggles thinking text.

### Sub-agents

Ask Sekai to delegate independent tasks:

```sh
sekai --max-agents 2 "Use two sub-agents: one reviews the CLI, the other reviews provider adapters. Combine their findings."
```

Workers share the project directory and inherit the parent's provider and
permissions. Approvals are serialized. `/agents` shows progress; **Esc** stops
the parent and its workers. The default limit is three workers; `--max-agents 0`
disables delegation.

## Permissions

| Mode | Behavior |
| --- | --- |
| `ask` (default) | Read project files; ask before writes, outside reads, shell, Git, and network tools |
| `auto` | Also allow project file edits; external paths, `.git`, and `.sekai` still require approval |
| `full` | Allow all tools without confirmation |

```sh
sekai --approval auto
sekai --yolo
```

`--yolo` is an alias for `--approval full` for the current invocation.
The **Auto-approve session** dialog option enables the same mode for the running
session and its workers. Use `/permissions ask` to restore confirmations.

These modes are application approvals, not an OS sandbox. Without an interactive
terminal, actions requiring approval are denied. Model API requests use the
configured provider in every mode.

## Configuration

```sh
sekai config
sekai config set model <model-id>
sekai config set approval auto
sekai config set maxTurns 60
```

Command-line flags override saved defaults. Available providers:

| Provider | Environment variable |
| --- | --- |
| [Sekai Gateway](https://sekaigateway.xyz/) (default) | `SEKAI_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

Use `sekai login --provider <name>` to connect to another provider, or
`sekai --provider <name> --model <id>` for a single invocation.
Use `--base-url <url>` for a custom endpoint.

State is stored in `~/.sekai`, or the directory set by `SEKAI_HOME`:

- `config.json` — defaults.
- `credentials.json` — saved API keys, bound to their API origin.
- `sessions/` — conversations, tool results, project paths, and usage.

Environment keys take precedence over saved keys. Credentials and sessions are
stored locally without encryption; keys are excluded from session settings.

For scripts, `sekai exec --json` emits JSONL events. Exit codes are `0` for a
completed turn, `1` for an error or turn limit, and `130` for cancellation.
Denied or failed tools appear in tool results; inspect those when automating.

## Development

```text
cli/               Commands, agent loop, tools, sessions, and terminal UI
  adapters/        Sekai Gateway, OpenAI, and Anthropic transports
  pi/              Adapted Pi terminal components and theme
scripts/           Source validation
test/              Unit and terminal integration tests
archive/desktop/   Archived Electron application
```

```sh
npm ci
npm run check
npm test
python3 test/tui-pty.py
python3 test/subagents-pty.py
python3 test/resume-pty.py
npm pack --dry-run
```

Tests use mock providers and temporary projects. PTY tests run on Linux/macOS.
See [AGENTS.md](AGENTS.md) for contribution guidelines and
[the desktop archive](archive/desktop/README.md) for historical desktop code.
The archive has separate dependencies and is excluded from the CLI package.

The [CI workflow](.github/workflows/cli.yml) validates Node.js 22 and 24 and tests
package installation on Linux, macOS, and Windows. To release, update the version
in `package.json` and `package-lock.json`, commit, and push a matching `cli-v<version>`
tag. After checks pass, CI publishes `sekai-code.tgz` and `SHA256SUMS` to GitHub
Releases. Ordinary branch builds produce workflow artifacts only.

The CLI currently supports text input/output, without embedded browser or
image/PDF tools. Context compaction is not automatic; use `/new` for a fresh
conversation and `--max-turns` to limit model calls per task.

## Attribution

Derived from OpenGhost source code, copyright (c) 2026 Andrew. This is an
independent project. The terminal interface uses Pi components by Mario Zechner.
See [LICENSE](LICENSE) and [NOTICE](NOTICE) for license terms and attribution.
