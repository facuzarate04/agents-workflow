# Agents Workflow

Development workflow toolkit with two tracks:

1. `plugins/wf`: lightweight Claude plugin workflow.
2. `hub/`: outside-in chat-first CLI orchestrator for multi-agent workflows.

## 1) Claude plugin (`wf`)

Minimal workflow plugin with interview, plan, work, and review phases.

Commands:
- `/wf` - Status and help
- `/wf:interview <topic>` - Gather requirements
- `/wf:plan <description>` - Create implementation plan
- `/wf:work` - Execute with upfront permissions
- `/wf:review` - Export for external review

## 2) Agent Hub CLI

Conversational CLI that interprets natural language and persists run artifacts/checkpoints.

Quick start:

```bash
cd hub
npm install
node bin/hub.mjs init
```

The setup wizard will detect installed tools, ask for your GitHub account, configure providers, and generate all config files.

After setup:

```bash
node bin/hub.mjs profile select work
node bin/hub.mjs chat --repo /path/to/repo
node bin/hub.mjs run --repo /path/to/repo "Analyze this repo"
```

### Manual Setup

If you prefer manual configuration, copy the example files and edit them:

```bash
cp hub/.agent-hub/team.example.json hub/.agent-hub/team.json
cp hub/config/profiles.example.json hub/config/profiles.json
cp hub/config/projects.example.json hub/config/projects.json
cp hub/config/slack/.env.example hub/config/slack/.env
cp hub/config/slack/repo-map.example.json hub/config/slack/repo-map.json
```

### Details

See [hub/README.md](hub/README.md) for full documentation.
