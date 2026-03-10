import fs from "node:fs/promises";
import path from "node:path";
import { HUB_ROOT, nowIso, readJsonFile, writeJsonFile } from "./utils.mjs";

const RUNS_DIR = path.join(HUB_ROOT, ".state", "runs");

export function getRunDir(runId) {
  return path.join(RUNS_DIR, runId);
}

function toRepoSlug(repoPath) {
  if (!repoPath) {
    return "detached";
  }
  return repoPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export async function listRuns(limit = 20) {
  let entries = [];
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const runIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, limit);

  const results = [];
  for (const runId of runIds) {
    const taskResult = await readJsonFile(path.join(getRunDir(runId), "task-result.json"), null);
    if (!taskResult) {
      continue;
    }

    results.push({
      runId,
      status: taskResult.status,
      workflow: taskResult.workflow,
      repoPath: taskResult.repoPath,
      goal: taskResult.goal,
      createdAt: taskResult.createdAt,
      updatedAt: taskResult.updatedAt || taskResult.createdAt
    });
  }

  return results;
}

export async function loadRun(runId) {
  const runDir = getRunDir(runId);
  const [taskSpec, taskResult, executionPlan, gateReport, checkpoint, policyContext] = await Promise.all([
    readJsonFile(path.join(runDir, "task-spec.json"), null),
    readJsonFile(path.join(runDir, "task-result.json"), null),
    readJsonFile(path.join(runDir, "execution-plan.json"), null),
    readJsonFile(path.join(runDir, "gate-report.json"), null),
    readJsonFile(path.join(runDir, "checkpoint.json"), null),
    readJsonFile(path.join(runDir, "policy-context.json"), null)
  ]);

  if (!taskSpec || !taskResult || !executionPlan || !gateReport) {
    throw new Error(`run not found or incomplete: ${runId}`);
  }

  return {
    runId,
    runDir,
    taskSpec,
    taskResult,
    executionPlan,
    gateReport,
    checkpoint,
    policyContext
  };
}

export async function saveRunFiles(runId, { taskResult, executionPlan, gateReport, checkpoint }) {
  const runDir = getRunDir(runId);
  const writes = [];

  if (taskResult) {
    const next = {
      ...taskResult,
      updatedAt: nowIso()
    };
    writes.push(writeJsonFile(path.join(runDir, "task-result.json"), next));
  }

  if (executionPlan) {
    writes.push(writeJsonFile(path.join(runDir, "execution-plan.json"), executionPlan));
  }

  if (gateReport) {
    writes.push(writeJsonFile(path.join(runDir, "gate-report.json"), gateReport));
  }

  if (checkpoint) {
    writes.push(writeJsonFile(path.join(runDir, "checkpoint.json"), checkpoint));
    const repoPath = taskResult?.repoPath;
    if (repoPath) {
      const projectDir = path.join(HUB_ROOT, ".state", "projects", toRepoSlug(repoPath));
      writes.push(writeJsonFile(path.join(projectDir, "checkpoint.latest.json"), checkpoint));
    }
  }

  await Promise.all(writes);
}

export function appendTimeline(taskResult, event) {
  const timeline = Array.isArray(taskResult.timeline) ? taskResult.timeline : [];
  timeline.push({ at: nowIso(), ...event });
  return timeline;
}
