import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { searchObservations, getObservation, saveObservation, getRelevantContext, formatContextForPrompt, getStats, softDelete, startSession, endSession } from "../core/memory.mjs";
import { runCodeReview, resolveReviewConfig } from "../core/review.mjs";
import { loadTeamConfig } from "../team/config.mjs";
import { runRoleContribution, normalizeToEnvelope } from "../team/providers.mjs";
import { loadProjects, getProject } from "../core/projects.mjs";

const server = new McpServer({
  name: "agent-hub",
  version: "0.1.0"
});

// ──────────────────────────────────────────────
// Memory Tools
// ──────────────────────────────────────────────

server.tool(
  "memory_search",
  "Search observations in the hub memory. Returns matching entries with type, title, and content preview.",
  {
    query: z.string().optional().describe("Search query (FTS5 full-text search). Omit for recent entries."),
    project: z.string().optional().describe("Filter by project name"),
    type: z.string().optional().describe("Filter by type: decision, consultation, execution, error_pattern, preference, project_context"),
    limit: z.number().optional().default(10).describe("Max results to return")
  },
  async (params) => {
    const results = searchObservations({
      query: params.query || undefined,
      project: params.project || undefined,
      type: params.type || undefined,
      limit: params.limit
    });

    if (!results.length) {
      return { content: [{ type: "text", text: "No observations found." }] };
    }

    const lines = results.map((r) =>
      `[#${r.id}] [${r.type}] ${r.title}\n  Project: ${r.project || "global"} | Key: ${r.topic_key || "-"} | Created: ${r.created_at}\n  ${r.content_preview || ""}`
    );

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

server.tool(
  "memory_save",
  "Save an observation to hub memory. Use for decisions, patterns, errors, or project context that should persist across sessions.",
  {
    type: z.enum(["decision", "consultation", "execution", "error_pattern", "preference", "project_context"]).describe("Observation type"),
    title: z.string().describe("Short title for the observation"),
    content: z.string().describe("Full content of the observation"),
    project: z.string().optional().describe("Project name to associate with"),
    topicKey: z.string().optional().describe("Topic key for upsert behavior (same key updates instead of creating new)")
  },
  async (params) => {
    const result = saveObservation({
      type: params.type,
      title: params.title,
      content: params.content,
      project: params.project || undefined,
      topicKey: params.topicKey || undefined
    });

    return {
      content: [{ type: "text", text: `Observation #${result.id} ${result.action}.${result.action === "deduplicated" ? ` (duplicate #${result.duplicateCount})` : ""}${result.action === "updated" ? ` (revision #${result.revisionCount})` : ""}` }]
    };
  }
);

server.tool(
  "memory_get",
  "Get the full content of a specific observation by ID.",
  {
    id: z.number().describe("Observation ID")
  },
  async (params) => {
    const obs = getObservation(params.id);
    if (!obs) {
      return { content: [{ type: "text", text: `Observation #${params.id} not found.` }] };
    }

    const lines = [
      `# Observation #${obs.id}`,
      `Type: ${obs.type}`,
      `Title: ${obs.title}`,
      `Project: ${obs.project || "global"}`,
      `Scope: ${obs.scope}`,
      obs.topic_key ? `Topic key: ${obs.topic_key}` : null,
      `Revisions: ${obs.revision_count} | Duplicates: ${obs.duplicate_count}`,
      `Created: ${obs.created_at} | Updated: ${obs.updated_at}`,
      "",
      obs.content
    ].filter(Boolean);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "memory_context",
  "Get relevant memory context for a project. Returns recent decisions, errors, preferences, and FTS matches. Use this at the start of a task to load prior knowledge.",
  {
    project: z.string().describe("Project name"),
    query: z.string().optional().describe("Optional query to find specific context")
  },
  async (params) => {
    const observations = getRelevantContext({
      project: params.project,
      query: params.query || undefined,
      limit: 8
    });

    if (!observations.length) {
      return { content: [{ type: "text", text: `No memory context found for project "${params.project}".` }] };
    }

    const formatted = formatContextForPrompt(observations);
    return { content: [{ type: "text", text: formatted }] };
  }
);

server.tool(
  "memory_delete",
  "Soft-delete an observation by ID.",
  {
    id: z.number().describe("Observation ID to delete")
  },
  async (params) => {
    softDelete(params.id);
    return { content: [{ type: "text", text: `Observation #${params.id} soft-deleted.` }] };
  }
);

server.tool(
  "memory_stats",
  "Get memory system statistics: total observations, sessions, breakdown by type and project.",
  {},
  async () => {
    const stats = getStats();
    const lines = [
      `Total observations: ${stats.totalObservations}`,
      `Total sessions: ${stats.totalSessions}`,
      "",
      "By type:",
      ...stats.byType.map((t) => `  ${t.type}: ${t.count}`),
      "",
      "By project:",
      ...stats.byProject.map((p) => `  ${p.project}: ${p.count}`),
      "",
      `DB: ${stats.dbPath}`
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ──────────────────────────────────────────────
// Code Review Tool
// ──────────────────────────────────────────────

server.tool(
  "code_review",
  "Run AI-powered code review on changed files in a repository. Reviews git diff against project rules (AGENTS.md/CLAUDE.md).",
  {
    repoPath: z.string().describe("Absolute path to the repository"),
    goal: z.string().optional().default("Code review").describe("Description of what was changed")
  },
  async (params) => {
    const loaded = await loadTeamConfig(params.repoPath);
    const reviewConfig = resolveReviewConfig(loaded.config);

    const configForReview = {
      ...loaded.config,
      gates: {
        ...loaded.config.gates,
        codeReview: { ...reviewConfig, enabled: true }
      }
    };

    const result = await runCodeReview({
      repoPath: params.repoPath,
      teamConfig: configForReview,
      goal: params.goal
    });

    if (result.skipped) {
      return { content: [{ type: "text", text: "No changes to review." }] };
    }

    const icon = result.passed ? "APPROVED" : "CHANGES REQUESTED";
    const lines = [`Verdict: ${icon}`, `Summary: ${result.summary}`];

    if (result.issues?.length) {
      lines.push("", `Issues (${result.issues.length}):`);
      for (const issue of result.issues) {
        lines.push(`  [${issue.severity}] ${issue.file}: ${issue.description}`);
      }
    }

    lines.push("", `Completed in ${Math.round(result.durationMs / 1000)}s`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ──────────────────────────────────────────────
// Team Tools
// ──────────────────────────────────────────────

server.tool(
  "team_roles",
  "List all available team roles and their configuration. Shows role ID, name, provider, and expertise areas.",
  {
    repoPath: z.string().optional().describe("Repository path for repo-specific role overrides")
  },
  async (params) => {
    const loaded = await loadTeamConfig(params.repoPath || undefined);
    const roles = loaded.config.roles || [];

    if (!roles.length) {
      return { content: [{ type: "text", text: "No roles configured." }] };
    }

    const lines = roles.map((r) =>
      `${r.id} (${r.name}) — provider: ${r.provider}\n  ${r.persona}\n  Expertise: ${(r.expertise || []).join(", ")}`
    );

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

server.tool(
  "team_config",
  "Show the merged team configuration including providers, gates, and pipelines.",
  {
    repoPath: z.string().optional().describe("Repository path for repo-specific overrides")
  },
  async (params) => {
    const loaded = await loadTeamConfig(params.repoPath || undefined);
    return { content: [{ type: "text", text: JSON.stringify(loaded.config, null, 2) }] };
  }
);

server.tool(
  "consult_experts",
  "Consult one or more team expert roles on a technical topic. Each role uses its configured AI provider to analyze the question. Use this to get expert opinions on architecture, backend, frontend, QA, or any configured role.",
  {
    roles: z.array(z.string()).describe("Role IDs to consult (e.g. ['backend', 'frontend']). Use team_roles to see available IDs."),
    topic: z.string().describe("The technical question or topic to consult about"),
    repoPath: z.string().optional().describe("Repository path for context"),
    context: z.string().optional().describe("Additional context to include in the consultation")
  },
  async (params) => {
    const loaded = await loadTeamConfig(params.repoPath || undefined);
    const allRoles = loaded.config.roles || [];

    const selectedRoles = params.roles
      .map((id) => allRoles.find((r) => r.id === id))
      .filter(Boolean);

    if (!selectedRoles.length) {
      const available = allRoles.map((r) => r.id).join(", ");
      return { content: [{ type: "text", text: `No matching roles found. Available: ${available}` }] };
    }

    const providerContext = {
      repoPath: params.repoPath || process.cwd(),
      providers: loaded.config.providers,
      mode: "technical-consult"
    };

    const results = [];

    for (const role of selectedRoles) {
      try {
        const result = await runRoleContribution({
          role,
          topic: params.topic,
          context: providerContext,
          pmAnalysis: params.context || null
        });

        const envelope = result.envelope || normalizeToEnvelope(
          result.content?.summary || JSON.stringify(result.content || ""),
          role.name
        );

        results.push({
          role: role.id,
          name: role.name,
          status: result.status || "completed",
          provider: result.provider || role.provider,
          summary: envelope.summary,
          recommendations: envelope.recommendations || [],
          risks: envelope.risks || [],
          durationMs: result.metrics?.totalDurationMs || result.metrics?.durationMs || null
        });
      } catch (err) {
        results.push({
          role: role.id,
          name: role.name,
          status: "error",
          summary: `Error consulting ${role.name}: ${err.message}`
        });
      }
    }

    const lines = results.map((r) => {
      const header = `## ${r.name} (${r.role}) — ${r.status}`;
      const providerLine = r.provider ? `Provider: ${r.provider}` : "";
      const summaryLine = r.summary || "No response";
      const recsLine = r.recommendations?.length
        ? `\nRecommendations:\n${r.recommendations.map((rec) => `  - ${rec}`).join("\n")}`
        : "";
      const risksLine = r.risks?.length
        ? `\nRisks:\n${r.risks.map((risk) => `  - ${risk}`).join("\n")}`
        : "";
      const duration = r.durationMs ? `\n(${Math.round(r.durationMs / 1000)}s)` : "";
      return [header, providerLine, summaryLine, recsLine, risksLine, duration].filter(Boolean).join("\n");
    });

    return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
  }
);

// ──────────────────────────────────────────────
// Project Tools
// ──────────────────────────────────────────────

server.tool(
  "project_list",
  "List all configured projects and their repositories.",
  {},
  async () => {
    const data = await loadProjects();
    const projects = data.projects || {};
    const names = Object.keys(projects);

    if (!names.length) {
      return { content: [{ type: "text", text: "No projects configured. Use hub init or hub project add." }] };
    }

    const lines = names.map((name) => {
      const proj = projects[name];
      const repos = Object.entries(proj.repos || {}).map(
        ([label, r]) => `    ${label}: ${r.path} (${r.type})`
      );
      return `${name}${proj.defaultRepo ? ` [default: ${proj.defaultRepo}]` : ""}\n${repos.join("\n")}`;
    });

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

server.tool(
  "project_show",
  "Show details of a specific project.",
  {
    name: z.string().describe("Project name")
  },
  async (params) => {
    const proj = await getProject(params.name);
    if (!proj) {
      return { content: [{ type: "text", text: `Project "${params.name}" not found.` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(proj, null, 2) }] };
  }
);

// ──────────────────────────────────────────────
// Session Tools
// ──────────────────────────────────────────────

server.tool(
  "session_start",
  "Start a new memory session. Sessions group observations and provide timeline context.",
  {
    sessionId: z.string().describe("Unique session identifier"),
    project: z.string().optional().describe("Project name"),
    channel: z.string().optional().default("mcp").describe("Channel identifier")
  },
  async (params) => {
    const result = startSession({
      sessionId: params.sessionId,
      project: params.project || undefined,
      channel: params.channel
    });
    return { content: [{ type: "text", text: `Session "${result.sessionId}" started at ${result.startedAt}` }] };
  }
);

server.tool(
  "session_end",
  "End a memory session with an optional summary.",
  {
    sessionId: z.string().describe("Session identifier to end"),
    summary: z.string().optional().describe("Brief summary of what was accomplished")
  },
  async (params) => {
    const result = endSession({
      sessionId: params.sessionId,
      summary: params.summary || undefined
    });
    return { content: [{ type: "text", text: `Session "${result.sessionId}" ended at ${result.endedAt}` }] };
  }
);

// ──────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("agent-hub MCP server running on stdio");
