# Contributing to Agents Workflow

Thank you for your interest in contributing.

## Getting Started

1. Fork the repository and clone your fork.
2. Install dependencies:
   ```bash
   cd hub && npm install
   ```
3. Copy example configs:
   ```bash
   cp hub/.agent-hub/team.example.json hub/.agent-hub/team.json
   cp hub/config/profiles.example.json hub/config/profiles.json
   cp hub/config/projects.example.json hub/config/projects.json
   cp hub/config/slack/.env.example hub/config/slack/.env
   cp hub/config/slack/repo-map.example.json hub/config/slack/repo-map.json
   ```
4. Edit each config file with your own paths, tokens, and accounts.

## Development

- Node.js 18+ required
- ES modules throughout (`"type": "module"`)
- Zero runtime dependencies except `better-sqlite3` for the memory system
- Run the CLI: `node hub/bin/hub.mjs`

## Project Structure

```
hub/
  bin/hub.mjs          - CLI entry point
  src/
    cli.mjs            - Command routing
    core/              - Core modules (runs, git, review, memory, profiles)
    integrations/      - Slack, PM agent
    team/              - Config loading, provider execution, sessions
  config/              - Default configs and example templates
  .agent-hub/          - Team config (gitignored, example provided)
```

## Guidelines

- Keep it simple. Avoid over-engineering.
- All code and documentation in English.
- No hardcoded paths, tokens, or personal data in committed files.
- Sensitive config goes in gitignored files with `.example` templates.
- Test your changes: `node -e "import('./src/cli.mjs')"` at minimum.

## Pull Requests

1. Create a feature branch from `main`.
2. Keep PRs focused on a single change.
3. Describe what and why in the PR description.
4. Ensure the CLI loads without errors.

## Reporting Issues

Open an issue on GitHub with:
- What you expected
- What happened
- Steps to reproduce
- Node.js version and OS

## Security

If you find a security vulnerability, please report it privately via GitHub Security Advisories instead of opening a public issue.
