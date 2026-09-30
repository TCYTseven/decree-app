# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/TCYTseven/decree-app/security/advisories/new),
not in a public issue. Include the version (`npx decree-harness --version`),
steps to reproduce, and the impact you expect.

You should get a reply within a week. Fixes ship in a patch release, and the
advisory is published once a fixed version is on npm.

## Supported versions

Only the latest published version gets security fixes.

## Scope

decree runs on developer machines and in CI, and generates code that runs
agents with tools. Reports in these areas are especially useful:

- Generated tools escaping `guardrails.allowedPaths` (including via symlinks)
  or `guardrails.blockedCommands`.
- Shell parameter injection in generated or runtime shell tools.
- Secret values reaching the model, transcripts or generated files.
- The `preview` server accepting requests from other origins or hosts.
- The `mcp` server reading or returning anything other than `decree.json`
  decisions.

The scanner reads repository files locally and sends nothing over the
network. Planning, `refine`, `chat`, `run` and `eval` send a digest of the scan
and your prompts to the Anthropic API using your own key.
