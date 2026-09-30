# Quickstart

C-code runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Build C-code from source

Clone the repository and build the CLI. This requires Node.js 22.19 or newer:

```bash
git clone https://github.com/CYC-M/C-code
cd C-code
npm install --ignore-scripts
npm run hydrate:model-data   # fetch model metadata once (network required)
npm run build:offline
```

C-code does not require dependency lifecycle scripts for a normal installation. `hydrate:model-data` only runs while building from a source checkout; the generated metadata is not stored in git, so it must be fetched once on a fresh clone.

Verify the build:

```bash
node packages/coding-agent/dist/bundle/cli.js --version
```

## 2. Start C-code

Change to the folder you want C-code to work with, then start it:

```bash
cd /path/to/folder
node /path/to/C-code/packages/coding-agent/dist/bundle/cli.js
```

The reference pages in these docs write the command as `c-code`. From a source checkout, replace `c-code` with `node /path/to/C-code/packages/coding-agent/dist/bundle/cli.js`.

The working folder helps C-code discover relevant files, instructions, and configuration. C-code also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="C-code running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use C-code in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates C-code's responses. A **provider** is the service or account C-code uses to access that model.

In C-code, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give C-code a task

C-code shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When C-code finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

C-code saves sessions automatically. Exit C-code, then resume the most recent session for the same working folder with:

```bash
cd /path/to/folder
node /path/to/C-code/packages/coding-agent/dist/bundle/cli.js --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use C-code interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that C-code should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize C-code

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give C-code persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [C-code package](packages.md) |

## Remove C-code

C-code is built and run from a source checkout, so there is no installer or global package to uninstall. Delete the checkout to remove it:

```bash
rm -rf /path/to/C-code
```

Configuration, credentials, sessions, and installed C-code packages live in `~/.c-code/agent/`. Delete that directory as well for a complete removal.
