# WF Plugin - Lightweight Development Workflow

## Overview

A minimal Claude Code plugin for structured development workflows. Token-efficient alternative to complex workflow systems.

**Philosophy**: Simple markdown files over complex JSON, minimal subagents, copy-paste friendly exports.

---

## Plugin Structure

```
wf/
├── .claude-plugin/
│   └── plugin.json          # Plugin metadata
├── agents/
│   ├── explorer.md          # Codebase exploration agent
│   └── reviewer.md          # Code review agent
├── skills/
│   ├── wf-interview/
│   │   └── SKILL.md         # Requirements gathering
│   ├── wf-plan/
│   │   └── SKILL.md         # Planning workflow
│   ├── wf-work/
│   │   └── SKILL.md         # Execution workflow
│   ├── wf-review/
│   │   └── SKILL.md         # Review export workflow
│   └── wf/
│       └── SKILL.md         # Main entry (status/help)
└── docs/
    └── README.md            # Usage documentation
```

---

## Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `/wf:interview <topic>` | Gather requirements via questions | `.workflow/specs/YYYY-MM-DD-slug.md` |
| `/wf:plan <description\|spec>` | Create structured plan | `.workflow/plans/YYYY-MM-DD-slug.md` |
| `/wf:work [plan-file]` | Execute plan tasks | Updates plan file, writes code |
| `/wf:review` | Export for external review | `.workflow/exports/review-TIMESTAMP.md` |
| `/wf` | Show status / help | Current plan status |

---

## Workflow Phases

### 1. Interview Phase (`/wf:interview`) - Optional

**Input**: Topic or feature idea (can be vague)

**Process**:
1. Ask clarifying questions using `AskUserQuestion` tool
2. Probe for edge cases, constraints, preferences
3. Document answers as structured spec

**Output**: Spec file at `.workflow/specs/YYYY-MM-DD-slug.md`

```markdown
# Spec: Feature Name

## Problem
What problem are we solving?

## Requirements
- Requirement 1
- Requirement 2

## Constraints
- Must work with X
- Cannot break Y

## User Decisions
- Q: How should errors be handled?
  A: Show toast notification

## Out of Scope
- Things explicitly not included
```

**Question Categories** (10-15 questions, not 40+):
1. **Problem**: What problem? Who is affected?
2. **Scope**: What's included/excluded?
3. **Behavior**: How should it work? Edge cases?
4. **Technical**: Any constraints? Integrations?
5. **Validation**: How do we know it's done?

---

### 2. Plan Phase (`/wf:plan`)

**Input**: Feature description, bug report, OR spec file from interview

**Process**:
1. Use `explorer` agent to understand codebase context
2. Identify affected files and patterns
3. Generate structured task list
4. **Identify required permissions** (tests, builds, installs, etc.)

**Output**: Markdown plan file with permissions section

```markdown
# Plan: Feature Name

## Context
Brief description of what we're building and why.

## Permissions Required
Commands that will need approval to run uninterrupted:
- run tests
- install dependencies
- run database migrations
- build the project

## Files to Modify
- `path/to/file.php` - reason
- `path/to/other.js` - reason

## Tasks

### Task 1: Description
- [ ] Subtask a
- [ ] Subtask b
**Acceptance**: What defines done

### Task 2: Description
- [ ] Subtask a
**Acceptance**: What defines done

## Notes
Any edge cases or considerations.
```

### 3. Work Phase (`/wf:work`)

**Input**: Plan file (auto-detects latest if not specified)

**Process**:
1. Read plan, understand current state
2. **Request all permissions upfront** using `ExitPlanMode` with `allowedPrompts`
3. User approves once → execution runs uninterrupted
4. For each task:
   - Mark task in-progress
   - Implement changes
   - Mark task complete
5. Track progress in plan file

**Permission Request Flow**:
```
/wf:work
  ↓
Read plan → Extract "Permissions Required" section
  ↓
Call ExitPlanMode with allowedPrompts:
  [
    { tool: "Bash", prompt: "run tests" },
    { tool: "Bash", prompt: "install dependencies" },
    ...
  ]
  ↓
User approves plan + permissions ONCE
  ↓
Execute all tasks without interruption
```

**Behavior**:
- Updates checkboxes as work progresses
- Re-reads plan before each task (context anchoring)
- Uses git for change tracking
- **No permission prompts during execution** (pre-approved)

### 4. Review Phase (`/wf:review`)

**Input**: None (uses current plan + git state)

**Process**:
1. Read current plan
2. Get git diff of changes
3. Generate review export

**Output**: Single markdown file ready to paste into external model

```markdown
# Review Request

## Plan Summary
[From plan file]

## Changes Made
[Git diff formatted]

## Review Questions
1. Does the implementation match the plan?
2. Any security concerns?
3. Edge cases missed?
4. Code quality issues?
```

---

## Project Storage (`.workflow/`)

```
.workflow/
├── specs/                       # From /wf:interview
│   └── 2024-01-18-user-auth.md
├── plans/                       # From /wf:plan
│   └── 2024-01-18-user-auth.md
├── exports/                     # From /wf:review
│   └── review-20240118-143022.md
└── config.md                    # Optional project-specific settings
```

**Note**: Add `.workflow/exports/` to `.gitignore` (temporary files).

---

## Subagents

### Explorer Agent
**Purpose**: Fast codebase understanding
**Tools**: Glob, Grep, Read
**Use**: Gather context before planning

### Reviewer Agent
**Purpose**: Self-review before export
**Tools**: Read, Grep
**Use**: Validate implementation completeness

---

## Token Efficiency

| Aspect | Flow-Next | WF Plugin |
|--------|-----------|-----------|
| Subagents | 10 | 2 |
| Skills | 14 | 5 |
| Task format | JSON + CLI | Markdown |
| Tracking | flowctl commands | File edits |
| Interview | 40+ questions | 10-15 focused |
| Review | Multi-model gates | Single export |

**Estimated savings**: 50-60% fewer tokens per workflow cycle.

---

## Future Enhancements (v2)

- [ ] `/wf:auto` - Autonomous execution with checkpoints
- [ ] `/wf:template` - Save/load plan templates
- [ ] Git worktree support for parallel work
- [ ] Hook system for custom validations

---

## Implementation Order

1. **Core**: plugin.json + folder structure
2. **Interview**: `/wf:interview` with AskUserQuestion
3. **Plan**: `/wf:plan` with explorer agent
4. **Work**: `/wf:work` with progress tracking
5. **Review**: `/wf:review` export generation
6. **Status**: `/wf` help and status
7. **Polish**: Error handling, edge cases
