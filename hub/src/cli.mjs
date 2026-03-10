import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseNaturalTask } from "./core/intent.mjs";
import { loadPolicyContext, loadMcpContext } from "./core/policy.mjs";
import { draftExecutionPlan, loadWorkflow } from "./core/workflows.mjs";
import { HUB_ROOT, makeRunId } from "./core/utils.mjs";
import { persistRunArtifacts } from "./core/reporting.mjs";
import { appendTimeline, listRuns, loadRun, saveRunFiles } from "./core/runs.mjs";
import { executeRun } from "./core/worker.mjs";
import { cleanupWorktreeForRun, commitWorktreeChanges, ensureWorktreeForRun, inspectWorktreeChanges, pushWorktreeBranch } from "./core/git.mjs";
import { getProfileState, listAllowedProfiles, requireSelectedProfile, selectProfile } from "./core/profile.mjs";
import { createPullRequest, ensureGhAvailable } from "./core/github.mjs";
import {
  listSlackChannels,
  loadSlackRepoMap,
  notifyRunToSlack,
  removeSlackRepoMapping,
  resolveSlackChannel,
  saveSlackRepoMap,
  setSlackRepoMapping,
  startSlackSocketMode
} from "./integrations/slack.mjs";
import { loadTeamConfig, scaffoldRoleInRepo } from "./team/config.mjs";
import { createBrainstormSession } from "./team/session.mjs";
import { runRoleContribution } from "./team/providers.mjs";
import { loadProjects, getProject, addProject, removeProject, addRepoToProject, removeRepoFromProject } from "./core/projects.mjs";
import { searchObservations, getObservation, getStats, softDelete, closeMemory } from "./core/memory.mjs";
import { runCodeReview, resolveReviewConfig, formatReviewForSlack } from "./core/review.mjs";
import { runInit } from "./core/init.mjs";

function printHelp() {
  console.log(`
Hub CLI (chat-first)

Usage:
  hub init
  hub chat --repo <path>
  hub run --repo <path> "<natural language request>"
  hub profile current
  hub profile select <work|personal>
  hub list
  hub status <run-id>
  hub start <run-id>
  hub approve <run-id>
  hub reject <run-id> [reason]
  hub stop <run-id> [--cleanup]
  hub commit <run-id> [--message "feat: ..."]
  hub push <run-id>
  hub pr <run-id> [--title "..."] [--body "..."] [--base main]
  hub pushpr <run-id> [--title "..."] [--body "..."] [--base main]
  hub slack notify <run-id> [--channel C123] [--thread 123.45]
  hub slack socket
  hub slack map channels
  hub slack map list
  hub slack map set --channel <#name|CID> --repo <path> [--profile <p>]
  hub slack map set --channel <#name|CID> --project <name> [--profile <p>]
  hub slack map remove --channel <#name|CID>
  hub slack map resolve --channel <#name|CID>
  hub project list
  hub project show --name <name>
  hub project add --name <name> [--default <label>]
  hub project remove --name <name>
  hub project repo add --project <name> --label <l> --path <p> --type <t> [--description <d>]
  hub project repo remove --project <name> --label <l>
  hub team roles [--repo <path>]
  hub team brainstorm --repo <path> "topic"
  hub team provider-check --repo <path> --role <role-id> --topic "question"
  hub team scaffold-role --repo <path> --id pm-data --name "PM Data" [--provider codex]
  hub memory stats
  hub memory search "query" [--project <name>] [--type <type>] [--limit N]
  hub memory get <id>
  hub memory delete <id>
  hub review --repo <path> [--goal "description"]

Options:
  --repo <path>     Target repository path
  --branch <name>   Optional branch hint
  --channel <name>  Metadata channel tag
  --cleanup         Use with 'stop' to remove worktree + branch
`);
}

function parseOptions(rawArgs) {
  const options = {
    repoPath: process.cwd(),
    branch: null,
    channel: "cli",
    args: []
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];

    if (token === "--repo") {
      options.repoPath = rawArgs[i + 1] ? path.resolve(rawArgs[i + 1]) : options.repoPath;
      i += 1;
      continue;
    }

    if (token === "--branch") {
      options.branch = rawArgs[i + 1] || null;
      i += 1;
      continue;
    }

    if (token === "--channel") {
      options.channel = rawArgs[i + 1] || options.channel;
      i += 1;
      continue;
    }

    options.args.push(token);
  }

  return options;
}

function getFlagValue(rawArgs, flagName) {
  const index = rawArgs.indexOf(flagName);
  if (index === -1) {
    return null;
  }

  return rawArgs[index + 1] || null;
}

function getPositionalArgsExcludingFlags(rawArgs, flagsWithValues = []) {
  const skipIndexes = new Set();

  for (const flag of flagsWithValues) {
    const index = rawArgs.indexOf(flag);
    if (index !== -1) {
      skipIndexes.add(index);
      if (rawArgs[index + 1]) {
        skipIndexes.add(index + 1);
      }
    }
  }

  return rawArgs.filter((_, index) => !skipIndexes.has(index));
}

function renderPlanPreview({ runId, taskSpec, executionPlan, artifactPaths }) {
  const requiredGates = executionPlan.gates.filter((gate) => gate.required);

  console.log(`\nRun: ${runId}`);
  console.log(`Workflow: ${executionPlan.workflowName} (${taskSpec.type})`);
  console.log(`Repo: ${taskSpec.repoPath}`);
  console.log(`Risk: ${taskSpec.riskHint}`);
  console.log(`Goal: ${taskSpec.goal}`);

  if (taskSpec.constraints.length > 0) {
    console.log("Constraints:");
    for (const constraint of taskSpec.constraints) {
      console.log(`- ${constraint}`);
    }
  }

  console.log("\nPlanned steps:");
  for (const step of executionPlan.steps) {
    console.log(`${step.order}. ${step.title}`);
  }

  console.log("\nRequired gates:");
  if (requiredGates.length === 0) {
    console.log("- none");
  } else {
    for (const gate of requiredGates) {
      console.log(`- ${gate.id}: ${gate.title}`);
    }
  }

  console.log("\nMCP toolset:");
  console.log(`- trusted: ${executionPlan.selectedMcp.trusted.join(", ") || "none"}`);
  console.log(`- review-required: ${executionPlan.selectedMcp.reviewRequired.join(", ") || "none"}`);
  console.log(`- blocked: ${executionPlan.selectedMcp.blocked.join(", ") || "none"}`);

  console.log("\nArtifacts:");
  console.log(`- run dir: ${artifactPaths.runDir}`);
  console.log(`- checkpoint: ${artifactPaths.projectDir}/checkpoint.latest.json`);
  console.log(`\nNext: hub start ${runId}`);
}

async function processTask(message, options) {
  const profileState = await requireSelectedProfile();
  const runId = makeRunId();
  const taskSpec = parseNaturalTask(message, options);
  taskSpec.metadata.profile = profileState.profile;
  taskSpec.metadata.account = profileState.account;

  const [policyContext, mcpContext, workflowRef] = await Promise.all([
    loadPolicyContext(taskSpec.repoPath),
    loadMcpContext(taskSpec.repoPath),
    loadWorkflow(taskSpec.type)
  ]);

  const executionPlan = draftExecutionPlan({
    workflow: workflowRef.workflow,
    taskSpec,
    policyContext,
    mcpContext
  });

  const persisted = await persistRunArtifacts({
    hubRoot: HUB_ROOT,
    runId,
    taskSpec,
    policyContext,
    mcpContext,
    workflowRef,
    executionPlan
  });

  renderPlanPreview({ runId, taskSpec, executionPlan, artifactPaths: persisted });
}

function renderRunSummary(run) {
  console.log(`\nRun: ${run.runId}`);
  console.log(`Status: ${run.taskResult.status}`);
  console.log(`Workflow: ${run.taskResult.workflow}`);
  if (run.taskResult.profile) {
    console.log(`Profile: ${run.taskResult.profile}`);
  }
  console.log(`Repo: ${run.taskResult.repoPath}`);
  console.log(`Goal: ${run.taskResult.goal}`);
  console.log(`Created: ${run.taskResult.createdAt}`);
  console.log(`Updated: ${run.taskResult.updatedAt || run.taskResult.createdAt}`);

  if (run.taskResult.approvals?.required) {
    const label = run.taskResult.approvals.approved ? "approved" : "pending";
    console.log(`Approvals: ${label}`);
  }

  if (run.taskResult.execution?.worktreePath) {
    console.log(`Worktree: ${run.taskResult.execution.worktreePath}`);
    console.log(`Branch: ${run.taskResult.execution.branch}`);
    console.log(`Base branch: ${run.taskResult.execution.baseRef}`);
    if (run.taskResult.execution.cleanedUp) {
      console.log(`Worktree cleanup: done (${run.taskResult.execution.cleanedUpAt})`);
    }
  }

  if (run.taskResult.lastCommit?.sha) {
    console.log(`Last commit: ${run.taskResult.lastCommit.sha} (${run.taskResult.lastCommit.committedAt})`);
  }
  if (run.taskResult.lastPush?.branch) {
    console.log(`Last push: ${run.taskResult.lastPush.branch} (${run.taskResult.lastPush.pushedAt})`);
  }
  if (run.taskResult.lastPr?.url || run.taskResult.lastPr?.title) {
    console.log(`Last PR: ${run.taskResult.lastPr.url || run.taskResult.lastPr.title}`);
  }

  if (Array.isArray(run.gateReport.gates)) {
    console.log("\nGates:");
    for (const gate of run.gateReport.gates) {
      console.log(`- ${gate.id}: ${gate.status}${gate.required ? " (required)" : ""}`);
    }
  }
}

async function runList() {
  const runs = await listRuns(30);
  if (runs.length === 0) {
    console.log("No runs found.");
    return;
  }

  for (const run of runs) {
    console.log(`${run.runId} | ${run.status} | ${run.workflow} | ${run.goal}`);
  }
}

async function runStatus(rawArgs) {
  const runId = rawArgs[0];
  if (!runId) {
    throw new Error("missing run id");
  }

  const run = await loadRun(runId);
  renderRunSummary(run);
}

async function runApprove(rawArgs) {
  const runId = rawArgs[0];
  if (!runId) {
    throw new Error("missing run id");
  }

  const run = await loadRun(runId);
  const taskResult = {
    ...run.taskResult,
    approvals: {
      required: true,
      approved: true,
      approvedAt: new Date().toISOString()
    },
    status: run.taskResult.status === "awaiting_approval" ? "planned" : run.taskResult.status,
    timeline: appendTimeline(run.taskResult, { type: "approval_granted", actor: "user" })
  };

  await saveRunFiles(runId, { taskResult });
  console.log(`Run ${runId} approved.`);
}

async function runReject(rawArgs) {
  const runId = rawArgs[0];
  const reason = rawArgs.slice(1).join(" ").trim() || "rejected by user";

  if (!runId) {
    throw new Error("missing run id");
  }

  const run = await loadRun(runId);
  const taskResult = {
    ...run.taskResult,
    status: "cancelled",
    rejectionReason: reason,
    timeline: appendTimeline(run.taskResult, { type: "run_rejected", actor: "user", reason })
  };

  await saveRunFiles(runId, { taskResult });
  console.log(`Run ${runId} rejected.`);
}

async function runStop(rawArgs) {
  const runId = rawArgs.find((arg) => !arg.startsWith("--"));
  const shouldCleanup = rawArgs.includes("--cleanup");
  if (!runId) {
    throw new Error("missing run id");
  }

  const run = await loadRun(runId);
  let taskResult = {
    ...run.taskResult,
    status: "cancelled",
    timeline: appendTimeline(run.taskResult, { type: "run_stopped", actor: "user" })
  };

  if (shouldCleanup && run.taskResult.execution?.worktreePath) {
    const cleanup = await cleanupWorktreeForRun({
      repoPath: run.taskSpec.repoPath,
      worktreePath: run.taskResult.execution.worktreePath,
      branch: run.taskResult.execution.branch,
      removeBranch: true
    });

    if (!cleanup.ok) {
      throw new Error(`cleanup failed: ${cleanup.error}`);
    }

    taskResult = {
      ...taskResult,
      execution: {
        ...run.taskResult.execution,
        cleanedUp: true,
        cleanedUpAt: new Date().toISOString()
      },
      timeline: appendTimeline(taskResult, {
        type: "worktree_cleaned",
        actor: "user",
        path: run.taskResult.execution.worktreePath
      })
    };
  }

  await saveRunFiles(runId, { taskResult });
  console.log(`Run ${runId} stopped${shouldCleanup ? " and cleaned up" : ""}.`);
}

async function runCommit(rawArgs) {
  await requireSelectedProfile();
  const runId = rawArgs.find((arg) => !arg.startsWith("--"));
  if (!runId) {
    throw new Error("missing run id");
  }

  const commitMessage = getFlagValue(rawArgs, "--message");
  const run = await loadRun(runId);
  const worktreePath = run.taskResult.execution?.worktreePath;
  if (!worktreePath) {
    throw new Error("run has no worktree. start the run first.");
  }

  const inspect = await inspectWorktreeChanges(worktreePath);
  if (!inspect.ok) {
    throw new Error(`could not inspect changes: ${inspect.error}`);
  }

  if (!inspect.changedFiles.length) {
    console.log(`Run ${runId} has no changes to commit.`);
    return;
  }

  const defaultMessage = `chore(hub-run): ${run.taskResult.workflow} ${runId}`;
  const message = commitMessage || defaultMessage;
  const commit = await commitWorktreeChanges(worktreePath, message);
  if (!commit.ok) {
    throw new Error(`commit failed: ${commit.error}`);
  }

  const taskResult = {
    ...run.taskResult,
    lastCommit: {
      sha: commit.commitSha,
      message,
      committedAt: new Date().toISOString()
    },
    timeline: appendTimeline(run.taskResult, {
      type: "run_committed",
      actor: "user",
      sha: commit.commitSha
    })
  };

  const checkpoint = {
    ...(run.checkpoint || {}),
    runId,
    version: "1.0",
    createdAt: run.checkpoint?.createdAt || run.taskResult.createdAt,
    updatedAt: new Date().toISOString(),
    objective: run.taskSpec.goal,
    workflow: run.taskSpec.type,
    riskHint: run.taskSpec.riskHint,
    businessRules: run.checkpoint?.businessRules || [],
    decisions: [
      ...(run.checkpoint?.decisions || []),
      `Committed changes: ${commit.commitSha}`
    ],
    changedFiles: inspect.changedFiles,
    openQuestions: run.checkpoint?.openQuestions || [],
    nextActions: [
      "Push worktree branch to remote.",
      "Open PR with run summary and gate report."
    ],
    sources: run.checkpoint?.sources || {}
  };

  await saveRunFiles(runId, { taskResult, checkpoint });
  console.log(`Committed run ${runId}: ${commit.commitSha}`);
}

async function runPush(rawArgs) {
  await requireSelectedProfile();
  const runId = rawArgs.find((arg) => !arg.startsWith("--"));
  if (!runId) {
    throw new Error("missing run id");
  }

  const run = await loadRun(runId);
  const worktreePath = run.taskResult.execution?.worktreePath;
  const branch = run.taskResult.execution?.branch;
  if (!worktreePath || !branch) {
    throw new Error("run has no worktree/branch. start the run first.");
  }
  if (run.taskResult.execution?.cleanedUp) {
    throw new Error("run worktree was cleaned up. start a new run to push/pr.");
  }

  const push = await pushWorktreeBranch(worktreePath, branch);
  if (!push.ok) {
    throw new Error(`push failed: ${push.error}`);
  }

  const taskResult = {
    ...run.taskResult,
    lastPush: {
      branch,
      pushedAt: new Date().toISOString()
    },
    timeline: appendTimeline(run.taskResult, {
      type: "run_pushed",
      actor: "user",
      branch
    })
  };

  await saveRunFiles(runId, { taskResult });
  console.log(`Pushed run ${runId} branch: ${branch}`);
}

function buildDefaultPrTitle(run) {
  const template = run.policyContext?.repo?.prTemplate || {};
  if (template?.titlePrefix) {
    return `${template.titlePrefix} ${run.taskSpec.goal || run.taskResult.workflow}`.trim();
  }

  const goal = (run.taskSpec.goal || "").trim();
  if (!goal) {
    return `Hub run ${run.runId}: ${run.taskResult.workflow}`;
  }
  return `${run.taskResult.workflow}: ${goal.slice(0, 72)}`;
}

function buildDefaultPrBody(run) {
  const template = run.policyContext?.repo?.prTemplate || {};
  const changed = Array.isArray(run.taskResult.changedFiles) ? run.taskResult.changedFiles : [];
  const lines = [
    `Run ID: ${run.runId}`,
    `Workflow: ${run.taskResult.workflow}`,
    `Profile: ${run.taskResult.profile || "unknown"}`,
    "",
    "## Goal",
    run.taskSpec.goal || "",
    "",
    "## Gate Summary"
  ];

  if (Array.isArray(template?.sections) && template.sections.length > 0) {
    lines.push("");
    lines.push("## Template Sections");
    for (const section of template.sections) {
      lines.push(`### ${section}`);
      lines.push("- TODO");
      lines.push("");
    }
  }

  for (const gate of run.gateReport.gates || []) {
    lines.push(`- ${gate.id}: ${gate.status}${gate.required ? " (required)" : ""}`);
  }

  lines.push("");
  lines.push("## Changed Files");
  if (changed.length) {
    for (const file of changed.slice(0, 50)) {
      lines.push(`- ${file}`);
    }
  } else {
    lines.push("- (none captured)");
  }

  return lines.join("\n");
}

async function runPr(rawArgs) {
  await requireSelectedProfile();
  const runId = rawArgs.find((arg) => !arg.startsWith("--"));
  if (!runId) {
    throw new Error("missing run id");
  }

  const titleFlag = getFlagValue(rawArgs, "--title");
  const bodyFlag = getFlagValue(rawArgs, "--body");
  const baseFlag = getFlagValue(rawArgs, "--base");

  const run = await loadRun(runId);
  const worktreePath = run.taskResult.execution?.worktreePath;
  const branch = run.taskResult.execution?.branch;
  const base = baseFlag || run.taskResult.execution?.baseRef || "main";
  if (!worktreePath || !branch) {
    throw new Error("run has no worktree/branch. start the run first.");
  }
  if (run.taskResult.execution?.cleanedUp) {
    throw new Error("run worktree was cleaned up. start a new run to push/pr.");
  }

  const ghCheck = await ensureGhAvailable(worktreePath);
  if (!ghCheck.ok) {
    throw new Error(`gh unavailable: ${ghCheck.error}`);
  }

  const title = titleFlag || buildDefaultPrTitle(run);
  const body = bodyFlag || buildDefaultPrBody(run);
  const pr = await createPullRequest({
    cwd: worktreePath,
    base,
    head: branch,
    title,
    body
  });

  if (!pr.ok) {
    throw new Error(`pr create failed: ${pr.error}`);
  }

  const taskResult = {
    ...run.taskResult,
    lastPr: {
      url: pr.url,
      base,
      head: branch,
      title,
      openedAt: new Date().toISOString()
    },
    timeline: appendTimeline(run.taskResult, {
      type: "pr_opened",
      actor: "user",
      url: pr.url || ""
    })
  };

  await saveRunFiles(runId, { taskResult });
  console.log(`PR created for run ${runId}${pr.url ? `: ${pr.url}` : ""}`);
}

async function runPushPr(rawArgs) {
  await requireSelectedProfile();
  const runId = rawArgs.find((arg) => !arg.startsWith("--"));
  if (!runId) {
    throw new Error("missing run id");
  }

  const run = await loadRun(runId);
  const worktreePath = run.taskResult.execution?.worktreePath;
  const branch = run.taskResult.execution?.branch;
  const base = getFlagValue(rawArgs, "--base") || run.taskResult.execution?.baseRef || "main";
  if (!worktreePath || !branch) {
    throw new Error("run has no worktree/branch. start the run first.");
  }
  if (run.taskResult.execution?.cleanedUp) {
    throw new Error("run worktree was cleaned up. start a new run to push/pr.");
  }

  const push = await pushWorktreeBranch(worktreePath, branch);
  if (!push.ok) {
    throw new Error(`push failed: ${push.error}`);
  }

  const ghCheck = await ensureGhAvailable(worktreePath);
  if (!ghCheck.ok) {
    throw new Error(`gh unavailable: ${ghCheck.error}`);
  }

  const title = getFlagValue(rawArgs, "--title") || buildDefaultPrTitle(run);
  const body = getFlagValue(rawArgs, "--body") || buildDefaultPrBody(run);
  const pr = await createPullRequest({
    cwd: worktreePath,
    base,
    head: branch,
    title,
    body
  });
  if (!pr.ok) {
    throw new Error(`pr create failed: ${pr.error}`);
  }

  const taskResult = {
    ...run.taskResult,
    lastPush: {
      branch,
      pushedAt: new Date().toISOString()
    },
    lastPr: {
      url: pr.url,
      base,
      head: branch,
      title,
      openedAt: new Date().toISOString()
    },
    timeline: appendTimeline(run.taskResult, {
      type: "run_pushpr",
      actor: "user",
      url: pr.url || ""
    })
  };

  await saveRunFiles(runId, { taskResult });
  console.log(`Push+PR completed for run ${runId}${pr.url ? `: ${pr.url}` : ""}`);
}

async function runSlack(rawArgs) {
  const subcommand = rawArgs[0];

  if (subcommand === "notify") {
    const runId = rawArgs[1];
    if (!runId) {
      throw new Error("missing run id. Usage: hub slack notify <run-id> [--channel ...]");
    }

    const channel = getFlagValue(rawArgs, "--channel");
    const threadTs = getFlagValue(rawArgs, "--thread");
    const result = await notifyRunToSlack({ runId, channel, threadTs });
    console.log(`Slack message sent for run ${result.runId} to ${result.channel} (${result.ts})`);
    return;
  }

  if (subcommand === "socket") {
    await startSlackSocketMode();
    console.log("[slack] listening for app mentions with format: hub <command>");
    // Keep process alive.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (subcommand === "map") {
    const mapAction = rawArgs[1];

    if (mapAction === "channels") {
      const channels = await listSlackChannels();
      if (!channels.length) {
        console.log("No channels returned.");
        return;
      }
      for (const channel of channels) {
        console.log(`${channel.id} | #${channel.name}${channel.is_private ? " (private)" : ""}`);
      }
      return;
    }

    if (mapAction === "list") {
      const repoMap = await loadSlackRepoMap();
      const entries = Object.entries(repoMap.channels || {});
      if (!entries.length) {
        console.log("No channel mappings configured.");
        return;
      }
      for (const [channel, entry] of entries) {
        if (typeof entry === "string") {
          console.log(`${channel} -> ${entry}`);
        } else if (entry.project) {
          const profileLabel = entry.profile ? ` (profile: ${entry.profile})` : "";
          console.log(`${channel} -> project:${entry.project}${profileLabel}`);
        } else {
          const profileLabel = entry.profile ? ` (profile: ${entry.profile})` : "";
          console.log(`${channel} -> ${entry.repoPath || "unknown"}${profileLabel}`);
        }
      }
      return;
    }

    if (mapAction === "set") {
      const channelInput = getFlagValue(rawArgs, "--channel");
      const repoPath = getFlagValue(rawArgs, "--repo");
      const projectName = getFlagValue(rawArgs, "--project");
      const profile = getFlagValue(rawArgs, "--profile");

      if (!channelInput || (!repoPath && !projectName)) {
        throw new Error("usage: hub slack map set --channel <#name|CID> --repo <path> [--profile <p>]\n       hub slack map set --channel <#name|CID> --project <name> [--profile <p>]");
      }

      if (projectName) {
        const project = await getProject(projectName);
        if (!project) {
          throw new Error(`project not found: ${projectName}. Use 'hub project add' first.`);
        }
      }

      const channel = await resolveSlackChannel(channelInput);
      const result = await setSlackRepoMapping({
        channel: channel.id,
        repoPath: repoPath || null,
        profile,
        project: projectName || null
      });

      const target = projectName ? `project:${projectName}` : repoPath;
      const profileLabel = profile ? ` (profile: ${profile})` : "";
      console.log(`Mapped ${channel.id}${channel.name ? ` (#${channel.name})` : ""} -> ${target}${profileLabel}`);
      console.log(`Repo map: ${result.repoMapPath}`);
      return;
    }

    if (mapAction === "remove") {
      const channelInput = getFlagValue(rawArgs, "--channel");
      if (!channelInput) {
        throw new Error("usage: hub slack map remove --channel <#name|CID>");
      }

      const channel = await resolveSlackChannel(channelInput);
      const result = await removeSlackRepoMapping({ channel: channel.id });
      console.log(`Removed mapping for ${channel.id}${channel.name ? ` (#${channel.name})` : ""}`);
      console.log(`Repo map: ${result.repoMapPath}`);
      return;
    }

    if (mapAction === "resolve") {
      const channelInput = getFlagValue(rawArgs, "--channel");
      if (!channelInput) {
        throw new Error("usage: hub slack map resolve --channel <#name|CID>");
      }

      const channel = await resolveSlackChannel(channelInput);
      const repoMap = await loadSlackRepoMap();
      const resolved = repoMap.channels?.[channel.id] || "(no mapping)";
      console.log(`${channel.id}${channel.name ? ` (#${channel.name})` : ""} -> ${resolved}`);
      return;
    }

    if (mapAction === "export") {
      const repoMap = await loadSlackRepoMap();
      await saveSlackRepoMap(repoMap);
      console.log("Slack repo map normalized and saved.");
      return;
    }

    throw new Error("unknown slack map command. Use: channels|list|set|remove|resolve");
  }

  throw new Error("unknown slack command. Use: hub slack notify|socket|map");
}

async function runTeam(rawArgs) {
  const subcommand = rawArgs[0];

  if (subcommand === "roles") {
    const repo = getFlagValue(rawArgs, "--repo") || process.cwd();
    const team = await loadTeamConfig(repo);
    console.log(`Team: ${team.config.name}`);
    for (const role of team.config.roles) {
      console.log(`- ${role.id}: ${role.name} [${role.provider}]`);
    }
    return;
  }

  if (subcommand === "brainstorm") {
    const repo = getFlagValue(rawArgs, "--repo") || process.cwd();
    const positional = getPositionalArgsExcludingFlags(rawArgs, ["--repo"]);
    const topic = positional.slice(1).join(" ").trim();
    if (!topic) {
      throw new Error("missing topic. Usage: hub team brainstorm --repo <path> \"topic\"");
    }

    const team = await loadTeamConfig(repo);
    const out = await createBrainstormSession({
      teamConfig: team.config,
      repoPath: repo,
      topic
    });

    console.log(`Brainstorm session created: ${out.session.sessionId}`);
    console.log(`Artifacts: ${out.sessionDir}`);
    console.log("Decision options:");
    for (const option of out.decisionPack.decisionOptions) {
      console.log(`- ${option.id}: ${option.title} (${option.summary})`);
    }
    return;
  }

  if (subcommand === "provider-check") {
    const repo = getFlagValue(rawArgs, "--repo") || process.cwd();
    const roleId = getFlagValue(rawArgs, "--role");
    const topic = getFlagValue(rawArgs, "--topic");
    const mode = getFlagValue(rawArgs, "--mode") || "technical-consult";

    if (!roleId || !topic) {
      throw new Error("usage: hub team provider-check --repo <path> --role <role-id> --topic \"question\"");
    }

    const team = await loadTeamConfig(repo);
    const role = (team.config.roles || []).find((entry) => entry.id === roleId);
    if (!role) {
      throw new Error(`role not found: ${roleId}`);
    }

    const result = await runRoleContribution({
      role,
      topic,
      context: {
        repoPath: repo,
        providers: team.config.providers || {},
        mode
      }
    });

    console.log(`Role: ${role.name} (${role.id})`);
    console.log(`Provider: ${result.provider}`);
    console.log(`Status: ${result.status}`);
    if (result.note) {
      console.log(`Note: ${result.note}`);
    }
    if (Array.isArray(result.attemptedProviders) && result.attemptedProviders.length) {
      console.log("Attempts:");
      for (const attempt of result.attemptedProviders) {
        console.log(`- ${attempt.provider}: ${attempt.status}${attempt.note ? ` (${attempt.note})` : ""}`);
      }
    }
    console.log("");
    console.log("Summary:");
    console.log(result.content?.summary || "(empty)");

    const recommendations = result.content?.recommendations || [];
    console.log("");
    console.log("Recommendations:");
    if (!recommendations.length) {
      console.log("- (none)");
    } else {
      for (const rec of recommendations) {
        console.log(`- ${rec}`);
      }
    }

    const risks = result.content?.risks || [];
    console.log("");
    console.log("Risks:");
    if (!risks.length) {
      console.log("- (none)");
    } else {
      for (const risk of risks) {
        console.log(`- ${risk}`);
      }
    }
    return;
  }

  if (subcommand === "scaffold-role") {
    const repo = getFlagValue(rawArgs, "--repo");
    const id = getFlagValue(rawArgs, "--id");
    const name = getFlagValue(rawArgs, "--name");
    const provider = getFlagValue(rawArgs, "--provider") || "local-template";
    if (!repo || !id || !name) {
      throw new Error("usage: hub team scaffold-role --repo <path> --id <role-id> --name \"Role Name\" [--provider codex]");
    }

    const result = await scaffoldRoleInRepo({
      repoPath: repo,
      role: {
        id,
        name,
        provider,
        persona: "",
        responsibilities: [],
        deliverables: []
      }
    });

    console.log(`Role saved: ${result.role.id} (${result.role.name})`);
    console.log(`Config: ${result.repoConfigPath}`);
    return;
  }

  throw new Error("unknown team command. Use: hub team roles|brainstorm|provider-check|scaffold-role");
}

async function runStart(rawArgs) {
  await requireSelectedProfile();
  const runId = rawArgs[0];
  if (!runId) {
    throw new Error("missing run id");
  }

  const run = await loadRun(runId);
  if (["running", "completed", "failed", "cancelled"].includes(run.taskResult.status)) {
    console.log(`Run ${runId} is already ${run.taskResult.status}.`);
    return;
  }

  const approvalRequired = run.taskResult.approvals?.required === true;
  const approvalGranted = run.taskResult.approvals?.approved === true;

  if (!run.taskResult.execution?.worktreePath) {
    const creation = await ensureWorktreeForRun({
      repoPath: run.taskSpec.repoPath,
      runId,
      branchHint: run.taskResult.execution?.branch || undefined,
      baseRefHint: run.taskSpec.branch || undefined
    });

    if (!creation.ok) {
      throw new Error(`could not create worktree: ${creation.error}`);
    }

    const taskResult = {
      ...run.taskResult,
      execution: {
        provider: "git-worktree",
        worktreePath: creation.context.worktreePath,
        branch: creation.context.branch,
        baseRef: creation.context.baseRef,
        createdAt: creation.context.createdAt
      },
      timeline: appendTimeline(run.taskResult, {
        type: "worktree_created",
        actor: "system",
        path: creation.context.worktreePath,
        branch: creation.context.branch
      })
    };

    await saveRunFiles(runId, { taskResult });
    run.taskResult = taskResult;
  }

  if (approvalRequired && !approvalGranted) {
    const taskResult = {
      ...run.taskResult,
      status: "awaiting_approval",
      timeline: appendTimeline(run.taskResult, { type: "approval_required", actor: "system" })
    };
    await saveRunFiles(runId, { taskResult });
    console.log(`Run ${runId} requires approval first. Use: hub approve ${runId}`);
    return;
  }

  const output = await executeRun(run, { actor: "user" });
  console.log(`Run ${runId} finished with status: ${output.status}`);
}

async function runProfile(rawArgs) {
  const subcommand = rawArgs[0];

  if (!subcommand || subcommand === "current") {
    const state = await getProfileState();
    if (!state?.profile) {
      console.log("No profile selected.");
      console.log("Use: hub profile select work");
      console.log("Or:  hub profile select personal");
      return;
    }

    console.log(`Current profile: ${state.profile} (${state.account})`);
    console.log(`Switched at: ${state.switchedAt}`);
    return;
  }

  if (subcommand === "select") {
    const profile = rawArgs[1];
    if (!profile) {
      const allowed = (await listAllowedProfiles())
        .map((p) => `${p.profile} (${p.account})`)
        .join(", ");
      throw new Error(`missing profile. Allowed: ${allowed}`);
    }

    const next = await selectProfile(profile);
    console.log(`Profile selected: ${next.profile} (${next.account})`);
    return;
  }

  throw new Error("unknown profile command. Use: hub profile current|select");
}

async function runSingle(rawArgs) {
  const options = parseOptions(rawArgs);
  const message = options.args.join(" ").trim();

  if (!message) {
    throw new Error("missing natural language request");
  }

  await processTask(message, {
    repoPath: options.repoPath,
    branch: options.branch,
    channel: options.channel,
    requestedBy: "warp-cli"
  });
}

async function runChat(rawArgs) {
  const options = parseOptions(rawArgs);
  const rl = readline.createInterface({ input, output });

  console.log("Hub chat started. Type natural language requests. Type 'exit' to quit.\n");

  while (true) {
    let message = "";
    try {
      message = (await rl.question("you> ")).trim();
    } catch (error) {
      // Non-interactive stdin can close abruptly; exit gracefully.
      if (error?.code === "ERR_USE_AFTER_CLOSE") {
        break;
      }

      throw error;
    }

    if (!message) {
      continue;
    }

    if (["exit", "quit", "q"].includes(message.toLowerCase())) {
      break;
    }

    try {
      await processTask(message, {
        repoPath: options.repoPath,
        branch: options.branch,
        channel: "chat",
        requestedBy: "warp-cli"
      });
    } catch (error) {
      console.error(`[hub] could not process message: ${error.message}`);
    }

    console.log("");
  }

  rl.close();
}

async function runProjectCmd(rawArgs) {
  const subcommand = rawArgs[0];

  if (!subcommand || subcommand === "list") {
    const data = await loadProjects();
    const entries = Object.entries(data.projects || {});
    if (!entries.length) {
      console.log("No projects configured.");
      return;
    }
    for (const [name, project] of entries) {
      const repoCount = Object.keys(project.repos || {}).length;
      console.log(`${name} | ${repoCount} repos | default: ${project.defaultRepo || "none"}`);
    }
    return;
  }

  if (subcommand === "show") {
    const name = getFlagValue(rawArgs, "--name");
    if (!name) {
      throw new Error("usage: hub project show --name <name>");
    }
    const project = await getProject(name);
    if (!project) {
      throw new Error(`project not found: ${name}`);
    }
    console.log(`Project: ${project.name}`);
    console.log(`Default repo: ${project.defaultRepo || "none"}`);
    console.log("Repos:");
    for (const [label, repo] of Object.entries(project.repos || {})) {
      const defaultMarker = label === project.defaultRepo ? " [default]" : "";
      console.log(`  ${label} (${repo.type || "unknown"}): ${repo.path}${repo.description ? ` - ${repo.description}` : ""}${defaultMarker}`);
    }
    return;
  }

  if (subcommand === "add") {
    const name = getFlagValue(rawArgs, "--name");
    const defaultRepo = getFlagValue(rawArgs, "--default");
    if (!name) {
      throw new Error("usage: hub project add --name <name> [--default <label>]");
    }
    await addProject({ name, repos: {}, defaultRepo });
    console.log(`Project created: ${name}`);
    return;
  }

  if (subcommand === "remove") {
    const name = getFlagValue(rawArgs, "--name");
    if (!name) {
      throw new Error("usage: hub project remove --name <name>");
    }
    const removed = await removeProject(name);
    if (!removed) {
      throw new Error(`project not found: ${name}`);
    }
    console.log(`Project removed: ${name}`);
    return;
  }

  if (subcommand === "repo") {
    const repoAction = rawArgs[1];

    if (repoAction === "add") {
      const projectName = getFlagValue(rawArgs, "--project");
      const label = getFlagValue(rawArgs, "--label");
      const repoPath = getFlagValue(rawArgs, "--path");
      const type = getFlagValue(rawArgs, "--type");
      const description = getFlagValue(rawArgs, "--description");
      if (!projectName || !label || !repoPath) {
        throw new Error("usage: hub project repo add --project <name> --label <label> --path <path> --type <type> [--description <d>]");
      }
      await addRepoToProject(projectName, { label, path: repoPath, type, description });
      console.log(`Repo added: ${projectName}/${label} -> ${repoPath}`);
      return;
    }

    if (repoAction === "remove") {
      const projectName = getFlagValue(rawArgs, "--project");
      const label = getFlagValue(rawArgs, "--label");
      if (!projectName || !label) {
        throw new Error("usage: hub project repo remove --project <name> --label <label>");
      }
      const removed = await removeRepoFromProject(projectName, label);
      if (!removed) {
        throw new Error(`repo not found: ${projectName}/${label}`);
      }
      console.log(`Repo removed: ${projectName}/${label}`);
      return;
    }

    throw new Error("unknown project repo command. Use: add|remove");
  }

  throw new Error("unknown project command. Use: list|show|add|remove|repo");
}

export async function runCli(argv) {
  const [command, ...rest] = argv;

  if (!command || ["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }

  if (command === "init") {
    await runInit();
    return;
  }

  if (command === "run") {
    await runSingle(rest);
    return;
  }

  if (command === "chat") {
    await runChat(rest);
    return;
  }

  if (command === "list") {
    await runList();
    return;
  }

  if (command === "status") {
    await runStatus(rest);
    return;
  }

  if (command === "start") {
    await runStart(rest);
    return;
  }

  if (command === "approve") {
    await runApprove(rest);
    return;
  }

  if (command === "reject") {
    await runReject(rest);
    return;
  }

  if (command === "stop") {
    await runStop(rest);
    return;
  }

  if (command === "commit") {
    await runCommit(rest);
    return;
  }

  if (command === "push") {
    await runPush(rest);
    return;
  }

  if (command === "pr") {
    await runPr(rest);
    return;
  }

  if (command === "pushpr") {
    await runPushPr(rest);
    return;
  }

  if (command === "profile") {
    await runProfile(rest);
    return;
  }

  if (command === "slack") {
    await runSlack(rest);
    return;
  }

  if (command === "team") {
    await runTeam(rest);
    return;
  }

  if (command === "project") {
    await runProjectCmd(rest);
    return;
  }

  if (command === "memory") {
    await runMemoryCmd(rest);
    return;
  }

  if (command === "review") {
    await runReviewCmd(options, rest);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function runMemoryCmd(rawArgs) {
  const subcommand = rawArgs[0];

  if (!subcommand || subcommand === "stats") {
    const stats = getStats();
    console.log(`Memory DB: ${stats.dbPath}`);
    console.log(`Observations: ${stats.totalObservations}`);
    console.log(`Sessions: ${stats.totalSessions}`);
    if (stats.byType.length) {
      console.log("\nBy type:");
      for (const { type, count } of stats.byType) {
        console.log(`  ${type}: ${count}`);
      }
    }
    if (stats.byProject.length) {
      console.log("\nBy project:");
      for (const { project, count } of stats.byProject) {
        console.log(`  ${project}: ${count}`);
      }
    }
    return;
  }

  if (subcommand === "search") {
    const query = rawArgs.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
    const project = getFlagValue(rawArgs, "--project");
    const type = getFlagValue(rawArgs, "--type");
    const limitStr = getFlagValue(rawArgs, "--limit");
    const limit = limitStr ? parseInt(limitStr, 10) : 20;

    const results = searchObservations({ query: query || null, type, project, limit });
    if (!results.length) {
      console.log("No observations found.");
      return;
    }

    for (const obs of results) {
      const revTag = obs.revision_count > 1 ? ` [rev ${obs.revision_count}]` : "";
      console.log(`#${obs.id} [${obs.type}] ${obs.title}${revTag}`);
      console.log(`  project: ${obs.project || "global"} | ${obs.created_at}`);
      if (obs.content_preview) {
        console.log(`  ${obs.content_preview.replace(/\n/g, " ").slice(0, 120)}`);
      }
      console.log("");
    }
    return;
  }

  if (subcommand === "get") {
    const id = parseInt(rawArgs[1], 10);
    if (!id) throw new Error("usage: hub memory get <id>");

    const obs = getObservation(id);
    if (!obs) {
      console.log(`Observation #${id} not found.`);
      return;
    }

    console.log(`#${obs.id} [${obs.type}] ${obs.title}`);
    console.log(`Project: ${obs.project || "global"}`);
    console.log(`Scope: ${obs.scope}`);
    if (obs.topic_key) console.log(`Topic key: ${obs.topic_key}`);
    console.log(`Revisions: ${obs.revision_count} | Duplicates: ${obs.duplicate_count}`);
    console.log(`Created: ${obs.created_at} | Updated: ${obs.updated_at}`);
    console.log(`\n${obs.content}`);
    return;
  }

  if (subcommand === "delete") {
    const id = parseInt(rawArgs[1], 10);
    if (!id) throw new Error("usage: hub memory delete <id>");
    softDelete(id);
    console.log(`Observation #${id} soft-deleted.`);
    return;
  }

  throw new Error("unknown memory command. Use: stats|search|get|delete");
}

async function runReviewCmd(options, rawArgs) {
  const loaded = await loadTeamConfig(options.repoPath);
  const reviewConfig = resolveReviewConfig(loaded.config);

  // Parse --goal from args
  let goal = "Manual code review";
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--goal" && rawArgs[i + 1]) {
      goal = rawArgs[i + 1];
      break;
    }
  }

  console.log(`Running code review on ${options.repoPath}...`);
  console.log(`Provider: ${reviewConfig.provider} | Rules: ${reviewConfig.rulesFile}`);

  // Force enabled for CLI manual invocation
  const configForReview = {
    ...loaded.config,
    gates: {
      ...loaded.config.gates,
      codeReview: { ...reviewConfig, enabled: true }
    }
  };

  const result = await runCodeReview({
    repoPath: options.repoPath,
    teamConfig: configForReview,
    goal
  });

  if (result.skipped) {
    console.log("No changes to review.");
    return;
  }

  const icon = result.passed ? "✅" : "❌";
  console.log(`\n${icon} Verdict: ${result.passed ? "APPROVED" : "CHANGES REQUESTED"}`);
  console.log(`Summary: ${result.summary}`);

  if (result.issues && result.issues.length > 0) {
    console.log(`\nIssues (${result.issues.length}):`);
    for (const issue of result.issues) {
      const sev = issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
      console.log(`  ${sev} ${issue.file}: ${issue.description}`);
    }
  }

  console.log(`\nCompleted in ${Math.round(result.durationMs / 1000)}s`);
}
