# C-code Agent Harness (v0.0.1-beta)

Independent fork of the Pi agent harness. Self-contained development from here on; no upstream sync.

This is the home of the C-code project including our self extensible coding agent.

## Installation

### Homebrew (macOS and Linux)

Install the C-code CLI with:

```bash
brew install CYC-M/tap/c-code
```

After installation, all three commands start C-code:

```bash
cc
c-code
ccode
```

### Windows PowerShell

Run this command in PowerShell. It detects x64 or ARM64, downloads the latest C-code release, verifies its SHA-256 checksum, installs it for the current user, and adds the commands to `PATH`:

```powershell
irm https://raw.githubusercontent.com/CYC-M/C-code/main/install.ps1 | iex
```

Open a new terminal window after installation, then run any of:

```powershell
cc
c-code
ccode
```

### Download a release

For most users, download a prebuilt package from the [GitHub Releases page](https://github.com/CYC-M/C-code/releases). Choose the archive matching your operating system and CPU:

| Platform | Archive |
|----------|---------|
| macOS Apple Silicon | `pi-darwin-arm64.tar.gz` |
| macOS Intel | `pi-darwin-x64.tar.gz` |
| Linux x64 | `pi-linux-x64.tar.gz` |
| Linux ARM64 | `pi-linux-arm64.tar.gz` |
| Windows x64 | `pi-windows-x64.zip` |
| Windows ARM64 | `pi-windows-arm64.zip` |

The standalone executable is currently named `pi`. To install it as `c-code` on macOS or Linux:

```bash
tar -xzf pi-<platform>.tar.gz
cd pi
chmod +x pi
sudo install pi /usr/local/bin/c-code
c-code --help
```

On Windows, extract the ZIP, rename `pi.exe` to `c-code.exe`, and add its directory to `PATH` before running:

```powershell
c-code.exe --help
```

Release archives include the executable, runtime assets, native helpers, documentation, and a `SHA256SUMS` file. Verify the archive before extracting it when possible.

### Install from source

Source installation is intended for developers and requires Node.js `>=22.19.0`:

```bash
git clone https://github.com/CYC-M/C-code.git
cd C-code
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
node packages/coding-agent/dist/bundle/cli.js
```

The GitHub Actions release workflow builds the platform archives when a version tag such as `v0.0.2` is pushed. Release maintainers should run the repository release process rather than uploading binaries manually.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about C-code:

* Read `packages/coding-agent/docs/`, but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

C-code does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox C-code. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `c-code` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `c-code` process in a local container for simple isolation.
- **OpenShell**: run the whole `c-code` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run the experimental TUI from source (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `c-code update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use C-code or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

## 自更新源（已与官方断联）

开局不再检查更新，`c-code update self` 默认提示未配置。要接自己的 GitHub 仓库：

1. 在仓库放一个版本 JSON（字段同官方格式）：`{"version": "0.0.2-beta", "packageName": "your-scope/c-code", "note": "更新说明（可选）"}`
2. 配置地址（二选一）：环境变量 `C_CODE_UPDATE_URL`（优先），或 `settings.json` 加 `"updateUrl": "https://.../version.json"`
3. 之后开局自动提示更新，`c-code update self` 可执行
