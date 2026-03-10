import path from "node:path";
import fs from "node:fs/promises";
import { HUB_ROOT, ensureDir, makeRunId, nowIso, writeJsonFile } from "../core/utils.mjs";
import { runRoleContribution } from "./providers.mjs";

function buildSessionId() {
  return `team-${makeRunId()}`;
}

function buildSessionDir(sessionId) {
  return path.join(HUB_ROOT, ".state", "teams", sessionId);
}

function buildDecisionPack({ topic, repoPath, outputs }) {
  const recommendations = [];
  const risks = [];

  for (const output of outputs) {
    const content = output.result?.content;
    if (!content) {
      continue;
    }

    for (const item of content.recommendations || []) {
      recommendations.push(`${output.role.name}: ${item}`);
    }
    for (const item of content.risks || []) {
      risks.push(`${output.role.name}: ${item}`);
    }
  }

  return {
    topic,
    repoPath,
    generatedAt: nowIso(),
    recommendations,
    risks,
    decisionOptions: [
      {
        id: "A",
        title: "Conservative",
        summary: "Prioritize low-risk incremental delivery with strict gates."
      },
      {
        id: "B",
        title: "Balanced",
        summary: "Deliver core scope fast with targeted risk mitigation."
      },
      {
        id: "C",
        title: "Aggressive",
        summary: "Optimize for speed and innovation, accept higher delivery risk."
      }
    ]
  };
}

function renderMarkdownReport(session, decisionPack) {
  const lines = [
    `# Team Brainstorm Report`,
    "",
    `- Session: ${session.sessionId}`,
    `- Team: ${session.teamName}`,
    `- Topic: ${session.topic}`,
    `- Repo: ${session.repoPath || "n/a"}`,
    `- Created: ${session.createdAt}`,
    "",
    "## Role Outputs"
  ];

  for (const output of session.outputs) {
    lines.push(`### ${output.role.name} (${output.role.id})`);
    lines.push(`- Provider: ${output.result.provider}`);
    lines.push(`- Status: ${output.result.status}`);

    if (output.result.content?.summary) {
      lines.push(`- Summary: ${output.result.content.summary}`);
    }

    const recommendations = output.result.content?.recommendations || [];
    if (recommendations.length > 0) {
      lines.push("- Recommendations:");
      for (const rec of recommendations) {
        lines.push(`  - ${rec}`);
      }
    }

    const risks = output.result.content?.risks || [];
    if (risks.length > 0) {
      lines.push("- Risks:");
      for (const risk of risks) {
        lines.push(`  - ${risk}`);
      }
    }

    if (output.result.note) {
      lines.push(`- Note: ${output.result.note}`);
    }

    lines.push("");
  }

  lines.push("## Decision Pack");
  lines.push("");
  lines.push("### Recommendations");
  for (const rec of decisionPack.recommendations) {
    lines.push(`- ${rec}`);
  }
  if (decisionPack.recommendations.length === 0) {
    lines.push("- (none)");
  }

  lines.push("");
  lines.push("### Risks");
  for (const risk of decisionPack.risks) {
    lines.push(`- ${risk}`);
  }
  if (decisionPack.risks.length === 0) {
    lines.push("- (none)");
  }

  lines.push("");
  lines.push("### Decision Options");
  for (const option of decisionPack.decisionOptions) {
    lines.push(`- ${option.id}: ${option.title} - ${option.summary}`);
  }

  return lines.join("\n") + "\n";
}

export async function createBrainstormSession({ teamConfig, repoPath, topic }) {
  const sessionId = buildSessionId();
  const sessionDir = buildSessionDir(sessionId);
  await ensureDir(sessionDir);

  const context = {
    repoPath,
    teamName: teamConfig.name,
    providers: teamConfig.providers
  };

  const outputs = [];
  for (const role of teamConfig.roles) {
    const result = await runRoleContribution({ role, topic, context });
    outputs.push({ role, result });
  }

  const session = {
    sessionId,
    teamName: teamConfig.name,
    topic,
    repoPath,
    createdAt: nowIso(),
    providers: teamConfig.providers,
    outputs
  };

  const decisionPack = buildDecisionPack({ topic, repoPath, outputs });
  const reportMarkdown = renderMarkdownReport(session, decisionPack);

  await Promise.all([
    writeJsonFile(path.join(sessionDir, "session.json"), session),
    writeJsonFile(path.join(sessionDir, "decision-pack.json"), decisionPack),
    fs.writeFile(path.join(sessionDir, "report.md"), reportMarkdown, "utf8")
  ]);

  return {
    session,
    decisionPack,
    sessionDir
  };
}
