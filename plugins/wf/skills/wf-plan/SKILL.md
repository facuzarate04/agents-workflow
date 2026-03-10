---
name: wf-plan
description: Create a structured implementation plan from a description or spec file. Triggers on /wf:plan.
---

# WF Plan Skill

Create a structured implementation plan from a description or spec file.

## Trigger

`/wf:plan <description>` or `/wf:plan <spec-file>`

Examples:
- `/wf:plan add user authentication with JWT`
- `/wf:plan .workflow/specs/2024-01-18-user-auth.md`

## Purpose

Generate a detailed plan with tasks, files to modify, and required permissions. This plan is used by `/wf:work` for execution.

## Process

### 1. Gather Context

If input is a spec file, read it first.

Then use the **explorer agent** (via Task tool) to understand the codebase:

```
Task tool with subagent_type: "Explore"
Prompt: "Find files and patterns related to <topic>. Focus on:
- Existing similar implementations
- Files that will need modification
- Architecture patterns used
Return a structured summary."
```

### 2. Identify Permissions

Based on the codebase and task, determine what bash commands will be needed:

Common permissions:
- `run tests` - if project has tests
- `install dependencies` - if new packages needed
- `run database migrations` - if DB changes
- `build the project` - if build step exists
- `run linter` - if linting configured

### 3. Create Plan File

```bash
mkdir -p .workflow/plans
```

Generate filename: `YYYY-MM-DD-<slug>.md`

Write the plan:

```markdown
# Plan: <Feature Name>

**Created**: YYYY-MM-DD
**Status**: Pending
**Spec**: <link to spec file if exists>

## Context

<Brief description of what we're building and why>

## Permissions Required

Commands needed for uninterrupted execution:
- <permission 1>
- <permission 2>

## Files to Modify

- `path/to/file.ext` - <reason>
- `path/to/other.ext` - <reason>

## Files to Create

- `path/to/new.ext` - <purpose>

## Tasks

### Task 1: <Title>

<Description of what to do>

- [ ] Subtask a
- [ ] Subtask b

**Acceptance**: <How to verify this task is complete>

### Task 2: <Title>

<Description>

- [ ] Subtask a

**Acceptance**: <Verification criteria>

## Notes

<Edge cases, considerations, warnings>

## Dependencies

<Any external dependencies or blockers>
```

### 4. Confirm and Suggest Next Step

Tell the user:
- Plan file location
- Summary of tasks
- Permissions that will be requested
- Suggest running `/wf:work` next

## Important

- Do NOT write any code - planning only
- Do NOT skip the explorer agent - always gather context first
- Do NOT forget the Permissions section - critical for uninterrupted work
- Keep tasks atomic - one clear outcome per task
- Include acceptance criteria for every task
