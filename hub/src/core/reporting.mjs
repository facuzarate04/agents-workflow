import path from "node:path";
import { ensureDir, nowIso, writeJsonFile } from "./utils.mjs";

const STATE_ROOT_NAME = ".state";

function repoSlug(repoPath) {
  if (!repoPath) {
    return "detached";
  }

  return repoPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function getStatePaths(hubRoot, runId, repoPath) {
  const stateRoot = path.join(hubRoot, STATE_ROOT_NAME);
  const runDir = path.join(stateRoot, "runs", runId);
  const projectDir = path.join(stateRoot, "projects", repoSlug(repoPath));

  return { stateRoot, runDir, projectDir };
}

export async function persistRunArtifacts({
  hubRoot,
  runId,
  taskSpec,
  policyContext,
  mcpContext,
  executionPlan,
  workflowRef
}) {
  const { runDir, projectDir } = getStatePaths(hubRoot, runId, taskSpec.repoPath);

  await ensureDir(runDir);
  await ensureDir(projectDir);

  const taskResult = {
    runId,
    createdAt: nowIso(),
    status: "planned",
    workflow: taskSpec.type,
    profile: taskSpec.metadata?.profile || null,
    goal: taskSpec.goal,
    repoPath: taskSpec.repoPath,
    riskHint: taskSpec.riskHint,
    constraints: taskSpec.constraints,
    approvals: {
      required: mcpContext.grouped.reviewRequired.length > 0,
      approved: mcpContext.grouped.reviewRequired.length === 0
    },
    timeline: [
      {
        at: nowIso(),
        type: "run_planned",
        actor: "system"
      }
    ],
    nextActions: [
      "Review execution plan.",
      "Approve or amend constraints.",
      "Execute workflow worker for implementation/verification."
    ]
  };

  const gateReport = {
    runId,
    createdAt: nowIso(),
    gates: executionPlan.gates,
    requiredGateCount: executionPlan.gates.filter((gate) => gate.required).length
  };

  const checkpoint = {
    runId,
    version: "1.0",
    createdAt: nowIso(),
    objective: taskSpec.goal,
    workflow: taskSpec.type,
    riskHint: taskSpec.riskHint,
    businessRules: policyContext.mergedRules.notes || [],
    decisions: [
      `Workflow selected: ${taskSpec.type}`,
      `Risk hint: ${taskSpec.riskHint}`,
      `Trusted MCPs: ${executionPlan.selectedMcp.trusted.join(", ") || "none"}`
    ],
    changedFiles: [],
    openQuestions: [],
    nextActions: taskResult.nextActions,
    sources: {
      workflowPath: workflowRef.workflowPath,
      globalPolicy: "hub/config/global-policy.json",
      globalMcpRegistry: "hub/config/mcp-registry.json"
    }
  };

  await Promise.all([
    writeJsonFile(path.join(runDir, "task-spec.json"), taskSpec),
    writeJsonFile(path.join(runDir, "policy-context.json"), policyContext),
    writeJsonFile(path.join(runDir, "mcp-context.json"), mcpContext),
    writeJsonFile(path.join(runDir, "execution-plan.json"), executionPlan),
    writeJsonFile(path.join(runDir, "gate-report.json"), gateReport),
    writeJsonFile(path.join(runDir, "task-result.json"), taskResult),
    writeJsonFile(path.join(runDir, "checkpoint.json"), checkpoint),
    writeJsonFile(path.join(projectDir, "checkpoint.latest.json"), checkpoint)
  ]);

  return {
    runDir,
    projectDir,
    taskResult,
    gateReport,
    checkpoint
  };
}
