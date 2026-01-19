# WF Interview Skill

Gather requirements through focused questions to create a spec file.

## Trigger

`/wf:interview <topic>`

Example: `/wf:interview user authentication`

## Purpose

Extract clear requirements before planning. Produces a spec file that `/wf:plan` can use.

## Process

### 1. Create Spec File

First, create the spec file structure:

```bash
mkdir -p .workflow/specs
```

Generate filename: `YYYY-MM-DD-<slug>.md` where slug is topic in kebab-case.

### 2. Ask Questions (10-15 total)

Use `AskUserQuestion` tool for ALL questions. Group 2-4 related questions per call.

**Question Categories:**

1. **Problem** (2-3 questions)
   - What problem are we solving?
   - Who is affected?
   - What's the current pain point?

2. **Scope** (2-3 questions)
   - What's included in this feature?
   - What's explicitly out of scope?
   - Any related features to consider?

3. **Behavior** (3-4 questions)
   - How should it work for the user?
   - What are the edge cases?
   - Error handling preferences?
   - Any UI/UX requirements?

4. **Technical** (2-3 questions)
   - Any technology constraints?
   - Integration requirements?
   - Performance considerations?

5. **Validation** (1-2 questions)
   - How do we know it's done?
   - What tests are needed?

### 3. Write Spec File

After gathering answers, write the spec file:

```markdown
# Spec: <Feature Name>

**Created**: YYYY-MM-DD
**Status**: Ready for planning

## Problem

<What problem we're solving>

## Requirements

- Requirement 1
- Requirement 2
- ...

## Constraints

- Constraint 1
- Constraint 2

## User Decisions

- Q: <Question asked>
  A: <User's answer>

- Q: <Another question>
  A: <Answer>

## Out of Scope

- Item 1
- Item 2

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
```

### 4. Confirm Completion

Tell the user:
- Spec file location
- Suggest running `/wf:plan <spec-file>` next

## Important

- Do NOT ask 40+ questions - keep it focused (10-15 max)
- Do NOT output questions as text - use AskUserQuestion tool
- Do NOT skip questions even if topic seems simple
- Capture ALL user responses in the spec file
