# Run C-code in an isolated environment

Use an isolated environment to limit the files, credentials, processes, and network services that generated commands can access or affect.

You can isolate the complete C-code process or keep C-code on the host and route selected tools into an isolated environment.

## Choose an isolation method

| Method | Where C-code runs | What is isolated | Credential handling | Best for |
|---|---|---|---|---|
| Plain Docker | Container | C-code, built-in tools, `!` commands, and extensions | Credentials passed into the container | A straightforward local container boundary |
| Docker Sandboxes | Managed sandbox | C-code, built-in tools, `!` commands, and extensions | Provider credentials remain on the host and are substituted by the proxy | Managed local isolation without exposing the real provider key |
| OpenShell | Local or remote sandbox | C-code, built-in tools, `!` commands, and extensions | Policy-controlled credentials and inference routing | Filesystem, process, network, and credential policies |
| Gondolin extension | Host | Built-in tools and `!` commands | Stored C-code credentials remain on the host, but commands inherit host environment variables | A local micro-VM for tool execution while retaining the host interface |

The method changes where extensions run. When the complete C-code process runs inside an isolated environment, its extensions run there too. When host C-code delegates built-in tools through Gondolin, other extension tools still run on the host unless they also delegate their work.

## Decide what C-code can access

An isolated process can still affect resources you expose to it:

- A read-write host mount lets C-code modify those host files.
- Mounting `~/.c-code/agent` exposes your C-code credentials, settings, extensions, and sessions.
- Environment variables passed into a container are available to processes inside it.
- Network access may allow code or tool output to leave the environment.
- Tool-only isolation does not constrain the host C-code process or extension tools that do not use the isolated backend.

Expose only the working folder, credentials, and network destinations needed for the task. Use read-only mounts or copy files into and out of the environment when you do not want writes to affect the host.

## Run C-code in plain Docker

Plain Docker provides the simplest whole-process container boundary.

### Build the image

Create `Dockerfile.c-code`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/CYC-M/C-code /opt/c-code \
  && cd /opt/c-code \
  && npm install --ignore-scripts \
  && npm run hydrate:model-data \
  && npm run build:offline

WORKDIR /workspace
ENTRYPOINT ["node", "/opt/c-code/packages/coding-agent/dist/bundle/cli.js"]
```

Build it from the directory containing the file:

```bash
docker build -t c-code-sandbox -f Dockerfile.c-code .
```

### Start C-code

From the working folder you want C-code to access, run:

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v c-code-agent-home:/root/.c-code/agent \
  c-code-sandbox
```

Replace `ANTHROPIC_API_KEY` with the credential required by your provider. The named `c-code-agent-home` volume keeps container-local settings, credentials, and sessions between runs.

Do not mount the host's `~/.c-code/agent` unless the container should have access to your host C-code configuration and credentials.

### Verify the workspace

Inside C-code, run:

```text
!pwd
```

The command should report `/workspace`. Changes under `/workspace` write through to the mounted host folder. Remove the bind mount or use a read-only mount when that is not acceptable.

## Run C-code with Docker Sandboxes

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) runs the complete C-code process inside a managed sandbox. Its proxy can keep the real provider credential on the host and substitute it when requests leave the sandbox.

Configure credentials before creating the sandbox. Do not run `/login` inside the sandbox because that writes a real credential into it.

### Use a Claude Pro or Max token

Generate the token with `claude setup-token` on a machine with Claude Code. If an `anthropic` secret is already configured, remove it first so the proxy does not add an API-key header alongside the bearer token:

```bash
sbx secret rm anthropic

sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

`sbx secret set-custom` reads the real token from standard input. The sandbox receives an OAuth-shaped placeholder, which the proxy replaces only for requests to the configured host.

For an Anthropic API key, use `sbx secret set anthropic` instead.

### Start C-code

Run this from the working folder you want mounted:

```bash
sbx run --kit "docker.io/sbx/pi-kit:latest" pi
```

For an existing sandbox, run C-code non-interactively with:

```bash
sbx exec <sandbox-name> -- pi -p "list the failing tests"
```

See the [Pi kit documentation](https://github.com/docker/sbx-kits-contrib/tree/main/pi) for other providers, troubleshooting, and image pinning.

## Run C-code with OpenShell

[NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) provides local or remote sandboxes with filesystem, process, network, credential, and inference policies.

### Select a gateway

Every sandbox requires an active gateway:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

### Create the sandbox

```bash
openshell sandbox create --name c-code-sandbox --from pi -- c-code
```

C-code, its built-in tools, `!` commands, and extension tools run inside the OpenShell boundary.

### Transfer files to a remote sandbox

A remote gateway does not bind-mount your host working folder. Clone the repository inside the sandbox or transfer files explicitly:

```bash
openshell sandbox upload c-code-sandbox ./working-folder /workspace
openshell sandbox download c-code-sandbox /workspace/working-folder ./working-folder-out
```

OpenShell inference routing can keep raw model credentials outside the sandbox. When configured, point C-code at the corresponding OpenAI-compatible or Anthropic-compatible endpoint exposed by the gateway.

## Route tools through Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM. Its example extension keeps the C-code process and file-based provider credentials on the host while routing the built-in tools and user `!` commands into the VM.

Commands inside the VM inherit the host process environment. Provider keys supplied through environment variables can therefore be visible inside the VM. Do not use this pattern as a credential boundary unless you remove sensitive variables or change the extension's environment handling.

Gondolin requires Node.js 23.6 or newer and QEMU installed through your operating-system package manager.

### Install the extension

From a C-code source checkout:

```bash
mkdir -p ~/.c-code/agent/extensions
cp -R packages/coding-agent/examples/extensions/gondolin ~/.c-code/agent/extensions/gondolin
cd ~/.c-code/agent/extensions/gondolin
npm install --ignore-scripts
```

### Start C-code

Run C-code from the working folder you want mounted:

```bash
cd /path/to/working-folder
c-code -e ~/.c-code/agent/extensions/gondolin
```

The extension mounts the host working folder at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. File changes under `/workspace` write through to the host.

Other extension tools still run on the host unless they explicitly delegate their operations. Review the [Gondolin example](../examples/extensions/gondolin/) before adding tools that could bypass the VM boundary.
