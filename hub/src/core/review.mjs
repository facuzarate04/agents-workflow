import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runDirectProviderCall } from "../team/providers.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_REVIEW_CONFIG = {
  enabled: false,
  provider: "claude-teams",
  timeoutMs: 180_000,
  rulesFile: "AGENTS.md",
  maxDiffLines: 3000
};

/**
 * Run a code review gate on changed files after execution.
 *
 * @param {object} opts
 * @param {string} opts.repoPath - Repository path to review
 * @param {object} opts.teamConfig - Merged team config
 * @param {string} opts.goal - Execution goal description
 * @returns {{ ok: boolean, passed: boolean, summary: string, issues: Array, durationMs: number }}
 */
export async function runCodeReview({ repoPath, teamConfig, goal }) {
  const startedAt = Date.now();
  const reviewConfig = resolveReviewConfig(teamConfig);

  if (!reviewConfig.enabled) {
    return { ok: true, passed: true, skipped: true, summary: "Code review gate disabled.", issues: [], durationMs: 0 };
  }

  // Get git diff of uncommitted and staged changes
  const diff = await getGitDiff(repoPath, reviewConfig.maxDiffLines);
  if (!diff.trim()) {
    return { ok: true, passed: true, skipped: true, summary: "No changes to review.", issues: [], durationMs: 0 };
  }

  // Load rules file if present
  const rules = await loadRulesFile(repoPath, reviewConfig.rulesFile);

  // Build review prompt
  const prompt = buildReviewPrompt({ diff, rules, goal, repoPath });

  // Call provider for review
  const result = await runDirectProviderCall({
    providerName: reviewConfig.provider,
    prompt,
    context: {
      repoPath,
      providers: teamConfig.providers,
      mode: "code-review"
    }
  });

  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    return {
      ok: false,
      passed: false,
      skipped: false,
      summary: `Review provider failed: ${result.error || "unknown error"}`,
      issues: [],
      durationMs
    };
  }

  // Parse review output
  const parsed = parseReviewOutput(result.output);

  return {
    ok: true,
    passed: parsed.passed,
    skipped: false,
    summary: parsed.summary,
    issues: parsed.issues,
    durationMs
  };
}

/**
 * Resolve review config from team config with defaults.
 */
export function resolveReviewConfig(teamConfig) {
  const gateConfig = teamConfig?.gates?.codeReview || {};
  return { ...DEFAULT_REVIEW_CONFIG, ...gateConfig };
}

/**
 * Check if code review gate is enabled in config.
 */
export function isCodeReviewEnabled(teamConfig) {
  return resolveReviewConfig(teamConfig).enabled === true;
}

// --- Internal helpers ---

async function getGitDiff(repoPath, maxLines) {
  try {
    // Get both staged and unstaged changes
    const { stdout: diffStaged } = await execFileAsync("git", ["diff", "--cached", "--no-color"], {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024
    });
    const { stdout: diffUnstaged } = await execFileAsync("git", ["diff", "--no-color"], {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024
    });

    let combined = "";
    if (diffStaged.trim()) combined += diffStaged;
    if (diffUnstaged.trim()) combined += (combined ? "\n" : "") + diffUnstaged;

    // If no working-tree changes, try last commit diff (execution may have committed)
    if (!combined.trim()) {
      const { stdout: lastCommitDiff } = await execFileAsync("git", ["diff", "HEAD~1", "--no-color"], {
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024
      });
      combined = lastCommitDiff;
    }

    // Truncate if too large
    const lines = combined.split("\n");
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join("\n") + `\n\n... (truncated, ${lines.length - maxLines} more lines)`;
    }

    return combined;
  } catch {
    return "";
  }
}

async function loadRulesFile(repoPath, rulesFileName) {
  const candidates = [
    path.join(repoPath, rulesFileName),
    path.join(repoPath, ".agent-hub", rulesFileName),
    path.join(repoPath, "CLAUDE.md")
  ];

  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (content.trim()) return { path: filePath, content };
    } catch {
      // file not found, try next
    }
  }

  return null;
}

function buildReviewPrompt({ diff, rules, goal, repoPath }) {
  const rulesSection = rules
    ? `## Project Rules (from ${path.basename(rules.path)})\n\n${rules.content}\n\n`
    : "";

  return `You are a senior code reviewer. Review the following code changes for quality, correctness, and adherence to project rules.

## Context

Repository: ${repoPath}
Execution goal: ${goal}

${rulesSection}## Code Changes (git diff)

\`\`\`diff
${diff}
\`\`\`

## Instructions

Analyze the diff and provide your review in the following JSON format:

\`\`\`json
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "Brief overall assessment (1-2 sentences)",
  "issues": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "file": "path/to/file",
      "description": "What the issue is and how to fix it"
    }
  ],
  "strengths": ["Good things about the changes"]
}
\`\`\`

Rules:
- "approve" = no critical or warning issues, code is production-ready
- "request_changes" = has critical issues that must be fixed
- "comment" = has warnings or suggestions but can be merged
- Only flag real issues, not style nitpicks unless rules explicitly require them
- Be concise and actionable`;
}

function parseReviewOutput(rawOutput) {
  // Try to extract JSON from the output
  const jsonMatch = rawOutput.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  let parsed = null;

  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      // fall through to text parsing
    }
  }

  if (!parsed) {
    // Try direct JSON parse
    try {
      parsed = JSON.parse(rawOutput.trim());
    } catch {
      // fall through to text parsing
    }
  }

  if (parsed && parsed.verdict) {
    const passed = parsed.verdict === "approve" || parsed.verdict === "comment";
    const criticalCount = (parsed.issues || []).filter((i) => i.severity === "critical").length;
    const warningCount = (parsed.issues || []).filter((i) => i.severity === "warning").length;

    return {
      passed,
      summary: parsed.summary || (passed ? "Review passed" : "Review found issues"),
      issues: (parsed.issues || []).map((i) => ({
        severity: i.severity || "suggestion",
        file: i.file || "unknown",
        description: i.description || ""
      })),
      verdict: parsed.verdict,
      strengths: parsed.strengths || [],
      criticalCount,
      warningCount
    };
  }

  // Text fallback: look for keywords
  const lower = rawOutput.toLowerCase();
  const hasCritical = lower.includes("critical") || lower.includes("must fix") || lower.includes("security vulnerability");
  const passed = !hasCritical;

  return {
    passed,
    summary: rawOutput.slice(0, 300),
    issues: [],
    verdict: passed ? "comment" : "request_changes",
    strengths: [],
    criticalCount: 0,
    warningCount: 0
  };
}

/**
 * Format review result for Slack display.
 */
export function formatReviewForSlack(reviewResult) {
  if (reviewResult.skipped) return "";

  const icon = reviewResult.passed ? "\u2705" : "\u274C";
  const verdict = reviewResult.passed ? "Approved" : "Changes Requested";
  const lines = [`\n---\n*${icon} Code Review: ${verdict}*`];
  lines.push(reviewResult.summary);

  if (reviewResult.issues && reviewResult.issues.length > 0) {
    lines.push("");
    for (const issue of reviewResult.issues.slice(0, 8)) {
      const severityIcon = issue.severity === "critical" ? "\u{1F534}" : issue.severity === "warning" ? "\u{1F7E1}" : "\u{1F535}";
      lines.push(`${severityIcon} \`${issue.file}\`: ${issue.description}`);
    }
    if (reviewResult.issues.length > 8) {
      lines.push(`_...and ${reviewResult.issues.length - 8} more issues_`);
    }
  }

  lines.push(`_Review completed in ${Math.round(reviewResult.durationMs / 1000)}s_`);
  return lines.join("\n");
}
