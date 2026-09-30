# C-code

C-code is an extensible AI agent that works from your terminal. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks.

Use C-code for software development, research notes, writing projects, data files, or hobby work. You can use C-code as is, prompt it to adapt itself to your workflow, or build other applications powered by C-code using the SDK.

## Start using C-code

New to C-code? Follow the [Quickstart](quickstart.md) to install C-code, connect a model, and complete your first task.

If C-code is already installed, choose what you want to do:

- [Use C-code interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Configure C-code](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand how C-code works](how-pi-works.md), including tools, context, sessions, and the agent loop.

## Customize C-code

C-code can reuse prompts, load specialized instructions, add executable integrations, change its terminal interface, connect model services, and distribute these resources as packages.
Use the [Quickstart customization chooser](quickstart.md#choose-how-to-customize-c-code) to select the smallest mechanism that meets your need.

## Automate or embed C-code

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate C-code process.
- Use the [TypeScript SDK](sdk.md) to run C-code inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings.md), [provider authentication](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

## Work safely

C-code's tools and extensions run with the permissions of the C-code process. Project trust controls which project resources C-code loads, but it does not sandbox tool calls. Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.
