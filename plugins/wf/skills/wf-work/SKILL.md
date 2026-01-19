# WF Work Skill

Execute a plan with upfront permission approval for uninterrupted work.

## Trigger

`/wf:work` or `/wf:work <plan-file>`

Examples:
- `/wf:work` - uses latest plan in .workflow/plans/
- `/wf:work .workflow/plans/2024-01-18-user-auth.md`

## Purpose

Execute all tasks from a plan file. Requests permissions ONCE at the start so execution runs without interruption.

## Process

### 1. Find and Read Plan

If no plan specified, find the latest:

```bash
ls -t .workflow/plans/*.md | head -1
```

Read the plan file and parse:
- Tasks list
- Permissions required
- Files to modify

### 2. Request Permissions (Critical Step)

Extract permissions from the "Permissions Required" section.

Use `EnterPlanMode` tool, then write a brief execution plan, then use `ExitPlanMode` with `allowedPrompts`:

```javascript
ExitPlanMode({
  allowedPrompts: [
    { tool: "Bash", prompt: "run tests" },
    { tool: "Bash", prompt: "install dependencies" },
    // ... other permissions from plan
  ]
})
```

**This is the key feature**: User approves once, then all matching commands run without prompts.

### 3. Execute Tasks

For each task in the plan:

#### Before Starting Task
- Update plan file: mark task as `[IN PROGRESS]`
- Re-read any relevant context

#### Implement Task
- Write/edit code as needed
- Follow acceptance criteria
- Use approved permissions for bash commands

#### After Completing Task
- Update plan file: mark subtasks as `[x]`
- Update task status to complete

### 4. Update Plan Status

After all tasks complete:
- Change plan status from "Pending" to "Completed"
- Add completion timestamp

### 5. Suggest Next Step

Tell the user:
- Summary of what was done
- Any issues encountered
- Suggest `/wf:review` for external review

## Plan File Updates

Update the plan file as you work:

```markdown
### Task 1: Create auth middleware [COMPLETED]

- [x] Create middleware file
- [x] Add JWT validation logic

**Acceptance**: Middleware validates tokens ✓
```

## Important

- ALWAYS use EnterPlanMode → ExitPlanMode with allowedPrompts
- ALWAYS update plan file with progress
- NEVER skip permission request step
- Re-read plan before each task (context anchoring)
- Stop and report if a task cannot be completed
- Do NOT modify files outside the plan scope

## Error Handling

If a task fails:
1. Mark it as `[BLOCKED]` in the plan
2. Add a note explaining why
3. Continue with other tasks if possible
4. Report all blocked tasks at the end
