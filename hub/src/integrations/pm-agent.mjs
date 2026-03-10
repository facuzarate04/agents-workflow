import fs from "node:fs/promises";
import path from "node:path";
import { HUB_ROOT, nowIso, readJsonFile, writeJsonFile } from "../core/utils.mjs";
import { listRuns, loadRun } from "../core/runs.mjs";
import { loadTeamConfig } from "../team/config.mjs";
import { createBrainstormSession } from "../team/session.mjs";
import { runRoleContribution, runDirectProviderCall, runExecutionCall } from "../team/providers.mjs";
import { runGitInCwd } from "../core/git.mjs";
import { ensureGhAvailable, createPullRequest } from "../core/github.mjs";
import { resolveProfileToken } from "../core/profile.mjs";
import { saveObservation, getRelevantContext, formatContextForPrompt } from "../core/memory.mjs";
import { runCodeReview, isCodeReviewEnabled, formatReviewForSlack } from "../core/review.mjs";

const THREAD_STATE_PATH = path.join(HUB_ROOT, ".state", "slack", "threads.json");

const MAX_THREAD_HISTORY = 50;
const PM_PROMPT_HISTORY = 12;
const MAX_CONSULTATIONS = 10;
const PM_ANSWER_TRUNCATE = 2000;
const EXPERT_SUMMARY_TRUNCATE = 500;
const THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const STALE_OPERATION_MS = {
  execute: 12 * 60 * 1000,
  consult: 6 * 60 * 1000,
  brainstorm: 6 * 60 * 1000,
  default: 5 * 60 * 1000
};

const threadLocks = new Map();

function captureToMemory({ type, title, content, project, topicKey, sessionId }) {
  try {
    saveObservation({
      sessionId: sessionId || null,
      type,
      title,
      content,
      project,
      scope: "project",
      topicKey: topicKey || null
    });
  } catch {
    // Memory capture should never break the main flow
  }
}

function withThreadLock(threadKey, fn) {
  const prev = threadLocks.get(threadKey) || Promise.resolve();
  let resolve;
  const next = new Promise((r) => { resolve = r; });
  threadLocks.set(threadKey, next);
  return prev.then(() => fn()).finally(() => {
    resolve();
    if (threadLocks.get(threadKey) === next) {
      threadLocks.delete(threadKey);
    }
  });
}

function pruneExpiredThreads(stateDoc) {
  const now = Date.now();
  for (const [key, thread] of Object.entries(stateDoc.threads || {})) {
    const lastEntry = (thread.history || []).at(-1);
    const lastAt = lastEntry?.at ? new Date(lastEntry.at).getTime() : 0;
    if (now - lastAt > THREAD_TTL_MS) {
      delete stateDoc.threads[key];
    }
  }
}

function extractRunId(text) {
  const match = text.match(/\b\d{14}-[a-z0-9]{6}\b/i);
  return match ? match[0] : null;
}

async function loadThreadState() {
  return (await readJsonFile(THREAD_STATE_PATH, { threads: {} })) || { threads: {} };
}

async function saveThreadState(state) {
  await writeJsonFile(THREAD_STATE_PATH, state);
}


function buildSmartPmPrompt({ question, teamConfig, threadHistory, lastConsultation, projectContext, memoryContext }) {
  const roles = (teamConfig.roles || []).filter((r) => r.id !== "ceo");
  const roleDescriptions = roles.map((r) =>
    `- ${r.name} (${r.id}): ${r.persona} Expertise: ${(r.expertise || []).join(", ")}`
  ).join("\n");

  const sections = [
    "MODE: CONSULTATION. Provide analysis and recommendations as text only. Do NOT read, edit, or create files. Do NOT use tools. The user will explicitly request implementation in a separate step.",
    "",
    "You are a PM (Project Manager) for a software development team.",
    "You coordinate a team of experts and provide direct analysis when possible.",
    "",
    "Available team experts:",
    roleDescriptions,
    ""
  ];

  if (projectContext && projectContext.repos) {
    const repoEntries = Object.entries(projectContext.repos);
    sections.push(`Project: ${projectContext.name} (${repoEntries.length} repos)`);
    for (const [label, repo] of repoEntries) {
      const defaultMarker = label === projectContext.defaultRepo ? " [default]" : "";
      sections.push(`- ${label} (${repo.type || "unknown"}): ${repo.path}${repo.description ? ` - ${repo.description}` : ""}${defaultMarker}`);
    }
    sections.push("");
    sections.push("When the user's request targets a specific repo, specify which one.");
    sections.push("For execution, add TARGET_REPO: <label> before the EXECUTE signal.");
    sections.push("");
  }

  if (memoryContext) {
    sections.push(memoryContext);
    sections.push("");
  }

  const recent = Array.isArray(threadHistory) ? threadHistory.slice(-PM_PROMPT_HISTORY) : [];
  if (recent.length > 0) {
    sections.push("Conversation history:");
    for (const entry of recent) {
      const role = entry.role || "user";
      const text = cleanQuestionText(entry.text || "");
      if (!text) continue;

      if (role === "user") {
        sections.push(`[USER] ${text}`);
      } else if (role === "pm") {
        const actionTag = entry.action ? ` → ${entry.action.toUpperCase()}` : "";
        sections.push(`[PM${actionTag}] ${text}`);
      } else if (role === "expert") {
        const expertTag = entry.expertId ? `:${entry.expertId}` : "";
        sections.push(`[EXPERT${expertTag}] ${text}`);
      } else {
        sections.push(`- [${entry.intent || "message"}] ${text}`);
      }
    }
    sections.push("");
  }

  if (lastConsultation && lastConsultation.question) {
    sections.push("Last consultation context:");
    sections.push(`- Question: ${lastConsultation.question}`);
    if (Array.isArray(lastConsultation.consultRoles) && lastConsultation.consultRoles.length > 0) {
      sections.push(`- Experts consulted: ${lastConsultation.consultRoles.join(", ")}`);
    }
    if (lastConsultation.pmAnswer) {
      sections.push(`- PM answer summary: ${lastConsultation.pmAnswer.slice(0, 500)}`);
    }
    if (Array.isArray(lastConsultation.expertSummaries) && lastConsultation.expertSummaries.length > 0) {
      for (const es of lastConsultation.expertSummaries) {
        sections.push(`- Expert ${es.roleId} (${es.status}): ${(es.summary || "").slice(0, 300)}`);
      }
    }
    sections.push("");
  }

  sections.push(
    "Instructions:",
    "1. Analyze the user's message in the context of this software project.",
    "2. Provide your analysis or answer directly — be specific and helpful.",
    "3. Respond in the same language as the user's message.",
    "4. If there is conversation history, use it for continuity and avoid repeating what was already said.",
    "",
    "ACTION SIGNALS — Add exactly ONE at the very end of your response ONLY when the user's intent clearly matches.",
    "If you can answer directly, do NOT add any signal.",
    "",
    "- CONSULT: role_id1, role_id2",
    "  Use when the question genuinely needs specialized expert depth beyond your PM analysis.",
    "- EXECUTE: brief description of what to build",
    "  Use when the user explicitly wants code implementation (e.g., 'hacelo', 'arranca', 'implementa',",
    "  'dale con eso', 'quiero que lo hagan', 'build it', 'implement this').",
    "  This triggers a real development team to write code and commit changes.",
    "- STATUS: runId",
    "  Use when the user asks about a run's progress or status. Run IDs look like: 20260209134800-abc123",
    "- APPROVE: runId",
    "  Use when the user wants to approve/accept a run.",
    "- STOP: runId",
    "  Use when the user wants to stop, reject, or cancel a run.",
    "- PUSHPR: runId",
    "  Use when the user wants to create a Pull Request for a hub-managed run (run IDs look like: 20260209134800-abc123).",
    "- CREATE_PR: branch_name",
    "  Use when the user wants to create a Pull Request for an existing branch (not a hub run).",
    "  The branch must already exist in the repository. Example: CREATE_PR: feature/seo-p0-foundations",
    "- START: runId",
    "  Use when the user wants to start/execute a pending run.",
    "- NEW_RUN: \"goal description\"",
    "  Use when the user wants to create a new development task/run.",
    "- BRAINSTORM: topic",
    "  Use when the user wants the whole team to brainstorm or debate alternatives.",
    "",
    `User message: ${question}`
  );

  return sections.join("\n");
}

function buildExecutionPrompt({ goal, repoPath, teamConfig, pmContext }) {
  const roles = (teamConfig.roles || [])
    .filter((r) => ["frontend", "backend", "qa"].includes(r.id));
  const roleDesc = roles.map((r) =>
    `- ${r.name}: ${r.persona} Expertise: ${(r.expertise || []).join(", ")}`
  ).join("\n");

  return [
    "You are a Tech Lead. Implement the following goal in this repository.",
    "",
    `GOAL: ${goal}`,
    `REPOSITORY: ${repoPath}`,
    "",
    "PM ANALYSIS (conversation context):",
    (pmContext || "").slice(0, 2000),
    "",
    "AVAILABLE SUBAGENTS (use Task tool to delegate):",
    roleDesc,
    "",
    "INSTRUCTIONS:",
    "1. Read and understand relevant parts of the codebase",
    "2. Break down the goal into implementable tasks",
    "3. Implement changes, using subagents for specialized work when beneficial",
    "4. Ensure code quality — proper error handling, no leftover TODOs",
    "5. VALIDATE before committing (mandatory):",
    "   a. Run the project's linter if configured (e.g. npm run lint, npx eslint)",
    "   b. Run type checking if the project uses TypeScript (e.g. npx tsc --noEmit)",
    "   c. Run existing test suites (e.g. npm test, npx jest, npx vitest)",
    "   d. If the project has Playwright tests, delegate to QA subagent to run them",
    "   e. Fix any errors found before proceeding",
    "6. Create a git commit with a descriptive message (do NOT push)",
    "7. Summarize: what was implemented, validation results, and any remaining work",
    "",
    "CONSTRAINTS:",
    "- Work only within the repository",
    "- Make atomic, focused changes",
    "- Do not push to remote or create PRs",
    "- Do NOT skip validation — if tests fail, fix the code before committing"
  ].join("\n");
}

function parseActionSignals(output) {
  // Parse TARGET_REPO if present (appears before other signals)
  const targetRepoMatch = output.match(/\nTARGET_REPO:\s*(\S+)/m);
  const targetRepo = targetRepoMatch ? targetRepoMatch[1].trim() : null;

  // Remove TARGET_REPO line from output before parsing other signals
  const cleanedOutput = targetRepoMatch
    ? output.slice(0, targetRepoMatch.index) + output.slice(targetRepoMatch.index + targetRepoMatch[0].length)
    : output;

  const signalPatterns = [
    { type: "execute", pattern: /\nEXECUTE:\s*(.+)$/m },
    { type: "consult", pattern: /\nCONSULT:\s*(.+)$/m },
    { type: "status", pattern: /\nSTATUS:\s*(\S+)/m },
    { type: "approve", pattern: /\nAPPROVE:\s*(\S+)/m },
    { type: "stop", pattern: /\nSTOP:\s*(\S+)/m },
    { type: "pushpr", pattern: /\nPUSHPR:\s*(\S+)/m },
    { type: "createpr", pattern: /\nCREATE_PR:\s*(\S+)/m },
    { type: "start", pattern: /\nSTART:\s*(\S+)/m },
    { type: "newRun", pattern: /\nNEW_RUN:\s*"?(.+?)"?\s*$/m },
    { type: "brainstorm", pattern: /\nBRAINSTORM:\s*(.+)$/m }
  ];

  for (const { type, pattern } of signalPatterns) {
    const match = cleanedOutput.match(pattern);
    if (match) {
      const value = match[1].trim();
      const answer = cleanedOutput.slice(0, match.index).trim();
      if (type === "consult") {
        return {
          answer,
          action: { type, value, roles: value.split(",").map((r) => r.trim()).filter(Boolean), targetRepo }
        };
      }
      return { answer, action: { type, value, targetRepo } };
    }
  }

  return { answer: cleanedOutput.trim(), action: null };
}

const SMART_PM_TOTAL_TIMEOUT_MS = 180_000;

async function runSmartPm({ question, teamConfig, repoPath, providers, threadHistory, lastConsultation, onStage, projectContext, memoryContext }) {
  const prompt = buildSmartPmPrompt({ question, teamConfig, threadHistory, lastConsultation, projectContext, memoryContext });
  const startedAt = Date.now();

  const emitPmStage = async (payload) => {
    if (typeof onStage === "function") {
      try { await onStage(payload); } catch { /* ignore */ }
    }
  };

  const candidates = [
    providers?.smartPmProvider,
    providers?.smartPmFallback,
    "claude-teams",
    "codex"
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);

  const errors = [];

  for (const providerName of candidates) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > SMART_PM_TOTAL_TIMEOUT_MS) {
      errors.push(`total timeout exceeded (${Math.round(elapsed / 1000)}s)`);
      break;
    }

    await emitPmStage({ type: "pm_provider_trying", provider: providerName });

    const result = await runDirectProviderCall({
      providerName,
      prompt,
      context: { repoPath, providers }
    });

    if (result.ok) {
      const output = result.output || "";
      const parsed = parseActionSignals(output);

      return {
        ok: true,
        answer: parsed.answer,
        action: parsed.action,
        error: null,
        durationMs: result.durationMs,
        provider: providerName
      };
    }

    const reason = result.timedOut ? "timeout" : (result.error || "failed");
    await emitPmStage({ type: "pm_provider_failed", provider: providerName, reason, durationMs: result.durationMs });
    errors.push(`${providerName}: ${reason}`);
  }

  return {
    ok: false,
    answer: null,
    action: null,
    error: `All PM providers failed — ${errors.join("; ")}`,
    durationMs: Date.now() - startedAt
  };
}

function resolveRolesById(teamConfig, roleIds) {
  const roles = teamConfig.roles || [];
  return roleIds
    .map((id) => roles.find((r) => r.id === id))
    .filter(Boolean);
}

function cleanQuestionText(text) {
  return (text || "")
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/@PM-Office/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildHistoryEntries({ existingHistory, userText, intent, pmAnswer, action, expertOutputs }) {
  const at = nowIso();
  const entries = [...existingHistory];

  entries.push({ at, role: "user", text: userText, intent });

  if (pmAnswer) {
    const pmEntry = { at, role: "pm", text: pmAnswer.slice(0, PM_ANSWER_TRUNCATE) };
    if (action) pmEntry.action = action;
    entries.push(pmEntry);
  }

  if (Array.isArray(expertOutputs)) {
    for (const expert of expertOutputs) {
      entries.push({
        at,
        role: "expert",
        text: (expert.summary || "").slice(0, EXPERT_SUMMARY_TRUNCATE),
        expertId: expert.roleId,
        status: expert.status || "unknown"
      });
    }
  }

  return entries.slice(-MAX_THREAD_HISTORY);
}

function isOperationStale(activeOp) {
  if (!activeOp?.startedAt) return true;
  const elapsed = Date.now() - new Date(activeOp.startedAt).getTime();
  const threshold = STALE_OPERATION_MS[activeOp.type] || STALE_OPERATION_MS.default;
  return elapsed > threshold;
}

async function setActiveOperation(stateDoc, threadKey, threadState, operation) {
  threadState.activeOperation = operation;
  stateDoc.threads[threadKey] = threadState;
  await saveThreadState(stateDoc);
}

async function clearActiveOperation(stateDoc, threadKey, threadState) {
  delete threadState.activeOperation;
  stateDoc.threads[threadKey] = threadState;
  await saveThreadState(stateDoc);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function resolveRoleTimeoutMs(providers = {}, mode = "technical-consult") {
  const byMode = providers.roleTimeoutByModeMs || {};
  const modeTimeout = Number(byMode[mode]);
  if (Number.isFinite(modeTimeout) && modeTimeout > 0) {
    return modeTimeout;
  }

  const globalTimeout = Number(providers.roleTimeoutMs);
  if (Number.isFinite(globalTimeout) && globalTimeout > 0) {
    return globalTimeout;
  }

  return 90 * 1000;
}

async function runRoleWithTimeout({ role, topic, context, timeoutMs, pmAnalysis }) {
  const startedAt = Date.now();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        status: "dispatch_required",
        provider: role.provider || "unknown",
        note: `Role timeout after ${formatDuration(timeoutMs)} while waiting provider output.`,
        attemptedProviders: [],
        content: {
          summary: `${role.name} timeout while analyzing '${topic}'.`,
          assumptions: [],
          recommendations: [`${role.name}: retry with smaller scope or debug provider runtime.`],
          risks: [`${role.name}: delayed response may block decision timing.`],
          nextActions: ["Inspect provider command and runtime logs."]
        },
        metrics: {
          durationMs: timeoutMs,
          timedOut: true
        }
      });
    }, timeoutMs);
  });

  const result = await Promise.race([
    runRoleContribution({ role, topic, context, pmAnalysis }),
    timeoutPromise
  ]);

  const durationMs = Date.now() - startedAt;
  return {
    ...result,
    metrics: {
      ...(result?.metrics || {}),
      durationMs,
      timedOut: result?.metrics?.timedOut === true
    }
  };
}

function formatBrainstormSummary(session, decisionPack) {
  const roleLines = session.outputs.map((out) => {
    const recommendation = out.result?.content?.recommendations?.[0] || "sin recomendación concreta";
    return `- ${out.role.name}: ${recommendation}`;
  });

  const options = decisionPack.decisionOptions
    .map((opt) => `- ${opt.id}: ${opt.title} (${opt.summary})`)
    .join("\n");

  return [
    `Sesión de equipo creada: *${session.sessionId}*`,
    `Tema: ${session.topic}`,
    "",
    "Aportes por rol:",
    ...(roleLines.length ? roleLines : ["- (sin aportes)"]),
    "",
    "Opciones de decisión:",
    options,
    "",
    `Artifacts: ${path.join(HUB_ROOT, ".state", "teams", session.sessionId)}`
  ].join("\n");
}

function formatRunForPm(run) {
  const failed = (run.gateReport.gates || []).filter((g) => g.status === "failed").map((g) => g.id);
  const lines = [
    `Run ${run.runId}: *${run.taskResult.status}*`,
    `Workflow: ${run.taskResult.workflow}`,
    `Objetivo: ${run.taskResult.goal}`
  ];

  if (failed.length) {
    lines.push(`Gates fallidos: ${failed.join(", ")}`);
  }

  if (run.taskResult.lastPr?.url) {
    lines.push(`PR: ${run.taskResult.lastPr.url}`);
  }

  return lines.join("\n");
}

export async function handlePmMessage({ text, threadKey, context, runHubCommand, onStage }) {
  // Pre-lock check: respond instantly if an operation is already running
  const preCheck = await loadThreadState();
  const preThread = preCheck.threads?.[threadKey];
  const preOp = preThread?.activeOperation;
  if (preOp && !isOperationStale(preOp)) {
    const elapsed = Date.now() - new Date(preOp.startedAt).getTime();
    const elapsedStr = formatDuration(elapsed);
    const statusLines = [
      `Currently running a *${preOp.type}* operation (started ${elapsedStr} ago).`,
      ""
    ];
    if (preOp.description) statusLines.push(preOp.description);
    statusLines.push("", "I'll reply here when it's done. You can keep chatting in the meantime in other threads.");
    return {
      ok: true,
      message: statusLines.join("\n").trim(),
      updates: preThread
    };
  }

  return withThreadLock(threadKey, async () => {
  const stateDoc = await loadThreadState();
  pruneExpiredThreads(stateDoc);
  const threadState = stateDoc.threads[threadKey] || { lastRunId: null, history: [], consultations: [] };
  const emitStage = async (payload) => {
    if (typeof onStage !== "function") {
      return;
    }

    try {
      await onStage(payload);
    } catch {
      // ignore stage callback failures
    }
  };

  // Clear stale operations that exceeded their timeout
  if (threadState.activeOperation && isOperationStale(threadState.activeOperation)) {
    delete threadState.activeOperation;
  }

  const repo = context.defaultRepo || context.fallbackRepo || process.cwd();
  const projectContext = context.project || null;
  const projectName = projectContext?.name || path.basename(repo);
  const loaded = await loadTeamConfig(repo);
  const cleanedQuestion = cleanQuestionText(text);
  const consultStartedAt = Date.now();

  // Load relevant memory context for this project and question
  let memoryContext = "";
  try {
    const memories = getRelevantContext({ project: projectName, query: cleanedQuestion, limit: 6 });
    memoryContext = formatContextForPrompt(memories);
  } catch {
    // Memory system failure should never block PM
  }

  await emitStage({ type: "pm_thinking", question: cleanedQuestion });

  const pmResult = await runSmartPm({
    question: cleanedQuestion,
    teamConfig: loaded.config,
    repoPath: repo,
    providers: loaded.config.providers,
    threadHistory: threadState.history,
    lastConsultation: threadState.lastConsultation,
    onStage: emitStage,
    projectContext,
    memoryContext
  });

  const action = pmResult.action;

  await emitStage({
    type: "pm_analysis",
    answer: pmResult.answer,
    ok: pmResult.ok,
    error: pmResult.error,
    durationMs: pmResult.durationMs,
    action: action?.type || null
  });

  if (!pmResult.ok) {
    const updates = {
      ...threadState,
      history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: "pm_error" })
    };
    stateDoc.threads[threadKey] = updates;
    await saveThreadState(stateDoc);

    return {
      ok: false,
      message: `PM no pudo analizar la consulta: ${pmResult.error}`,
      updates
    };
  }

  // --- No action signal: PM answered directly ---
  if (!action) {
    captureToMemory({
      type: "decision",
      title: cleanedQuestion.slice(0, 100),
      content: `Q: ${cleanedQuestion}\nA: ${(pmResult.answer || "").slice(0, 500)}`,
      project: projectName
    });

    const newConsultation = {
      at: nowIso(),
      question: cleanedQuestion,
      pmAnswer: (pmResult.answer || "").slice(0, PM_ANSWER_TRUNCATE)
    };
    const updates = {
      ...threadState,
      lastConsultation: newConsultation,
      consultations: [...(threadState.consultations || []), newConsultation].slice(-MAX_CONSULTATIONS),
      history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: "direct_answer", pmAnswer: pmResult.answer })
    };
    stateDoc.threads[threadKey] = updates;
    await saveThreadState(stateDoc);

    return { ok: true, message: pmResult.answer, updates };
  }

  // --- CONSULT: expert consultation ---
  if (action.type === "consult") {
    const consultRoles = action.roles || [];
    const consulted = resolveRolesById(loaded.config, consultRoles);
    let expertSection = "";

    if (consulted.length > 0) {
      await setActiveOperation(stateDoc, threadKey, threadState, {
        type: "consult",
        startedAt: nowIso(),
        description: `Consulting experts: ${consultRoles.join(", ")}`
      });

      await emitStage({
        type: "consult_started",
        question: cleanedQuestion,
        totalRoles: consulted.length,
        roles: consulted.map((role) => ({ id: role.id, name: role.name }))
      });

      const roleTimeoutMs = resolveRoleTimeoutMs(loaded.config.providers, "technical-consult");
      const heartbeatTimer = setInterval(() => {
        emitStage({
          type: "consult_heartbeat",
          elapsedMs: Date.now() - consultStartedAt,
          totalRoles: consulted.length
        });
      }, 10_000);

      let outputs = [];
      try {
        outputs = await Promise.all(
          consulted.map(async (role, index) => {
            await emitStage({
              type: "role_started",
              roleId: role.id,
              roleName: role.name,
              index,
              totalRoles: consulted.length
            });

            const result = await runRoleWithTimeout({
              role,
              topic: cleanedQuestion,
              context: {
                repoPath: repo,
                teamName: loaded.config.name,
                providers: loaded.config.providers,
                mode: "technical-consult"
              },
              timeoutMs: roleTimeoutMs,
              pmAnalysis: pmResult.answer
            });

            const durationMs = result?.metrics?.durationMs;
            await emitStage({
              type: "role_completed",
              roleId: role.id,
              roleName: role.name,
              status: result?.status || "unknown",
              provider: result?.provider || null,
              durationMs,
              note: result?.note || null,
              attemptedProviders: result?.attemptedProviders || []
            });

            return { role, result };
          })
        );
      } finally {
        clearInterval(heartbeatTimer);
      }

      await clearActiveOperation(stateDoc, threadKey, threadState);

      await emitStage({
        type: "consult_completed",
        totalRoles: consulted.length,
        elapsedMs: Date.now() - consultStartedAt
      });

      const completedOutputs = outputs.filter((o) => o.result?.status === "completed");
      if (completedOutputs.length > 0) {
        const expertLines = completedOutputs.map((o) => {
          const env = o.result?.envelope;
          if (env?.summary) {
            const parts = [`*${o.role.name}:*`, env.summary];
            if (env.recommendations?.length) {
              parts.push("Recommendations: " + env.recommendations.slice(0, 3).join(" | "));
            }
            if (env.risks?.length) {
              parts.push("Risks: " + env.risks.slice(0, 3).join(" | "));
            }
            return parts.join("\n");
          }
          const raw = o.result?.rawOutput || o.result?.content?.summary || "";
          return `*${o.role.name}:*\n${raw}`;
        });
        expertSection = `\n\n---\n*Expert analysis:*\n\n${expertLines.join("\n\n")}`;
      }
    }

    const expertSummaries = (outputs || [])
      .filter((o) => o.result?.status === "completed")
      .map((o) => {
        const env = o.result?.envelope || {};
        return {
          roleId: o.role.id,
          summary: (env.summary || o.result?.rawOutput || o.result?.content?.summary || "").slice(0, EXPERT_SUMMARY_TRUNCATE),
          status: env.status || o.result?.status || "unknown",
          recommendations: env.recommendations || o.result?.content?.recommendations || [],
          risks: env.risks || o.result?.content?.risks || [],
          artifacts: env.artifacts || [],
          nextRecommended: env.next_recommended || null
        };
      });

    // Auto-capture expert consultations to memory (with envelope data)
    for (const es of expertSummaries) {
      const recs = (es.recommendations || []).slice(0, 3).join("; ");
      const risks = (es.risks || []).slice(0, 3).join("; ");
      const contentParts = [`Expert: ${es.roleId}`, `Q: ${cleanedQuestion}`, `A: ${es.summary}`];
      if (recs) contentParts.push(`Recommendations: ${recs}`);
      if (risks) contentParts.push(`Risks: ${risks}`);
      if (es.nextRecommended) contentParts.push(`Next: ${es.nextRecommended}`);

      captureToMemory({
        type: "consultation",
        title: `${es.roleId}: ${cleanedQuestion.slice(0, 80)}`,
        content: contentParts.join("\n"),
        project: projectName,
        topicKey: `consult/${es.roleId}/${cleanedQuestion.slice(0, 40).replace(/\s+/g, "-").toLowerCase()}`
      });
    }

    const finalMessage = `${pmResult.answer}${expertSection}`;
    const newConsultation = {
      at: nowIso(),
      question: cleanedQuestion,
      consultRoles,
      pmAnswer: (pmResult.answer || "").slice(0, PM_ANSWER_TRUNCATE),
      expertSummaries
    };
    const updates = {
      ...threadState,
      lastConsultation: newConsultation,
      consultations: [...(threadState.consultations || []), newConsultation].slice(-MAX_CONSULTATIONS),
      history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: "consult", pmAnswer: pmResult.answer, action: "consult", expertOutputs: expertSummaries })
    };
    stateDoc.threads[threadKey] = updates;
    await saveThreadState(stateDoc);

    return { ok: true, message: finalMessage, updates };
  }

  // --- EXECUTE: spawn execution team ---
  if (action.type === "execute") {
    // Resolve target repo from TARGET_REPO signal or project default
    let execRepo = repo;
    if (projectContext && action.targetRepo) {
      const targetRepoConfig = projectContext.repos?.[action.targetRepo];
      if (targetRepoConfig?.path) {
        execRepo = targetRepoConfig.path;
      }
    }

    await setActiveOperation(stateDoc, threadKey, threadState, {
      type: "execute",
      startedAt: nowIso(),
      description: `Executing: ${action.value}`
    });

    await emitStage({ type: "execute_started", goal: action.value, targetRepo: action.targetRepo || null });

    const executionPrompt = buildExecutionPrompt({
      goal: action.value,
      repoPath: execRepo,
      teamConfig: loaded.config,
      pmContext: pmResult.answer
    });

    const heartbeatTimer = setInterval(() => {
      emitStage({ type: "execute_heartbeat", elapsedMs: Date.now() - consultStartedAt });
    }, 15_000);

    let execResult;
    try {
      execResult = await runExecutionCall({
        providerName: loaded.config.providers?.executionProvider || "claude-teams",
        prompt: executionPrompt,
        context: {
          repoPath: execRepo,
          providers: loaded.config.providers,
          mode: "execution"
        },
        extraEnv: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
          ...(loaded.config.providers?.executionEnv || {})
        }
      });
    } finally {
      clearInterval(heartbeatTimer);
      await clearActiveOperation(stateDoc, threadKey, threadState);
    }

    await emitStage({
      type: "execute_completed",
      ok: execResult.ok,
      durationMs: execResult.durationMs
    });

    const execSummary = execResult.ok
      ? execResult.output
      : `Error: ${execResult.error || "execution failed"}`;

    // Auto-capture execution result to memory
    captureToMemory({
      type: execResult.ok ? "execution" : "error_pattern",
      title: `${execResult.ok ? "Executed" : "Failed"}: ${action.value.slice(0, 80)}`,
      content: `Goal: ${action.value}\nStatus: ${execResult.ok ? "success" : "failed"}\nSummary: ${execSummary.slice(0, 400)}`,
      project: projectName,
      topicKey: `exec/${action.value.slice(0, 40).replace(/\s+/g, "-").toLowerCase()}`
    });

    // --- Code Review Gate (optional, post-execution) ---
    let reviewSection = "";
    if (execResult.ok && isCodeReviewEnabled(loaded.config)) {
      await emitStage({ type: "review_started" });

      const reviewResult = await runCodeReview({
        repoPath: execRepo,
        teamConfig: loaded.config,
        goal: action.value
      });

      await emitStage({
        type: "review_completed",
        passed: reviewResult.passed,
        durationMs: reviewResult.durationMs
      });

      reviewSection = formatReviewForSlack(reviewResult);

      // Capture review to memory
      if (!reviewResult.skipped) {
        captureToMemory({
          type: reviewResult.passed ? "decision" : "error_pattern",
          title: `Review ${reviewResult.passed ? "passed" : "failed"}: ${action.value.slice(0, 60)}`,
          content: `Verdict: ${reviewResult.passed ? "approved" : "changes requested"}\n${reviewResult.summary}\nIssues: ${(reviewResult.issues || []).length}`,
          project: projectName,
          topicKey: `review/${action.value.slice(0, 40).replace(/\s+/g, "-").toLowerCase()}`
        });
      }
    }

    const finalMessage = `${pmResult.answer}\n\n---\n*Resultado de ejecucion:*\n${execSummary}${reviewSection}`;
    const newConsultation = {
      at: nowIso(),
      question: cleanedQuestion,
      consultRoles: ["tech-lead"],
      pmAnswer: (pmResult.answer || "").slice(0, PM_ANSWER_TRUNCATE),
      executionGoal: action.value,
      executionOk: execResult.ok
    };
    const updates = {
      ...threadState,
      lastConsultation: newConsultation,
      consultations: [...(threadState.consultations || []), newConsultation].slice(-MAX_CONSULTATIONS),
      history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: "execute", pmAnswer: pmResult.answer, action: "execute" })
    };
    stateDoc.threads[threadKey] = updates;
    await saveThreadState(stateDoc);

    return { ok: true, message: finalMessage, updates };
  }

  // --- BRAINSTORM: team brainstorm session ---
  if (action.type === "brainstorm") {
    await setActiveOperation(stateDoc, threadKey, threadState, {
      type: "brainstorm",
      startedAt: nowIso(),
      description: `Brainstorming: ${action.value}`
    });

    let brainstorm;
    try {
      brainstorm = await createBrainstormSession({
        teamConfig: loaded.config,
        repoPath: repo,
        topic: action.value
      });
    } finally {
      await clearActiveOperation(stateDoc, threadKey, threadState);
    }

    const updates = {
      ...threadState,
      lastTeamSessionId: brainstorm.session.sessionId,
      history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: "brainstorm", pmAnswer: pmResult.answer, action: "brainstorm" })
    };
    stateDoc.threads[threadKey] = updates;
    await saveThreadState(stateDoc);

    const brainstormSummary = formatBrainstormSummary(brainstorm.session, brainstorm.decisionPack);
    return {
      ok: true,
      message: `${pmResult.answer}\n\n---\n${brainstormSummary}`,
      updates
    };
  }

  // --- CREATE_PR: push branch and create PR directly ---
  if (action.type === "createpr") {
    const branch = action.value;
    await emitStage({ type: "createpr_started", branch });

    const ghToken = await resolveProfileToken(context.profile);
    const ghCheck = await ensureGhAvailable(repo, ghToken);
    if (!ghCheck.ok) {
      const updates = {
        ...threadState,
        history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: "createpr_error", pmAnswer: pmResult.answer })
      };
      stateDoc.threads[threadKey] = updates;
      await saveThreadState(stateDoc);
      return { ok: false, message: `${pmResult.answer}\n\n❌ gh CLI no disponible: ${ghCheck.error}`, updates };
    }

    const remoteCheck = await runGitInCwd(repo, ["ls-remote", "--heads", "origin", branch]);
    const alreadyPushed = remoteCheck.ok && remoteCheck.stdout.includes(branch);

    if (!alreadyPushed) {
      const push = await runGitInCwd(repo, ["push", "-u", "origin", branch]);
      if (!push.ok) {
        const updates = {
          ...threadState,
          history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: "createpr_error", pmAnswer: pmResult.answer })
        };
        stateDoc.threads[threadKey] = updates;
        await saveThreadState(stateDoc);
        return { ok: false, message: `${pmResult.answer}\n\n❌ Push failed: ${push.stderr}`, updates };
      }
    }

    const pr = await createPullRequest({ cwd: repo, base: "main", head: branch, title: branch, body: `PR for branch ${branch}`, ghToken });
    const prMessage = pr.ok
      ? `✅ PR creado: ${pr.url || pr.raw}`
      : `❌ PR creation failed: ${pr.error}`;

    await emitStage({ type: "createpr_completed", ok: pr.ok, branch, url: pr.url || null });

    const updates = {
      ...threadState,
      history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: "createpr", pmAnswer: pmResult.answer })
    };
    stateDoc.threads[threadKey] = updates;
    await saveThreadState(stateDoc);

    return { ok: pr.ok, message: `${pmResult.answer}\n\n${prMessage}`, updates };
  }

  // --- Hub commands: STATUS, APPROVE, STOP, START, PUSHPR, NEW_RUN ---
  // Resolve the target repo for hub commands that need it
  let hubActionRepo = repo;
  if (projectContext && action.targetRepo) {
    const targetRepoConfig = projectContext.repos?.[action.targetRepo];
    if (targetRepoConfig?.path) {
      hubActionRepo = targetRepoConfig.path;
    }
  }

  const hubActionMap = {
    status: (val) => `status ${val}`,
    approve: (val) => `approve ${val}`,
    stop: (val) => `stop ${val}`,
    start: (val) => `start ${val}`,
    pushpr: (val) => `pushpr ${val}`,
    newRun: (val) => `run --repo ${hubActionRepo} "${val.replace(/"/g, '\\"')}"`
  };

  const commandBuilder = hubActionMap[action.type];
  if (commandBuilder) {
    const command = commandBuilder(action.value);
    const exec = await runHubCommand(command);
    let followup = "";
    let lastRunId = threadState.lastRunId;

    const idFromText = extractRunId(exec.output || "") || extractRunId(action.value || "");
    if (idFromText) {
      lastRunId = idFromText;
    }

    if (action.type === "status" && lastRunId) {
      try {
        const run = await loadRun(lastRunId);
        followup = `\n\n${formatRunForPm(run)}`;
      } catch {
        // ignore
      }
    }

    if (action.type === "newRun") {
      const runs = await listRuns(1);
      if (runs[0]?.runId) {
        lastRunId = runs[0].runId;
        followup = `\n\nSiguiente sugerido: \"Inicia el run ${lastRunId}\".`;
      }
    }

    const updates = {
      ...threadState,
      lastRunId,
      history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: action.type, pmAnswer: pmResult.answer, action: action.type })
    };
    stateDoc.threads[threadKey] = updates;
    await saveThreadState(stateDoc);

    return {
      ok: exec.ok,
      message: `${pmResult.answer}\n\n${exec.ok ? "✅" : "❌"}\n\n${exec.output}${followup}`,
      updates
    };
  }

  // --- Fallback: unknown action, return PM answer ---
  const updates = {
    ...threadState,
    history: buildHistoryEntries({ existingHistory: threadState.history, userText: text, intent: action.type || "unknown", pmAnswer: pmResult.answer, action: action.type })
  };
  stateDoc.threads[threadKey] = updates;
  await saveThreadState(stateDoc);

  return { ok: true, message: pmResult.answer, updates };
  });
}
