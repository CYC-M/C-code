# Security Policy

This document explains the security concept behind C-code and where its boundaries are.

In general, C-code is a coding agent that runs locally within the security boundary
of the user running it. It is the user's responsibility to monitor its operations
or contain it within a container, virtual machine, or other sandbox solution.

C-code treats the local user account and files writable by that account as inside
the same trust boundary as the C-code process itself. If an attacker can modify files
under the user's home directory, workspace, shell startup files, environment, or
C-code configuration, they can generally influence C-code or other local developer tools.
Reports that depend on such prior local write access are not security
vulnerabilities unless they demonstrate how C-code grants that write access or crosses
an operating-system privilege boundary.

C-code relies on users installing trustworthy extensions, loading trustworthy
skills, and using C-code only within trusted repositories. This is because files
like `AGENTS.md` or instructions in comments can trivially prompt-inject the
coding agent, and this cannot be protected against.

## Reporting a Vulnerability

If you believe you found a security vulnerability in C-code or another package in
this repository, please report it privately by either:

- Emailing `2330699794@qq.com`
- Opening a private report through GitHub Security Advisories for this repository

Please include:

- A description of the issue and its impact
- Steps to reproduce, proof of concept, or relevant logs
- Affected package, version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports. We will review
reports and coordinate disclosure as appropriate.

## Scope

Security issues in the distributed C-code packages, command-line tools, APIs, and
repository code are in scope, as well as infrastructure used by this repository
to distribute C-code.

## Out Of Scope

- Local code execution or sandboxing behavior (C-code intentionally does not have a sandbox)
- Behavior of C-code extensions or skills installed by the user
- Risks from working in untrusted repositories
- Risks from installing untrusted extensions, skills, packages, or tools
- Issues caused by non-trustworthy MITM proxies
- Public internet exposure of a C-code installation
- Prompt injection attacks
- Exposed secrets that are third-party or user-controlled credentials
- Reports requiring the ability to create, modify, delete, or replace files,
  directories, symlinks, environment variables, shell configuration, or other
  user-controlled local state on the target machine. This includes `~/.c-code`,
  `~/.c-code/agent/models.json`, workspace files, `AGENTS.md`, skills, extensions,
  extension configuration, dotfiles, and files synchronized through NFS, roaming
  profiles, or dotfile managers, unless the report shows how C-code itself grants
  that access.
- Issues caused by intentionally weakened user configuration
- Resource or denial-of-service claims that require trusted local input or configuration against C-code
- Reports about malicious model output
- User-approved or user-initiated local actions presented as vulnerabilities

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass
with demonstrated impact. Reports that only show expected local-agent behavior,
prompt injection, or a malicious trusted extension or skill are not security
vulnerabilities under this model.

For example, a report showing that malicious contents written to a trusted C-code
configuration file cause C-code to execute commands, load attacker-controlled tools,
send credentials to an attacker-controlled endpoint, or otherwise change behavior
is out of scope.

When possible, include the exact affected path, package version or commit SHA,
configuration, and a proof of concept against the latest release or latest
`main`. For dependency reports, include evidence that the shipped dependency is
affected and that the issue is reachable through C-code. For exposed-secret reports,
include evidence that the credential is owned by C-code or grants access to C-code
operated infrastructure or services.
