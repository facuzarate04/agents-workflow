# Team Provider Wiring

Use `providers.providerCommands` in team config to connect real LLM executors.

## Placeholders

- `{{prompt_file}}`: absolute path to generated role prompt file
- `{{topic}}`: original CEO/PM topic
- `{{repo_path}}`: target repository path
- `{{role_id}}`: role id (`pm`, `backend`, etc.)
- `{{role_name}}`: human role name

## Example

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

If a provider command is not configured or fails, the hub falls back to a structured expert hypothesis (`dispatch_required`) so PM can still respond.
