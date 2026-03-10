---
name: wf-review
description: Generate a review export file for external model review. Triggers on /wf:review.
---

# WF Review Skill

Generate a review export file for external model review (ChatGPT, Claude web, etc.).

## Trigger

`/wf:review`

## Purpose

Create a single markdown file containing the plan and all changes made, ready to paste into an external AI for code review.

## Process

### 1. Find Current Plan

Find the latest or in-progress plan:

```bash
ls -t .workflow/plans/*.md | head -1
```

Read the plan file.

### 2. Get Git Changes

Run git commands to gather changes:

```bash
git diff HEAD~N  # or appropriate range
git status
```

If there's a specific branch, compare to main/master.

### 3. Optional: Run Reviewer Agent

Use Task tool with the **reviewer agent** for quick self-check:

```
Task tool with subagent_type based on agents/reviewer.md
Prompt: "Review these changes against the plan. Check for obvious issues."
```

### 4. Generate Export File

Create export directory:

```bash
mkdir -p .workflow/exports
```

Generate filename: `review-YYYYMMDD-HHMMSS.md`

Write the export:

```markdown
# Code Review Request

**Generated**: YYYY-MM-DD HH:MM
**Plan**: <plan filename>

---

## Plan Summary

<Copy the Context, Tasks, and Acceptance Criteria from the plan>

---

## Files Changed

<List of files from git status>

---

## Changes

<Git diff output, formatted for readability>

---

## Review Questions

Please review this implementation and provide feedback on:

1. **Correctness**: Does the code match the plan requirements?
2. **Security**: Any security vulnerabilities or concerns?
3. **Edge Cases**: Are edge cases handled properly?
4. **Code Quality**: Is the code clean, readable, and maintainable?
5. **Performance**: Any performance concerns?
6. **Missing Items**: Anything from the plan that wasn't implemented?

---

## Additional Context

<Any notes or context that would help the reviewer>
```

### 5. Output Location

Tell the user:
- Export file location
- File size (for token estimation)
- Instructions: "Copy the contents and paste into ChatGPT/Claude for review"

## Important

- Include FULL git diff - external model needs complete context
- Format diff for readability (use code blocks)
- Do NOT include sensitive data (check for .env, credentials)
- Keep review questions focused and actionable

## Security Check

Before generating export, scan for sensitive patterns:

```bash
git diff | grep -i -E "(password|secret|api_key|token|credential)"
```

If found, warn the user and ask if they want to proceed.
