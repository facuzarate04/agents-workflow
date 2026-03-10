import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nowIso } from "./utils.mjs";
import { appendTimeline, saveRunFiles } from "./runs.mjs";
import { inspectWorktreeChanges } from "./git.mjs";

const execFileAsync = promisify(execFile);

const GATE_TO_SCRIPT = {
  tests: "test",
  lint: "lint",
  typecheck: "typecheck",
  e2e: "e2e"
};

function parseScriptsFromPackageJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.scripts || {};
  } catch {
    return {};
  }
}

async function getPackageScripts(repoPath) {
  try {
    const pkg = await fs.readFile(path.join(repoPath, "package.json"), "utf8");
    return parseScriptsFromPackageJson(pkg);
  } catch {
    return {};
  }
}

async function runNpmScript(repoPath, script) {
  try {
    const { stdout, stderr } = await execFileAsync("npm", ["run", "--silent", script], {
      cwd: repoPath,
      env: process.env,
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 10
    });

    return {
      ok: true,
      stdout: stdout?.trim() || "",
      stderr: stderr?.trim() || ""
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || error.message
    };
  }
}

function setStepStatus(steps, stepId, status) {
  return steps.map((step) => (step.id === stepId ? { ...step, status, updatedAt: nowIso() } : step));
}

function setGateResult(gates, gateId, patch) {
  return gates.map((gate) => (gate.id === gateId ? { ...gate, ...patch, updatedAt: nowIso() } : gate));
}

function getImplementationCommand(run) {
  const commands = run.policyContext?.repo?.commands || {};
  if (commands.implementByWorkflow && typeof commands.implementByWorkflow === "object") {
    const byWorkflow = commands.implementByWorkflow[run.taskSpec.type];
    if (typeof byWorkflow === "string" && byWorkflow.trim()) {
      return byWorkflow.trim();
    }
  }

  if (typeof commands.implement === "string" && commands.implement.trim()) {
    return commands.implement.trim();
  }

  return null;
}

async function runImplementationCommand(run) {
  const command = getImplementationCommand(run);
  if (!command) {
    return {
      ok: true,
      status: "skipped",
      command: null,
      reason: "no implementation command configured in repo profile"
    };
  }

  const executionRepoPath = run.taskResult.execution?.worktreePath || run.taskSpec.repoPath;
  const env = {
    ...process.env,
    HUB_RUN_ID: run.runId,
    HUB_GOAL: run.taskSpec.goal,
    HUB_WORKFLOW: run.taskSpec.type,
    HUB_REPO_PATH: run.taskSpec.repoPath,
    HUB_WORKTREE_PATH: executionRepoPath
  };

  try {
    const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], {
      cwd: executionRepoPath,
      env,
      timeout: 20 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 20
    });

    return {
      ok: true,
      status: "passed",
      command,
      stdout: stdout?.trim() || "",
      stderr: stderr?.trim() || ""
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      command,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || error.message
    };
  }
}

async function evaluateGates(run) {
  const executionRepoPath = run.taskResult.execution?.worktreePath || run.taskSpec.repoPath;
  const scripts = await getPackageScripts(executionRepoPath);
  let gates = [...run.executionPlan.gates];
  const gateLogs = [];

  for (const gate of gates) {
    if (!["pending", "skipped"].includes(gate.status)) {
      continue;
    }

    if (gate.id in GATE_TO_SCRIPT) {
      const scriptName = GATE_TO_SCRIPT[gate.id];
      if (!scripts[scriptName]) {
        if (gate.required) {
          gates = setGateResult(gates, gate.id, {
            status: "failed",
            rationale: `required gate but script '${scriptName}' was not found in package.json`
          });
        } else {
          gates = setGateResult(gates, gate.id, {
            status: "skipped",
            rationale: `optional gate skipped: script '${scriptName}' not found`
          });
        }

        gateLogs.push({ gateId: gate.id, command: `npm run --silent ${scriptName}`, status: gates.find((g) => g.id === gate.id)?.status });
        continue;
      }

      const result = await runNpmScript(executionRepoPath, scriptName);
      gates = setGateResult(gates, gate.id, {
        status: result.ok ? "passed" : "failed",
        rationale: result.ok
          ? `script '${scriptName}' completed`
          : `script '${scriptName}' failed`
      });

      gateLogs.push({
        gateId: gate.id,
        command: `npm run --silent ${scriptName}`,
        status: result.ok ? "passed" : "failed",
        stderr: result.stderr ? result.stderr.slice(0, 500) : ""
      });
      continue;
    }

    gates = setGateResult(gates, gate.id, {
      status: "passed",
      rationale: "manual/documentation gate auto-passed in MVP"
    });
    gateLogs.push({ gateId: gate.id, status: "passed", command: "manual" });
  }

  return {
    gates,
    gateLogs
  };
}

export async function executeRun(run, options = {}) {
  const taskResult = {
    ...run.taskResult,
    status: "running",
    timeline: appendTimeline(run.taskResult, { type: "run_started", actor: options.actor || "cli" })
  };

  const executionPlan = {
    ...run.executionPlan,
    steps: run.executionPlan.steps.map((step) => ({ ...step, status: "pending" }))
  };

  const gateReport = {
    ...run.gateReport
  };

  await saveRunFiles(run.runId, { taskResult, executionPlan, gateReport });

  let steps = executionPlan.steps;
  for (const step of steps) {
    steps = setStepStatus(steps, step.id, "running");
    await saveRunFiles(run.runId, { executionPlan: { ...executionPlan, steps } });

    steps = setStepStatus(steps, step.id, "completed");
    await saveRunFiles(run.runId, { executionPlan: { ...executionPlan, steps } });
  }

  const implementation = await runImplementationCommand(run);
  const stepSet = setStepStatus(
    steps,
    "implementation",
    implementation.status === "failed" ? "failed" : "completed"
  );
  steps = stepSet;
  await saveRunFiles(run.runId, { executionPlan: { ...executionPlan, steps } });

  if (!implementation.ok) {
    const failedResult = {
      ...taskResult,
      status: "failed",
      implementation,
      timeline: appendTimeline(taskResult, {
        type: "run_finished",
        actor: options.actor || "cli",
        outcome: "failed"
      }),
      nextActions: [
        "Inspect implementation command logs.",
        "Adjust repo .agent-hub/repo-profile.json commands and rerun."
      ]
    };

    const checkpoint = {
      ...(run.checkpoint || {}),
      runId: run.runId,
      version: "1.0",
      createdAt: run.checkpoint?.createdAt || run.taskResult.createdAt || nowIso(),
      updatedAt: nowIso(),
      objective: run.taskSpec.goal,
      workflow: run.taskSpec.type,
      riskHint: run.taskSpec.riskHint,
      businessRules: run.checkpoint?.businessRules || [],
      decisions: [
        ...(run.checkpoint?.decisions || []),
        "Execution outcome: failed",
        "Implementation command failed"
      ],
      changedFiles: run.checkpoint?.changedFiles || [],
      openQuestions: [implementation.stderr || "implementation command failed"],
      nextActions: failedResult.nextActions,
      sources: run.checkpoint?.sources || {}
    };

    await saveRunFiles(run.runId, {
      taskResult: failedResult,
      executionPlan: { ...executionPlan, steps },
      checkpoint
    });

    return {
      status: "failed",
      gateReport,
      taskResult: failedResult
    };
  }

  const gateEval = await evaluateGates({ ...run, executionPlan: { ...executionPlan, steps } });
  const changes = await inspectWorktreeChanges(run.taskResult.execution?.worktreePath || run.taskSpec.repoPath);

  const requiredFailures = gateEval.gates.filter((gate) => gate.required && gate.status !== "passed");
  const finalStatus = requiredFailures.length === 0 ? "completed" : "failed";

  const finalizedResult = {
    ...taskResult,
    status: finalStatus,
    implementation,
    gateLogs: gateEval.gateLogs,
    changedFiles: changes.ok ? changes.changedFiles : [],
    timeline: appendTimeline(taskResult, {
      type: "run_finished",
      actor: options.actor || "cli",
      outcome: finalStatus
    }),
    nextActions:
      finalStatus === "completed"
        ? [
            "Inspect generated artifacts and gate logs.",
            "Open a PR from worktree branch after implementation worker is connected."
          ]
        : [
            "Inspect failed gates in gate-report.json.",
            "Fix failing checks or adjust repo policy/scripts."
          ]
  };

  const finalizedGateReport = {
    ...gateReport,
    createdAt: gateReport.createdAt || nowIso(),
    updatedAt: nowIso(),
    gates: gateEval.gates,
    requiredGateCount: gateEval.gates.filter((gate) => gate.required).length,
    requiredFailedCount: requiredFailures.length
  };

  const checkpoint = {
    ...(run.checkpoint || {}),
    runId: run.runId,
    version: "1.0",
    createdAt: run.checkpoint?.createdAt || run.taskResult.createdAt || nowIso(),
    updatedAt: nowIso(),
    objective: run.taskSpec.goal,
    workflow: run.taskSpec.type,
    riskHint: run.taskSpec.riskHint,
    businessRules: run.checkpoint?.businessRules || [],
    decisions: [
      ...(run.checkpoint?.decisions || []),
      `Execution outcome: ${finalStatus}`
    ],
    changedFiles: changes.ok ? changes.changedFiles : run.checkpoint?.changedFiles || [],
    openQuestions: requiredFailures.map((gate) => `${gate.id}: ${gate.rationale}`),
    nextActions: finalizedResult.nextActions,
    sources: run.checkpoint?.sources || {}
  };

  if (changes.ok) {
    try {
      await fs.writeFile(path.join(run.runDir, "diff.patch"), changes.diff || "", "utf8");
    } catch {
      // ignore diff write failures in MVP
    }
  }

  await saveRunFiles(run.runId, {
    taskResult: finalizedResult,
    executionPlan: { ...executionPlan, steps },
    gateReport: finalizedGateReport,
    checkpoint
  });

  return {
    status: finalStatus,
    gateReport: finalizedGateReport,
    taskResult: finalizedResult
  };
}
