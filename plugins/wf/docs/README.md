# WF - Lightweight Development Workflow Plugin

A minimal Claude Code plugin for structured development workflows.

## Philosophy

- **Simple**: Markdown files over complex JSON
- **Fast**: 2 agents instead of 10
- **Token-efficient**: 50-60% fewer tokens than heavy workflow systems
- **Uninterrupted**: Approve permissions once, execute without prompts

## Installation

Copy the `wf/` folder to your Claude Code plugins directory:

```bash
cp -r wf ~/.claude/plugins/
```

Or symlink for development:

```bash
ln -s /path/to/wf ~/.claude/plugins/wf
```

## Commands

| Command | Description |
|---------|-------------|
| `/wf:interview <topic>` | Gather requirements (10-15 questions) |
| `/wf:plan <description>` | Create structured plan with tasks |
| `/wf:work [plan]` | Execute with upfront permission approval |
| `/wf:review` | Export plan + diff for external review |
| `/wf` | Show status and help |

## Workflow

```
/wf:interview → /wf:plan → /wf:work → /wf:review
   (optional)
```

### 1. Interview (Optional)

```
/wf:interview user authentication
```

Asks 10-15 focused questions to gather requirements.
Creates: `.workflow/specs/YYYY-MM-DD-user-auth.md`

### 2. Plan

```
/wf:plan add JWT authentication
# or
/wf:plan .workflow/specs/2024-01-18-user-auth.md
```

Explores codebase, creates structured plan with:
- Tasks and subtasks
- Files to modify
- **Permissions required** (key feature)
- Acceptance criteria

Creates: `.workflow/plans/YYYY-MM-DD-jwt-auth.md`

### 3. Work

```
/wf:work
```

1. Reads plan
2. **Requests all permissions at once**
3. You approve
4. Executes all tasks without interruption
5. Updates plan with progress

### 4. Review

```
/wf:review
```

Generates export file with:
- Plan summary
- Git diff of changes
- Review questions

Creates: `.workflow/exports/review-TIMESTAMP.md`

Copy and paste into ChatGPT/Claude web for external review.

## File Structure

```
your-project/
└── .workflow/
    ├── specs/          # From /wf:interview
    ├── plans/          # From /wf:plan
    └── exports/        # From /wf:review (add to .gitignore)
```

## Key Feature: Upfront Permissions

The `/wf:work` command uses Claude Code's plan mode to request permissions once:

```
Permissions Required:
- run tests
- install dependencies
- run migrations
```

You approve the plan, and these commands run without individual prompts.

## Comparison with flow-next

| Aspect | flow-next | wf |
|--------|-----------|-----|
| Subagents | 10 | 2 |
| Skills | 14 | 5 |
| Task format | JSON + CLI | Markdown |
| Interview | 40+ questions | 10-15 |
| Review | Multi-model gates | Single export |

## Tips

1. **Start small**: Use `/wf:plan` directly for simple features
2. **Use interview**: For complex features with unclear requirements
3. **Check status**: Run `/wf` to see current state
4. **Review exports**: Always review before merging

## License

MIT
