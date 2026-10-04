# Archived desktop companion

This directory preserves the Electron application for reference. Active development,
CI, and the root npm package focus on the Sekai CLI. This archive is excluded from
the CLI package and its validation commands.

Run the commands below from `archive/desktop/`. Dependencies and build output are
local to this directory. `npm test` checks the archived desktop credential behavior.
The workflow in `.github/workflows/build.yml` is retained for reference and is not
active in the repository.

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
