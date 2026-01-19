# Agents Workflow

Personal Claude Code plugin marketplace for development workflow automation.

## Available Plugins

### wf - Lightweight Development Workflow

Minimal workflow plugin with interview, plan, work, and review phases.

**Commands:**
- `/wf` - Status and help
- `/wf:interview <topic>` - Gather requirements
- `/wf:plan <description>` - Create implementation plan
- `/wf:work` - Execute with upfront permissions
- `/wf:review` - Export for external review

## Installation

```bash
claude plugins:install wf --marketplace github:facuzarate04/agents-workflow
```

## Structure

```
plugins/
└── wf/                    # Workflow plugin
    ├── .claude-plugin/
    │   └── plugin.json
    ├── agents/
    ├── skills/
    └── docs/
```
