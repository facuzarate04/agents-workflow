---
name: wf
description: Show workflow status and available commands. Triggers on /wf.
---

# WF Status Skill

Show workflow status and available commands.

## Trigger

`/wf`

## Purpose

Display current workflow state and help information.

## Process

### 1. Check for .workflow Directory

```bash
ls -la .workflow 2>/dev/null
```

### 2. Show Status

If `.workflow/` exists, show current state:

#### Specs
```bash
ls -la .workflow/specs/*.md 2>/dev/null
```

#### Plans
```bash
ls -la .workflow/plans/*.md 2>/dev/null
```

For each plan, show:
- Filename
- Status (from file content)
- Task completion count

#### Exports
```bash
ls -la .workflow/exports/*.md 2>/dev/null | tail -3
```

### 3. Display Output

Format the status display:

```markdown
## WF Workflow Status

### Current State

**Specs**: X spec file(s)
**Plans**: X plan file(s)
**Latest Plan**: <filename> - <status>

### Recent Activity

- <plan name>: X/Y tasks complete

### Available Commands

| Command | Description |
|---------|-------------|
| `/wf:interview <topic>` | Gather requirements via questions |
| `/wf:plan <description>` | Create structured plan |
| `/wf:work [plan]` | Execute plan with upfront permissions |
| `/wf:review` | Export for external review |
| `/wf` | Show this status |

### Quick Start

1. `/wf:interview my feature` - Define requirements
2. `/wf:plan` - Create implementation plan
3. `/wf:work` - Execute (approve permissions once)
4. `/wf:review` - Generate review export
```

### 4. First Time Setup

If `.workflow/` doesn't exist:

```markdown
## WF Workflow

No workflow directory found. Start with:

`/wf:plan <your feature description>`

or

`/wf:interview <topic>` to gather requirements first.

### Available Commands

| Command | Description |
|---------|-------------|
| `/wf:interview <topic>` | Gather requirements via questions |
| `/wf:plan <description>` | Create structured plan |
| `/wf:work [plan]` | Execute plan with upfront permissions |
| `/wf:review` | Export for external review |
```

## Important

- Keep output concise
- Show actionable next steps
- Don't read full file contents, just metadata
