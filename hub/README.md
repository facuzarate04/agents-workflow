# Agent Hub CLI (MVP)

Outside-in orchestrator for multi-agent development workflows.

## Goals

- No repository installation required.
- Chat-first CLI for natural language requests.
- Central policy + per-repo policy layering.
- Global MCP registry + per-repo MCP registry with trust levels.
- Portable checkpoint artifacts for conversation compaction and handoffs.

## Quick Start

```bash
cd hub
node ./bin/hub.mjs profile select work
node ./bin/hub.mjs run --repo /path/to/repo "Analyze this repo and detect business rules"
node ./bin/hub.mjs chat --repo /path/to/repo
```

Profile selection is mandatory before running workflows.

## Commands

- `hub run --repo <path> "<natural language request>"`
- `hub chat --repo <path>`
- `hub profile current`
- `hub profile select <work|personal>`
- `hub list`
- `hub status <run-id>`
- `hub start <run-id>`
- `hub approve <run-id>`
- `hub reject <run-id> [reason]`
- `hub stop <run-id> [--cleanup]`
- `hub commit <run-id> [--message "feat: ..."]`
- `hub push <run-id>`
- `hub pr <run-id> [--title "..."] [--body "..."] [--base main]`
- `hub pushpr <run-id> [--title "..."] [--body "..."] [--base main]`
- `hub slack notify <run-id> [--channel C123] [--thread 123.45]`
- `hub slack socket`
- `hub slack map channels`
- `hub slack map list`
- `hub slack map set --channel <#name|CID> --repo <path>`
- `hub slack map remove --channel <#name|CID>`
- `hub slack map resolve --channel <#name|CID>`
- `hub team roles [--repo <path>]`
- `hub team brainstorm --repo <path> "topic"`
- `hub team provider-check --repo <path> --role <role-id> --topic "question"`
- `hub team scaffold-role --repo <path> --id pm-data --name "PM Data" [--provider codex]`
- `hub review --repo <path> [--goal "description"]`

## What happens on each run

1. Parse natural language and infer workflow (`understand`, `bugfix`, `refactor`, `feature`).
2. Load policy context:
- Global: `hub/config/global-policy.json`
- Repo: `<repo>/.agent-hub/repo-profile.json` (optional)
3. Load MCP context:
- Global: `hub/config/mcp-registry.json`
- Repo: `<repo>/.agent-hub/mcp-registry.json` (optional)
4. Draft execution plan with gates.
5. Persist artifacts under `hub/.state/runs/<run-id>/` and project checkpoint.

## Run lifecycle

1. `hub run ...` creates a planned run and writes artifacts.
2. `hub start <run-id>` starts execution.
   - Creates `branch + git worktree` for that run (isolated execution path).
3. If MCPs marked `review-required` exist, run moves to `awaiting_approval`.
4. `hub approve <run-id>` grants approval and allows execution.
5. Worker evaluates gates (`tests`, `lint`, `typecheck`, `e2e`) from repository scripts.
6. Final status becomes `completed` or `failed`.
7. `hub stop <run-id> --cleanup` removes the run worktree and temporary branch.
8. `hub commit <run-id>` commits changes from that run worktree.
9. `hub push <run-id>` pushes run branch to `origin`.
10. `hub pr <run-id>` opens a GitHub PR using `gh`.
11. `hub pushpr <run-id>` performs push + PR in one step.
12. `hub slack notify <run-id>` posts run summary into Slack.
13. `hub slack socket` enables PM conversational mode in Slack (CEO talks to PM in natural language).
14. `hub slack map ...` manages channel-to-repository routing.

## Artifact layout

```text
hub/.state/
├── runs/<run-id>/
│   ├── task-spec.json
│   ├── policy-context.json
│   ├── mcp-context.json
│   ├── execution-plan.json
│   ├── gate-report.json
│   ├── task-result.json
│   └── checkpoint.json
└── projects/<repo-slug>/
    └── checkpoint.latest.json
```

## Per-repo configuration

Copy these templates into each target repository:

- `hub/examples/repo-profile.example.json` -> `<repo>/.agent-hub/repo-profile.json`
- `hub/examples/repo-mcp-registry.example.json` -> `<repo>/.agent-hub/mcp-registry.json`

This lets each project define custom lineamientos, checks and MCPs.
You can also add implementation commands in `repo-profile.json` via `commands.implementByWorkflow`.
You can define PR defaults in `repo-profile.json` via `prTemplate` (`titlePrefix`, `sections`).

### Team provider wiring

Role providers are command-driven and configurable in `team.json`:

- `providers.providerCommands.claude-teams`
- `providers.providerCommands.codex`

Supported placeholders in commands:
- `{{prompt_file}}`
- `{{topic}}`
- `{{repo_path}}`
- `{{role_id}}`
- `{{role_name}}`

Example:

```json
{
  "providers": {
    "providerCommands": {
      "claude-teams": "claude -p \"$(cat {{prompt_file}})\"",
      "codex": "codex run \"$(cat {{prompt_file}})\""
    }
  }
}
```

### Provider collaboration (recommended)

Instead of fallback-only behavior, you can run multiple providers per role and synthesize:

```json
{
  "providers": {
    "providerPipelines": {
      "technical-consult": {
        "pm": ["claude-teams", "codex"],
        "backend": ["codex", "claude-teams"]
      }
    }
  }
}
```

This runs both providers for the same role/topic and returns a consolidated result with cross-validation notes.

## Slack setup

1. Copy `hub/config/slack/.env.example` values into your shell environment.
2. Create a Slack app with:
- Bot token scopes: `chat:write`, `app_mentions:read`
- Socket Mode enabled
- Event subscription for `app_mention`
3. Run `hub slack socket`.
4. Talk to PM in natural language in a thread:
- "Necesito opciones para rediseñar checkout"
- "¿Cómo escalaríamos la API de pagos?"
- "Aprobá el último run"

The PM delegates technical questions to expert roles (backend/frontend/PO) and returns a consolidated recommendation.
When provider commands are configured, delegation uses real executors (for example Claude Teams/Codex). Otherwise PM returns structured fallback analysis and prompts to dispatch.

### Validate providers before PM consults

Use this command to verify a role/provider can answer with enough quality:

```bash
node ./bin/hub.mjs team provider-check --repo /path/to/repo --role backend --topic "Como mejorar el SEO de la landing"
```

If status is `insufficient` or `dispatch_required`, fix `providers.providerCommands` and retry.

### Multi-repo Slack routing (recommended)

Use one Slack channel per project and map channels to repositories in:

- `hub/config/slack/repo-map.json`

Example:

```json
{
  "channels": {
    "C_PAYMENTS": "/path/to/payments-service",
    "C_CHECKOUT": "/path/to/checkout-web"
  }
}
```

Resolution order:
1. `repo-map.json` by `channel_id`
2. `SLACK_DEFAULT_REPO`
3. current process cwd

## Code Review Gate

Optional post-execution code review that runs automatically after EXECUTE completes.

### Configuration

Add `gates.codeReview` to your `team.json`:

```json
{
  "gates": {
    "codeReview": {
      "enabled": true,
      "provider": "claude-teams",
      "rulesFile": "AGENTS.md",
      "maxDiffLines": 3000
    }
  }
}
```

When enabled, the PM will automatically review changed files after execution using the configured provider.
The review checks for correctness, security issues, and adherence to project rules defined in `AGENTS.md` (or `CLAUDE.md` as fallback).

Results are reported to the Slack thread with verdict (approve/request_changes), issue list, and severity levels.

### Manual review

Run a standalone review on any repository:

```bash
node ./bin/hub.mjs review --repo /path/to/repo --goal "Added user auth"
```

## MCP Server (Claude Code integration)

The hub exposes an MCP server so Claude Code (and any MCP-compatible tool) can use hub capabilities as native tools.

### Available tools

| Tool | Description |
|------|-------------|
| `memory_search` | Full-text search across observations |
| `memory_save` | Save decisions, patterns, errors, context |
| `memory_get` | Get full observation by ID |
| `memory_context` | Load relevant context for a project |
| `memory_delete` | Soft-delete an observation |
| `memory_stats` | Memory system statistics |
| `code_review` | AI-powered code review on git diff |
| `team_roles` | List team roles and providers |
| `team_config` | Show merged team configuration |
| `project_list` | List configured projects |
| `project_show` | Show project details |
| `session_start` | Start a memory session |
| `session_end` | End a memory session |

### Setup for Claude Code

Add to your `.claude.json` (project) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "node",
      "args": ["/path/to/agents-workflow/hub/bin/mcp.mjs"]
    }
  }
}
```

After restarting Claude Code, all hub tools are available as native MCP tools.

## Current scope

This MVP currently covers planning, policy resolution, approval gating, basic gate execution, worktrees, commit/push and PR opening.
Remote adapters (Telegram) and deeper code-editing workers are next.
