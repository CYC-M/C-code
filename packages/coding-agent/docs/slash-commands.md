# Slash commands

Type `/` in C-code's terminal editor to search the commands available in the current session. This page lists the built-in commands in the current C-code release.

Extensions, prompt templates, and skills can add commands. The command menu in C-code is therefore the exact reference for the resources loaded in your session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Switch to another saved session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/import <path>` | Import and resume a JSONL session |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a private bug report for the developers |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future C-code processes |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit C-code |

## Team delegation

| Command | Description |
|---|---|
| `/teamwork [exit\|bind <worker…>]` | Enter persistent teamwork mode (brain → workers → reviewer) |

`/teamwork` enters persistent mode: the editor shows a `[teamwork]` badge with the effective leader plus an accent border. Run `/teamwork` with no arguments to configure the team; `/teamwork bind <worker…>` binds workers by hand; `/teamwork exit` (or double-Esc on an empty editor) leaves the mode. The first Esc pauses a running task with a reminder, the second Esc exits.

- Worker naming is fixed: the leader names workers `worker1`, `worker2`, ... in order and describes each job, shown as `worker1（UI designer）`. Roles are separate from models: each task references a worker id and each id binds to one provider/model, so a name the leader invents (`ui designer`) becomes the description of the next free worker instead of failing the run. A `reviewer` binding is required. The same model may back multiple roles.
- Workers without a binding are bound while the run is being prepared: the leader sends the split, and you pick a model for each unbound worker in turn. Bind them ahead of time with `/teamwork bind worker1 worker2` (or the Workers pool section of `/teamwork`) to skip the prompts. Headless runs print the exact `bind` command instead.
- Entering the mode configures `leader` + `reviewer` first.
- Each role binding may carry its own thinking level (default `off`): pick it right after the model in `/teamwork` setup, click the Leader/Workers/Reviewer rows in the sidebar to reselect model + thinking, or run `/teamwork thinking <worker>` to change only the thinking level. It applies to new runs only.
- Budget is a hard limit: each run allows at most `maxRounds` rounds (default 3) and `maxWorkerCalls` worker plus reviewer calls (default 12). The brain can override both per call via `budget`. When either limit is exhausted, the run ends as `failed`.
- `failed` semantics: a failed run is not done. The brain reads the reviewer verdict and persisted state, then decides exactly one of `retry`, `swap_worker`, `revise_package`, `downgrade`, `finish` (only after a pass verdict), or `abort`. `downgrade` explicitly accepts a partial result and states what was dropped.
- Config sections: `/teamwork` (no args) walks Leader → Workers pool → Reviewer when re-run inside the mode. The Leader defaults to following the session model; selecting an independent model temporarily switches the session model while the mode is active and restores it on exit. The Workers pool supports add/remove; every step shows the stored binding with keep/reselect.
- Sidebar: the roster column takes a share of the terminal width (30-46 columns) and text wraps instead of being cut off, so long model names and worker descriptions stay readable at any width. Workers fold by available height (`…N more`); the reviewer row, run line, and brand row always stay visible. Click a worker row to reconfigure it.
- Panel: docked above the editor, visible only while a team run is active (plus a one-line summary after finish). Rows: title (`done/total · phase`), Leader, Workers (one line each, max 12 then `…N more`), Reviewer. Click a worker row to expand its task/summary. Statuses: `pending`/`working`/`completed`/`failed`/`reviewing`/`needs_fix`.
- Events: the panel is fed by structured `details.teamwork` update events (full fidelity, no string parsing); the persisted run state remains in the `teamwork-run` session entry.

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.
