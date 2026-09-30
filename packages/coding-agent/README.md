# C-code (v0.0.1-beta)

C-code is a minimal, extensible AI agent for the terminal. Adapt C-code to your workflow, not the other way around.

Ask C-code to create the prompt templates, skills, extensions, and themes you need, or install a C-code package. Use C-code directly, automate it in print, JSON, or RPC mode, or build applications with the TypeScript SDK.

## Getting started

Run from source:

```bash
npm install --ignore-scripts
npm run hydrate:model-data   # fetch model metadata once (network required)
npm run build:offline
```

This requires Node.js 22.19 or newer.

Start C-code in the directory where you want it to work:

```bash
cd /path/to/project
node packages/coding-agent/dist/bundle/cli.js
```

For a built-in AI provider, run `/login` inside C-code to connect a subscription or API key. Then give C-code a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Development

Clone the repository, install its dependencies, and run C-code from source:

```bash
git clone https://github.com/CYC-M/C-code
cd C-code
npm install --ignore-scripts
./pi-test.sh         # Run the experimental TUI from source (can be run from any directory)
```

`pi-test.sh` (experimental TUI from source) can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/CYC-M/C-code/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/CYC-M/C-code/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
