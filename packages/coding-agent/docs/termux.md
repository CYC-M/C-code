# Run C-code on Android with Termux

C-code runs on Android through [Termux](https://termux.dev/), a terminal emulator and Linux environment. Text input, file tools, and shell commands are supported. C-code can copy and paste text through the Android clipboard with Termux:API. Clipboard image paste is not supported.

## Before you begin

Install Termux from [GitHub or F-Droid](https://github.com/termux/termux-app#installation). Do not use the deprecated Google Play build.

[Termux:API](https://github.com/termux/termux-api#installation) is optional. Install it only when you want C-code to copy or paste Android clipboard text, or when shell commands need Android device APIs.

## Install C-code

1. Update Termux packages:

   ```bash
   pkg update && pkg upgrade
   ```

2. Install Node.js and Git:

   ```bash
   pkg install nodejs git
   ```

3. Clone C-code and build the CLI (requires Node.js 22.19 or newer):

   ```bash
   git clone https://github.com/CYC-M/C-code
   cd C-code
   npm install --ignore-scripts
   npm run hydrate:model-data
   npm run build:offline
   ```

4. Verify the build:

   ```bash
   node packages/coding-agent/dist/bundle/cli.js --version
   ```

5. Open the folder you want to work in and start C-code:

   ```bash
   cd /path/to/working-folder
   node /path/to/C-code/packages/coding-agent/dist/bundle/cli.js
   ```

Continue with the main [Quickstart](quickstart.md#3-choose-a-model) to connect a model and run your first task.

## Access Android shared storage

Termux cannot access shared Android storage until you grant permission. Run this once:

```bash
termux-setup-storage
```

After approval, Android shared storage is available under `/storage/emulated/0` and through the links Termux creates under `~/storage/`.

Only grant this permission when C-code should be able to access those files. Commands and tools running in Termux use the same storage permissions as the Termux process.

## Use clipboard commands

C-code uses `termux-clipboard-set` to copy text and `termux-clipboard-get` for its clipboard-paste shortcut. Shell commands can use both commands directly. Install the Termux:API app and its command-line package:

```bash
pkg install termux-api
```

Verify the integration:

```bash
printf 'C-code clipboard test' | termux-clipboard-set
termux-clipboard-get
```

The second command should print `C-code clipboard test`.

The Termux clipboard API supports text only. C-code's clipboard-paste shortcut inserts that text into the editor but cannot attach clipboard images.

## Add Termux-specific instructions

C-code detects that it is running in Termux, but it cannot infer how you want it to interact with Android. Add only the environment details relevant to your work to `~/.c-code/agent/AGENTS.md`:

````markdown
# Termux environment

- C-code runs in Termux on Android.
- Shared Android storage is under `/storage/emulated/0`.
- Open URLs with `termux-open-url "https://example.com"`.
- Open files with `termux-open <path>`.
- Do not access shared storage unless the task requires it.
````

Run `/reload` after changing the file during an active session.

## Troubleshooting

### Clipboard integration fails

Confirm that you installed both components:

1. The Termux:API Android app from the same source as Termux
2. The `termux-api` command-line package

Then run the clipboard verification commands above outside C-code. If they fail there, fix the Termux:API installation before retrying C-code's copy command.

### Shared storage reports permission denied

Run `termux-setup-storage`, approve the Android permission request, and retry the path under `~/storage/` or `/storage/emulated/0`.

### C-code does not start after building

Open a new Termux shell and run the verify step again from the checkout:

```bash
node packages/coding-agent/dist/bundle/cli.js --version
```

Confirm that `node --version` reports 22.19 or newer, then rerun `npm run build:offline` if the bundle is missing.
