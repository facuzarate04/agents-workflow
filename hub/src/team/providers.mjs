import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { HUB_ROOT, ensureDir, nowIso } from "../core/utils.mjs";

const execFileAsync = promisify(execFile);
const PROVIDER_TRACE_PATH = path.join(HUB_ROOT, ".state", "providers", "trace.log");

function buildCommonBrief({ role, topic, context, pmAnalysis }) {
  const isConsultMode = context.mode === "technical-consult";
  const sections = [];

  if (isConsultMode) {
    sections.push(
      "MODE: CONSULTATION. Provide analysis and recommendations as text only. Do NOT read, edit, or create files. Do NOT use tools. The user will explicitly request implementation in a separate step.",
      ""
    );
  }

  sections.push(
    `Role: ${role.name} (${role.id})`,
    `Persona: ${role.persona || "n/a"}`,
    `Topic: ${topic}`,
    `Repo: ${context.repoPath || "n/a"}`,
    "",
    "Responsibilities:"
  );
  sections.push(...(role.responsibilities || []).map((item) => `- ${item}`));
  sections.push(
    "",
    "Deliverables:"
  );
  sections.push(...(role.deliverables || []).map((item) => `- ${item}`));

  if (pmAnalysis) {
    sections.push(
      "",
      "PM Analysis (build on this, provide your expert depth):",
      pmAnalysis.slice(0, 800),
      ""
    );
  }

  sections.push(
    "",
    "Expected response format (use JSON envelope if possible):",
    "```json",
    "{",
    '  "status": "completed",',
    '  "summary": "concise analysis summary",',
    '  "recommendations": ["specific recommendation 1", "..."],',
    '  "risks": ["specific risk 1", "..."],',
    '  "artifacts": ["file/path if applicable"],',
    '  "next_recommended": "suggested next step"',
    "}",
    "```",
    "If JSON is not possible, use text with clear section headers: Summary, Recommendations, Risks, Next actions."
  );

  return sections.join("\n");
}

function buildStrictBrief({ role, topic, context, pmAnalysis }) {
  return [
    buildCommonBrief({ role, topic, context, pmAnalysis }),
    "",
    "Quality requirements (mandatory):",
    "- Be specific to this repository/topic. Avoid generic advice.",
    "- Provide exactly 3 concrete recommendations.",
    "- Provide exactly 3 concrete risks.",
    "- Each recommendation must include one actionable step.",
    "- Do not reference prompt file paths or configuration instructions."
  ].join("\n");
}

function makeLocalResponse({ role, topic, context, pmAnalysis }) {
  return {
    status: "completed",
    provider: "local-template",
    generatedAt: nowIso(),
    content: {
      summary: `${role.name} perspective on '${topic}'`,
      assumptions: [
        "Current scope is inferred from initial request.",
        "No hidden external dependencies were provided."
      ],
      recommendations: [
        `${role.name}: clarify 1-2 critical unknowns before implementation.`,
        `${role.name}: define measurable acceptance criteria.`
      ],
      risks: [
        "Requirements ambiguity may cause rework.",
        "Cross-role alignment may be missing without explicit handoff."
      ],
      nextActions: [
        `Ask ${role.name} to validate decisions after first implementation draft.`
      ]
    },
    prompt: buildCommonBrief({ role, topic, context, pmAnalysis })
  };
}

function makeExternalDispatch({ role, topic, context, reason = null, pmAnalysis }) {
  const inferred = {
    summary: `${role.name} expert hypothesis for '${topic}'`,
    assumptions: [
      "No runtime traces were provided in the request.",
      "Current architecture details are inferred from available metadata."
    ],
    recommendations: [
      `${role.name}: validate one concrete technical approach before implementation.`,
      `${role.name}: produce a minimal spike or proof before large refactor.`
    ],
    risks: [
      `${role.name}: hidden coupling may increase regression risk.`,
      `${role.name}: unclear non-functional constraints (latency, scale, reliability).`
    ],
    nextActions: [
      `Dispatch this prompt to provider '${role.provider}' for deep expert validation.`
    ]
  };

  return {
    status: "dispatch_required",
    provider: role.provider,
    generatedAt: nowIso(),
    content: inferred,
    prompt: buildCommonBrief({ role, topic, context, pmAnalysis }),
    note: reason || `Provider '${role.provider}' not wired in this environment.`
  };
}

function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => `${vars[key] || ""}`);
}

function compactErrorMessage(raw) {
  const text = `${raw || ""}`.trim();
  if (!text) return "unknown provider error";

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const headlineMatch =
    text.match(/SyntaxError:[^\n]*/i) ||
    text.match(/TypeError:[^\n]*/i) ||
    text.match(/ReferenceError:[^\n]*/i) ||
    text.match(/Error:[^\n]*/i) ||
    text.match(/ERR_[A-Z0-9_]+[^\n]*/);

  const priorityLine = headlineMatch?.[0] || lines.at(-1) || lines[0] || text;

  const noPath = priorityLine.replace(/\/Users\/[^\s]+/g, "[path]");
  return noPath.length > 220 ? `${noPath.slice(0, 217)}...` : noPath;
}

function compactTraceText(text) {
  return `${text || ""}`.replace(/\s+/g, " ").replace(/\/Users\/[^\s]+/g, "[path]").trim();
}

async function appendProviderTrace(message) {
  try {
    await ensureDir(path.dirname(PROVIDER_TRACE_PATH));
    await fs.appendFile(PROVIDER_TRACE_PATH, `[${nowIso()}] ${message}\n`, "utf8");
  } catch {
    // tracing must not break execution
  }
}

function parseDotenv(raw) {
  const out = {};
  for (const line of `${raw || ""}`.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

async function loadDotenvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseDotenv(raw);
  } catch {
    return {};
  }
}

async function buildProviderEnv(context) {
  const providers = context?.providers || {};
  const candidates = [
    path.join(HUB_ROOT, "config", "slack", ".env"),
    process.env.HUB_ENV_FILE,
    providers.envFile
  ].filter(Boolean);

  const merged = {};
  for (const candidate of candidates) {
    const loaded = await loadDotenvFile(candidate);
    Object.assign(merged, loaded);
  }

  return merged;
}

function resolveCommandTimeoutMs(context, providerName = null) {
  const byProvider = context?.providers?.providerTimeoutByProviderMs || {};
  if (providerName && Number.isFinite(Number(byProvider[providerName])) && Number(byProvider[providerName]) > 0) {
    return Number(byProvider[providerName]);
  }

  const byMode = context?.providers?.providerTimeoutByModeMs || {};
  const mode = context?.mode || "default";
  const modeTimeout = Number(byMode[mode]);
  if (Number.isFinite(modeTimeout) && modeTimeout > 0) {
    return modeTimeout;
  }

  const globalTimeout = Number(context?.providers?.providerTimeoutMs);
  if (Number.isFinite(globalTimeout) && globalTimeout > 0) {
    return globalTimeout;
  }

  return 2 * 60 * 1000;
}

function shouldRetryStrictly(context) {
  const byMode = context?.providers?.strictRetryByMode || {};
  const mode = context?.mode || "default";
  if (typeof byMode[mode] === "boolean") {
    return byMode[mode];
  }

  if (typeof context?.providers?.strictRetry === "boolean") {
    return context.providers.strictRetry;
  }

  return mode !== "technical-consult";
}

function shouldRunPipelineParallel(context) {
  const byMode = context?.providers?.parallelPipelineByMode || {};
  const mode = context?.mode || "default";
  if (typeof byMode[mode] === "boolean") {
    return byMode[mode];
  }

  if (typeof context?.providers?.parallelPipeline === "boolean") {
    return context.providers.parallelPipeline;
  }

  return mode === "technical-consult";
}

async function runCommand(command, cwd, timeoutMs, extraEnv = {}, { idleTimeoutMs = 0 } = {}) {
  if (idleTimeoutMs > 0) {
    return runCommandWithIdleTimeout(command, cwd, timeoutMs, extraEnv, idleTimeoutMs);
  }

  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv
      },
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 20
    });

    return {
      ok: true,
      stdout: stdout?.trim() || "",
      stderr: stderr?.trim() || "",
      durationMs: Date.now() - startedAt,
      timedOut: false
    };
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    const timedOut =
      error?.killed === true &&
      `${error?.signal || ""}`.toUpperCase() === "SIGTERM" &&
      (
        /timed out/i.test(`${error?.message || ""}`) ||
        elapsed >= Math.max(1000, timeoutMs - 200)
      );

    return {
      ok: false,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || error.message,
      durationMs: elapsed,
      timedOut
    };
  }
}

function runCommandWithIdleTimeout(command, cwd, maxTimeoutMs, extraEnv, idleTimeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let idleTimer = null;
    let maxTimer = null;

    const child = spawn("zsh", ["-lc", command], {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"]
    });

    // Close stdin so shell pipes (cat file | cmd) work through the shell
    // but our Node process doesn't keep the child waiting for more input
    child.stdin.end();

    function finish(ok, timedOut) {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      resolve({
        ok,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
        durationMs: Date.now() - startedAt,
        timedOut
      });
    }

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(false, true);
      }, idleTimeoutMs);
    }

    maxTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false, true);
    }, maxTimeoutMs);

    resetIdleTimer();

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      resetIdleTimer();
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      resetIdleTimer();
    });

    child.on("close", (code) => {
      finish(code === 0, false);
    });

    child.on("error", (error) => {
      stderrChunks.push(Buffer.from(error.message));
      finish(false, false);
    });
  });
}

/**
 * Strip ANSI escape codes and TTY control sequences from PTY output.
 */
function stripAnsi(text) {
  return (text || "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\][^\x1b]*(?:\x1b\\)?/g, "")
    .replace(/[\x00-\x08\x0e-\x1f]/g, "")
    .replace(/\r/g, "");
}

/**
 * Extracts plain text from Claude stream-json NDJSON output.
 * If the output is not NDJSON (e.g. plain text from codex), returns it as-is.
 * Strips ANSI/TTY escape codes from PTY-spawned processes.
 */
function extractStreamJsonText(rawOutput) {
  const cleaned = stripAnsi(rawOutput);
  if (!cleaned || !cleaned.includes('"type"')) return cleaned;
  try {
    const lines = cleaned.split("\n").filter((l) => l.trim());
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "result" && typeof parsed.result === "string") {
          return parsed.result;
        }
      } catch { /* skip non-JSON lines */ }
    }
    // Fallback: prefer assistant message (complete text), fall back to deltas
    const deltas = [];
    const assistantTexts = [];
    for (const line of cleaned.split("\n")) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.type === "content_block_delta" && parsed.delta?.text) {
          deltas.push(parsed.delta.text);
        } else if (parsed.type === "assistant" && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === "text") assistantTexts.push(block.text);
          }
        }
      } catch { /* skip non-JSON lines */ }
    }
    if (assistantTexts.length > 0) return assistantTexts.join("");
    if (deltas.length > 0) return deltas.join("");
    return cleaned;
  } catch {
    return cleaned;
  }
}

/**
 * Standard envelope shape for all expert responses.
 * Every provider output is normalized to this format.
 */
function makeEmptyEnvelope(roleName, topic) {
  return {
    status: "completed",
    summary: `${roleName} analysis for '${topic}'`,
    recommendations: [],
    risks: [],
    artifacts: [],
    next_recommended: null
  };
}

/**
 * Try to extract a structured JSON envelope from raw provider output.
 * Providers can return a ```json block or inline JSON with envelope fields.
 */
function tryParseJsonEnvelope(rawOutput) {
  if (!rawOutput) return null;

  // Try to find a ```json ... ``` block
  const jsonBlockMatch = rawOutput.match(/```json\s*\n([\s\S]*?)\n```/);
  const candidate = jsonBlockMatch ? jsonBlockMatch[1].trim() : null;

  // Also try the whole output if it looks like JSON
  const candidates = [candidate, rawOutput.trim()].filter(Boolean);

  for (const text of candidates) {
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text);
      // Must have at least summary or recommendations to be a valid envelope
      if (parsed.summary || Array.isArray(parsed.recommendations)) {
        return {
          status: parsed.status || "completed",
          summary: parsed.summary || "",
          recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 8) : [],
          risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 8) : [],
          artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.slice(0, 10) : [],
          next_recommended: parsed.next_recommended || parsed.nextRecommended || null
        };
      }
    } catch { /* not valid JSON */ }
  }

  return null;
}

/**
 * Parse raw provider text into envelope fields via section headers.
 */
function parseTextToEnvelope(rawOutput, roleName) {
  const lines = (rawOutput || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const summary = lines[0] || `${roleName} provider completed without explicit summary.`;

  const recommendations = [];
  const risks = [];
  const nextActions = [];

  let section = "";
  for (const line of lines.slice(1)) {
    const lower = line.toLowerCase();
    if (lower.includes("recommend")) {
      section = "recommendations";
      continue;
    }
    if (lower.includes("risk")) {
      section = "risks";
      continue;
    }
    if (lower.includes("next action") || lower.includes("next step")) {
      section = "nextActions";
      continue;
    }

    const item = line.replace(/^[-*]\s*/, "").trim();
    if (!item) continue;

    if (section === "recommendations") {
      recommendations.push(item);
      continue;
    }
    if (section === "risks") {
      risks.push(item);
      continue;
    }
    if (section === "nextActions") {
      nextActions.push(item);
      continue;
    }

    if (/(^|\s)risk(s)?(\s|:)/i.test(item)) {
      risks.push(item.replace(/(^|\s)risk(s)?(\s|:)/i, "").trim() || item);
    } else {
      recommendations.push(item);
    }
  }

  return {
    summary,
    assumptions: [],
    recommendations: recommendations.length ? recommendations.slice(0, 6) : [`${roleName}: review raw provider output.`],
    risks: risks.slice(0, 6),
    nextActions: nextActions.length ? nextActions.slice(0, 6) : [`${roleName}: validate and refine this output before execution.`]
  };
}

/**
 * Normalize any provider output into a standard envelope.
 * Tries JSON envelope first, falls back to text parsing.
 */
function normalizeToEnvelope(rawOutput, roleName) {
  // Try structured JSON envelope first
  const jsonEnvelope = tryParseJsonEnvelope(rawOutput);
  if (jsonEnvelope) {
    return jsonEnvelope;
  }

  // Fall back to text parsing
  const parsed = parseTextToEnvelope(rawOutput, roleName);
  return {
    status: "completed",
    summary: parsed.summary,
    recommendations: parsed.recommendations,
    risks: parsed.risks,
    artifacts: [],
    next_recommended: parsed.nextActions?.[0] || null
  };
}

/**
 * Legacy wrapper — maps envelope to the old content shape for backward compatibility.
 * Used internally where the old {summary, assumptions, recommendations, risks, nextActions} is expected.
 */
function envelopeToLegacyContent(envelope) {
  return {
    summary: envelope.summary,
    assumptions: [],
    recommendations: envelope.recommendations || [],
    risks: envelope.risks || [],
    nextActions: envelope.next_recommended ? [envelope.next_recommended] : []
  };
}

function summarizeProviderOutput(rawOutput, roleName) {
  const envelope = normalizeToEnvelope(rawOutput, roleName);
  return envelopeToLegacyContent(envelope);
}

function evaluateContentQuality(content, rawOutput = "") {
  const summary = (content?.summary || "").trim().toLowerCase();
  const recommendations = content?.recommendations || [];
  const risks = content?.risks || [];
  const text = (rawOutput || "").toLowerCase();

  const genericSignals = [
    "configure ",
    "prompt file",
    "review raw provider output",
    "not wired",
    "no command configured"
  ];

  const hasGenericSignal =
    genericSignals.some((signal) => summary.includes(signal) || text.includes(signal)) ||
    summary.includes("expert hypothesis");

  if (hasGenericSignal) {
    return {
      ok: false,
      reason: "provider output is generic or configuration-oriented"
    };
  }

  if (recommendations.length < 2 || risks.length < 1) {
    return {
      ok: false,
      reason: "provider output is missing concrete recommendations/risks"
    };
  }

  return { ok: true, reason: null };
}

function unique(list = []) {
  return [...new Set(list.filter(Boolean))];
}

function resolvePipelineProviders({ role, context }) {
  const providers = context.providers || {};
  const mode = context.mode || "default";
  const pipelines = providers.providerPipelines || {};
  const modePipelines = pipelines[mode] || {};

  const rolePipeline = modePipelines[role.id];
  const defaultPipeline = modePipelines.default;

  if (Array.isArray(rolePipeline) && rolePipeline.length > 0) {
    return unique(rolePipeline);
  }

  if (Array.isArray(defaultPipeline) && defaultPipeline.length > 0) {
    return unique(defaultPipeline);
  }

  return [];
}

function buildProviderCandidates({ role, context }) {
  const configured = context.providers || {};
  const fallbackChain = Array.isArray(configured.fallbackChain) ? configured.fallbackChain : [];
  return unique([
    role.provider,
    configured.execution,
    configured.fallback,
    ...fallbackChain
  ]);
}

function mergeContentFromProviderResults({ role, topic, providerResults }) {
  const completed = providerResults.filter((entry) => entry.result?.status === "completed");
  if (!completed.length) {
    return {
      summary: `${role.name} expert hypothesis for '${topic}'`,
      assumptions: [
        "No runtime traces were provided in the request.",
        "Current architecture details are inferred from available metadata."
      ],
      recommendations: [
        `${role.name}: validate one concrete technical approach before implementation.`,
        `${role.name}: produce a minimal spike or proof before large refactor.`
      ],
      risks: [
        `${role.name}: hidden coupling may increase regression risk.`,
        `${role.name}: unclear non-functional constraints (latency, scale, reliability).`
      ],
      nextActions: [
        `Retry provider collaboration after fixing provider command/runtime issues.`
      ]
    };
  }

  const summaryBits = completed
    .map((entry) => `[${entry.provider}] ${entry.result?.content?.summary || "sin resumen"}`)
    .slice(0, 2);

  const recommendations = [];
  const risks = [];
  const nextActions = [];
  const seenRec = new Set();
  const seenRisk = new Set();

  for (const entry of completed) {
    for (const rec of entry.result?.content?.recommendations || []) {
      const normalized = rec.trim().toLowerCase();
      if (!normalized || seenRec.has(normalized)) continue;
      seenRec.add(normalized);
      recommendations.push(`[${entry.provider}] ${rec}`);
    }
    for (const risk of entry.result?.content?.risks || []) {
      const normalized = risk.trim().toLowerCase();
      if (!normalized || seenRisk.has(normalized)) continue;
      seenRisk.add(normalized);
      risks.push(`[${entry.provider}] ${risk}`);
    }
    for (const next of entry.result?.content?.nextActions || []) {
      nextActions.push(`[${entry.provider}] ${next}`);
    }
  }

  return {
    summary: `${role.name} synthesis (${completed.length} providers): ${summaryBits.join(" | ")}`,
    assumptions: [`Synthesis built from provider collaboration for role '${role.id}'.`],
    recommendations: recommendations.slice(0, 6),
    risks: risks.slice(0, 6),
    nextActions: nextActions.slice(0, 4)
  };
}

async function runSingleConfiguredProvider({ providerName, role, topic, context, pmAnalysis }) {
  const startedAt = Date.now();
  const timeoutMs = resolveCommandTimeoutMs(context, providerName);
  const runtimeEnv = await buildProviderEnv(context);
  const providerModels = context?.providers?.providerModels || {};

  if (providerName === "codex-api" || providerName === "openai-responses") {
    const apiKey = runtimeEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const reason = "OPENAI_API_KEY missing in provider runtime env.";
      await appendProviderTrace(`provider=${providerName} role=${role.id} status=fail reason="${reason}" repo=${compactTraceText(context.repoPath || process.cwd())}`);
      return {
        ok: false,
        result: makeExternalDispatch({
          role,
          topic,
          context,
          reason: `Provider command failed for '${providerName}': ${reason}`,
          pmAnalysis
        }),
        metrics: {
          durationMs: Date.now() - startedAt,
          timeoutMs
        }
      };
    }

    const endpoint = runtimeEnv.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const model = providerModels[providerName] || providerModels.codex || "gpt-5.2-codex";
    const prompt = buildCommonBrief({ role, topic, context, pmAnalysis });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

    try {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: prompt
        }),
        signal: controller.signal
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = `OpenAI Responses HTTP ${response.status}: ${compactErrorMessage(data?.error?.message || response.statusText || "request_failed")}`;
        await appendProviderTrace(`provider=${providerName} role=${role.id} status=fail timed_out=false ms=${Date.now() - startedAt} reason="${compactTraceText(reason)}" repo=${compactTraceText(context.repoPath || process.cwd())}`);
        return {
          ok: false,
          result: makeExternalDispatch({
            role,
            topic,
            context,
            reason: `Provider command failed for '${providerName}': ${reason}`,
            pmAnalysis
          }),
          metrics: {
            durationMs: Date.now() - startedAt,
            timeoutMs
          }
        };
      }

      const textParts = [];
      if (typeof data?.output_text === "string" && data.output_text.trim()) {
        textParts.push(data.output_text.trim());
      }
      for (const item of data?.output || []) {
        for (const content of item?.content || []) {
          if (typeof content?.text === "string" && content.text.trim()) {
            textParts.push(content.text.trim());
          }
          if (typeof content?.value === "string" && content.value.trim()) {
            textParts.push(content.value.trim());
          }
        }
      }

      const rawOutput = textParts.join("\n").trim();
      const content = summarizeProviderOutput(rawOutput, role.name);
      const quality = evaluateContentQuality(content, rawOutput);
      const durationMs = Date.now() - startedAt;
      if (!quality.ok) {
        await appendProviderTrace(`provider=${providerName} role=${role.id} status=insufficient ms=${durationMs} reason="${compactTraceText(quality.reason)}" repo=${compactTraceText(context.repoPath || process.cwd())}`);
        return {
          ok: false,
          result: {
            status: "insufficient",
            provider: providerName,
            generatedAt: nowIso(),
            prompt,
            rawOutput,
            content,
            note: `Insufficient expert output: ${quality.reason}.`,
            metrics: {
              durationMs,
              timeoutMs
            }
          },
          metrics: {
            durationMs,
            timeoutMs
          }
        };
      }

      await appendProviderTrace(`provider=${providerName} role=${role.id} status=ok ms=${durationMs} repo=${compactTraceText(context.repoPath || process.cwd())}`);
      const envelope = normalizeToEnvelope(rawOutput, role.name);
      return {
        ok: true,
        result: {
          status: "completed",
          provider: providerName,
          generatedAt: nowIso(),
          prompt,
          rawOutput,
          content,
          envelope,
          quality,
          metrics: {
            durationMs,
            timeoutMs
          }
        },
        metrics: {
          durationMs,
          timeoutMs
        }
      };
    } catch (error) {
      const isTimeout = `${error}`.includes("timeout") || `${error?.name || ""}` === "AbortError";
      const reason = isTimeout ? `Provider command timed out after ${Math.round(timeoutMs / 1000)}s` : `Provider command failed for '${providerName}': ${compactErrorMessage(error?.message || `${error}`)}`;
      await appendProviderTrace(`provider=${providerName} role=${role.id} status=fail timed_out=${isTimeout} ms=${Date.now() - startedAt} reason="${compactTraceText(reason)}" repo=${compactTraceText(context.repoPath || process.cwd())}`);
      return {
        ok: false,
        result: makeExternalDispatch({
          role,
          topic,
          context,
          reason,
          pmAnalysis
        }),
        metrics: {
          durationMs: Date.now() - startedAt,
          timeoutMs
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const commands = context.providers?.providerCommands || {};
  const template = commands[providerName];
  if (!template || typeof template !== "string") {
    return {
      ok: false,
      result: makeExternalDispatch({
        role,
        topic,
        context,
        reason: `No command configured for provider '${providerName}'. Add providers.providerCommands.${providerName} in team config.`,
        pmAnalysis
      }),
      metrics: {
        durationMs: Date.now() - startedAt,
        timeoutMs
      }
    };
  }

  const prompt = buildCommonBrief({ role, topic, context, pmAnalysis });
  const promptsDir = path.join(HUB_ROOT, ".state", "team-prompts");
  await ensureDir(promptsDir);

  const promptFile = path.join(promptsDir, `${Date.now()}-${role.id}.md`);
  await fs.writeFile(promptFile, prompt, "utf8");

  const command = renderTemplate(template, {
    repo_path: context.repoPath || process.cwd(),
    role_id: role.id,
    role_name: role.name,
    topic,
    prompt_file: promptFile
  });

  const cliEnv = { ...runtimeEnv };
  const envExclude = context.providers?.providerEnvExclude?.[providerName];
  if (Array.isArray(envExclude)) {
    for (const key of envExclude) {
      delete cliEnv[key];
    }
  }

  const idleTimeoutMs = Number(context.providers?.providerIdleTimeoutMs) || 30_000;
  const maxTimeoutMs = Number(context.providers?.providerMaxTimeoutMs) || 5 * 60 * 1000;
  const exec = await runCommand(command, context.repoPath || process.cwd(), maxTimeoutMs, cliEnv, { idleTimeoutMs });
  if (!exec.ok) {
    const reason = exec.timedOut
      ? `Provider command timed out after ${Math.round(timeoutMs / 1000)}s`
      : `Provider command failed for '${providerName}': ${compactErrorMessage(exec.stderr)}`;
    await appendProviderTrace(`provider=${providerName} role=${role.id} status=fail timed_out=${exec.timedOut} ms=${exec.durationMs} reason="${compactTraceText(reason)}" repo=${compactTraceText(context.repoPath || process.cwd())}`);

    return {
      ok: false,
      result: makeExternalDispatch({
        role,
        topic,
        context,
        reason,
        pmAnalysis
      }),
      metrics: {
        durationMs: Date.now() - startedAt,
        commandDurationMs: exec.durationMs,
        timeoutMs
      }
    };
  }

  const plainOutput = extractStreamJsonText(exec.stdout);
  let content = summarizeProviderOutput(plainOutput, role.name);
  let quality = evaluateContentQuality(content, plainOutput);
  let strictAttempt = null;

  if (!quality.ok && shouldRetryStrictly(context)) {
    const strictPrompt = buildStrictBrief({ role, topic, context, pmAnalysis });
    const strictPromptFile = path.join(promptsDir, `${Date.now()}-${role.id}-strict.md`);
    await fs.writeFile(strictPromptFile, strictPrompt, "utf8");

    const strictCommand = renderTemplate(template, {
      repo_path: context.repoPath || process.cwd(),
      role_id: role.id,
      role_name: role.name,
      topic,
      prompt_file: strictPromptFile
    });

    const strictExec = await runCommand(strictCommand, context.repoPath || process.cwd(), maxTimeoutMs, cliEnv, { idleTimeoutMs });
    if (strictExec.ok) {
      const strictContent = summarizeProviderOutput(strictExec.stdout, role.name);
      const strictQuality = evaluateContentQuality(strictContent, strictExec.stdout);
      strictAttempt = {
        command: strictCommand,
        ok: strictQuality.ok,
        reason: strictQuality.reason,
        durationMs: strictExec.durationMs
      };

      if (strictQuality.ok) {
        content = strictContent;
        quality = strictQuality;
      }
    }
  }

  if (!quality.ok) {
    return {
      ok: false,
      result: {
        status: "insufficient",
        provider: providerName,
        generatedAt: nowIso(),
        prompt,
        command,
        rawOutput: plainOutput,
        content,
        note: `Insufficient expert output: ${quality.reason}.`,
        strictAttempt,
        metrics: {
          durationMs: Date.now() - startedAt,
          commandDurationMs: exec.durationMs,
          timeoutMs
        }
      },
      metrics: {
        durationMs: Date.now() - startedAt,
        commandDurationMs: exec.durationMs,
        timeoutMs
      }
    };
  }

  await appendProviderTrace(`provider=${providerName} role=${role.id} status=ok ms=${exec.durationMs} repo=${compactTraceText(context.repoPath || process.cwd())}`);

  const envelope = normalizeToEnvelope(plainOutput, role.name);

  return {
    ok: true,
    result: {
      status: "completed",
      provider: providerName,
      generatedAt: nowIso(),
      prompt,
      command,
      rawOutput: exec.stdout,
      content,
      envelope,
      quality,
      metrics: {
        durationMs: Date.now() - startedAt,
        commandDurationMs: exec.durationMs,
        timeoutMs
      }
    },
    metrics: {
      durationMs: Date.now() - startedAt,
      commandDurationMs: exec.durationMs,
      timeoutMs
    }
  };
}

function buildValidationBrief({ role, topic, context, generatedOutput, generatorProvider }) {
  return [
    `You are reviewing the analysis from ${role.name} (${role.id}).`,
    `The analysis was generated by ${generatorProvider} for the following topic:`,
    `Topic: ${topic}`,
    `Repo: ${context.repoPath || "n/a"}`,
    "",
    "Generated analysis to review:",
    (generatedOutput || "").slice(0, 2000),
    "",
    "Your job as validator:",
    "1. Check for unsupported claims or hallucinations — flag anything not grounded in concrete evidence.",
    "2. Identify missing risks or blind spots the original analysis overlooked.",
    "3. Challenge generic recommendations — push for specificity.",
    "4. If the analysis is solid, confirm it and add any refinements.",
    "5. Return a CORRECTED version of the analysis incorporating your review.",
    "",
    "Expected response format:",
    "1) Validated Summary (corrected if needed)",
    "2) Recommendations (keep good ones, fix or replace weak ones)",
    "3) Risks (add any missed)",
    "4) Next actions",
    "5) Validation notes (what you changed and why)"
  ].join("\n");
}

async function runCollaborativeProviders({ role, topic, context, pipeline, pmAnalysis }) {
  const startedAt = Date.now();
  const attempted = [];
  let generatorResult = null;
  let generatorProvider = null;

  // Phase 1: Generate — try each provider until one succeeds
  for (const providerName of pipeline) {
    if (["local-template", "local", "template"].includes(providerName)) {
      attempted.push({ provider: providerName, status: "skipped", phase: "generator", note: null, durationMs: 0 });
      continue;
    }

    const attempt = await runSingleConfiguredProvider({
      providerName,
      role,
      topic,
      context,
      pmAnalysis
    });

    attempted.push({
      provider: providerName,
      status: attempt.result?.status || "failed",
      phase: "generator",
      note: attempt.result?.note || null,
      durationMs: attempt.metrics?.durationMs || null
    });

    if (attempt.ok) {
      generatorResult = attempt;
      generatorProvider = providerName;
      break;
    }
  }

  if (!generatorResult) {
    const lastMeaningful = [...attempted].reverse().find((item) => item.note);
    return {
      status: "dispatch_required",
      provider: "interview",
      generatedAt: nowIso(),
      content: {
        summary: `${role.name} expert hypothesis for '${topic}'`,
        assumptions: ["All generation providers failed."],
        recommendations: [`${role.name}: retry after fixing provider configuration.`],
        risks: [`${role.name}: no expert analysis available.`],
        nextActions: ["Inspect provider commands and runtime logs."]
      },
      prompt: buildCommonBrief({ role, topic, context, pmAnalysis }),
      note: lastMeaningful?.note || `All providers failed for role '${role.id}'.`,
      attemptedProviders: attempted,
      metrics: { durationMs: Date.now() - startedAt },
      interview: { generator: null, validator: null }
    };
  }

  const generatedOutput = generatorResult.result?.rawOutput || generatorResult.result?.content?.summary || "";

  // Phase 2: Validate — use the next available provider to review
  const validatorCandidates = pipeline.filter((p) => p !== generatorProvider && !["local-template", "local", "template"].includes(p));
  let validatorResult = null;
  let validatorProvider = null;

  for (const providerName of validatorCandidates) {
    const validationPrompt = buildValidationBrief({
      role,
      topic,
      context,
      generatedOutput,
      generatorProvider
    });

    const promptsDir = path.join(HUB_ROOT, ".state", "team-prompts");
    await ensureDir(promptsDir);
    const promptFile = path.join(promptsDir, `${Date.now()}-${role.id}-validation.md`);
    await fs.writeFile(promptFile, validationPrompt, "utf8");

    const command = renderTemplate(
      context.providers?.providerCommands?.[providerName] || "",
      {
        repo_path: context.repoPath || process.cwd(),
        role_id: role.id,
        role_name: role.name,
        topic,
        prompt_file: promptFile
      }
    );

    if (!command) {
      attempted.push({ provider: providerName, status: "skipped", phase: "validator", note: "No command configured", durationMs: 0 });
      continue;
    }

    const runtimeEnv = await buildProviderEnv(context);
    const cliEnv = { ...runtimeEnv };
    const envExclude = context.providers?.providerEnvExclude?.[providerName];
    if (Array.isArray(envExclude)) {
      for (const key of envExclude) {
        delete cliEnv[key];
      }
    }

    const idleTimeoutMs = Number(context.providers?.providerIdleTimeoutMs) || 30_000;
    const maxTimeoutMs = Number(context.providers?.providerMaxTimeoutMs) || 5 * 60 * 1000;
    const validationStartedAt = Date.now();
    const exec = await runCommand(command, context.repoPath || process.cwd(), maxTimeoutMs, cliEnv, { idleTimeoutMs });

    const validationDurationMs = Date.now() - validationStartedAt;
    await appendProviderTrace(`provider=${providerName} role=${role.id}-validation status=${exec.ok ? "ok" : "fail"} timed_out=${exec.timedOut} ms=${validationDurationMs} repo=${compactTraceText(context.repoPath || process.cwd())}`);

    attempted.push({
      provider: providerName,
      status: exec.ok ? "completed" : "failed",
      phase: "validator",
      note: exec.ok ? null : compactErrorMessage(exec.stderr),
      durationMs: validationDurationMs
    });

    if (exec.ok) {
      const plainOutput = extractStreamJsonText(exec.stdout);
      validatorResult = { rawOutput: plainOutput, durationMs: validationDurationMs };
      validatorProvider = providerName;
      break;
    }
  }

  // Build final output
  const finalOutput = validatorResult?.rawOutput || generatedOutput;
  const finalContent = summarizeProviderOutput(finalOutput, role.name);
  const finalEnvelope = normalizeToEnvelope(finalOutput, role.name);
  const interviewNote = validatorProvider
    ? `Interview: ${generatorProvider} generated, ${validatorProvider} validated.`
    : `Interview: ${generatorProvider} generated (validation skipped — no validator available).`;

  return {
    status: "completed",
    provider: "interview",
    generatedAt: nowIso(),
    content: finalContent,
    envelope: finalEnvelope,
    prompt: buildCommonBrief({ role, topic, context, pmAnalysis }),
    rawOutput: finalOutput,
    note: interviewNote,
    attemptedProviders: attempted,
    metrics: { durationMs: Date.now() - startedAt },
    interview: {
      generator: { provider: generatorProvider, durationMs: generatorResult.metrics?.durationMs, rawOutput: generatedOutput },
      validator: validatorProvider ? { provider: validatorProvider, durationMs: validatorResult.durationMs, rawOutput: validatorResult.rawOutput } : null
    }
  };
}

async function runConfiguredProvider({ role, topic, context, pmAnalysis }) {
  const startedAt = Date.now();
  const candidates = buildProviderCandidates({ role, context });
  const attempted = [];

  for (const providerName of candidates) {
    if (["local-template", "local", "template"].includes(providerName)) {
      attempted.push({
        provider: providerName,
        status: "skipped",
        note: "local-template fallback skipped for non-local role provider"
      });
      continue;
    }

    const attempt = await runSingleConfiguredProvider({
      providerName,
      role,
      topic,
      context,
      pmAnalysis
    });

    attempted.push({
      provider: providerName,
      status: attempt.result?.status || "failed",
      note: attempt.result?.note || null,
      durationMs: attempt.metrics?.durationMs || attempt.result?.metrics?.durationMs || null
    });

    if (attempt.ok) {
      return {
        ...attempt.result,
        attemptedProviders: attempted,
        metrics: {
          ...(attempt.result?.metrics || {}),
          totalDurationMs: Date.now() - startedAt
        }
      };
    }
  }

  const lastMeaningful = [...attempted].reverse().find((item) => item.status !== "skipped" && item.note);
  return {
    status: "dispatch_required",
    provider: lastMeaningful?.provider || role.provider,
    generatedAt: nowIso(),
    content: {
      summary: `${role.name} expert hypothesis for '${topic}'`,
      assumptions: [
        "No runtime traces were provided in the request.",
        "Current architecture details are inferred from available metadata."
      ],
      recommendations: [
        `${role.name}: validate one concrete technical approach before implementation.`,
        `${role.name}: produce a minimal spike or proof before large refactor.`
      ],
      risks: [
        `${role.name}: hidden coupling may increase regression risk.`,
        `${role.name}: unclear non-functional constraints (latency, scale, reliability).`
      ],
      nextActions: [
        `Dispatch this prompt to provider '${lastMeaningful?.provider || role.provider}' for deep expert validation.`
      ]
    },
    prompt: buildCommonBrief({ role, topic, context, pmAnalysis }),
    note: lastMeaningful?.note || `All providers failed for role '${role.id}'.`,
    attemptedProviders: attempted,
    metrics: {
      durationMs: Date.now() - startedAt
    }
  };
}

export async function runRoleContribution({ role, topic, context, pmAnalysis }) {
  if (["local-template", "local", "template"].includes(role.provider)) {
    return makeLocalResponse({ role, topic, context, pmAnalysis });
  }

  const pipeline = resolvePipelineProviders({ role, context });
  if (pipeline.length > 0) {
    return runCollaborativeProviders({ role, topic, context, pipeline, pmAnalysis });
  }

  return runConfiguredProvider({ role, topic, context, pmAnalysis });
}

export { normalizeToEnvelope };

export async function runExecutionCall({ providerName, prompt, context, extraEnv = {} }) {
  const startedAt = Date.now();
  const runtimeEnv = await buildProviderEnv(context);
  const execCommands = context.providers?.executionCommands || {};
  const fallbackCommands = context.providers?.providerCommands || {};
  const template = execCommands[providerName] || fallbackCommands[providerName];
  if (!template || typeof template !== "string") {
    return { ok: false, output: "", error: `No command configured for provider '${providerName}'.`, durationMs: 0, timedOut: false };
  }

  const promptsDir = path.join(HUB_ROOT, ".state", "team-prompts");
  await ensureDir(promptsDir);
  const promptFile = path.join(promptsDir, `${Date.now()}-execution.md`);
  await fs.writeFile(promptFile, prompt, "utf8");

  const command = renderTemplate(template, {
    repo_path: context.repoPath || process.cwd(),
    role_id: "tech-lead",
    role_name: "Tech Lead",
    topic: "execution",
    prompt_file: promptFile
  });

  const cliEnv = { ...runtimeEnv, ...extraEnv };
  const envExclude = context.providers?.providerEnvExclude?.[providerName];
  if (Array.isArray(envExclude)) {
    for (const key of envExclude) {
      delete cliEnv[key];
    }
  }

  const idleTimeoutMs = Number(context.providers?.executionIdleTimeoutMs) || 60_000;
  const maxTimeoutMs = Number(context.providers?.executionTimeoutMs) || 10 * 60 * 1000;
  const exec = await runCommand(command, context.repoPath || process.cwd(), maxTimeoutMs, cliEnv, { idleTimeoutMs });

  const output = extractStreamJsonText(exec.stdout);

  // When execution times out but produced meaningful output, treat as success.
  // Claude CLI may finish its work but hang before exiting cleanly, causing
  // the idle timer to kill the process. The work is done — report the output.
  const hasOutput = output && output.length > 50;
  const effectiveOk = exec.ok || (exec.timedOut && hasOutput);

  await appendProviderTrace(
    `provider=${providerName} role=execution status=${effectiveOk ? "ok" : "fail"} timed_out=${exec.timedOut} ms=${exec.durationMs} has_output=${hasOutput} repo=${compactTraceText(context.repoPath || process.cwd())}`
  );

  return {
    ok: effectiveOk,
    output,
    error: effectiveOk ? null : compactErrorMessage(exec.stderr || output),
    durationMs: Date.now() - startedAt,
    timedOut: exec.timedOut
  };
}

export async function runDirectProviderCall({ providerName, prompt, context }) {
  const startedAt = Date.now();
  const runtimeEnv = await buildProviderEnv(context);
  const commands = context.providers?.providerCommands || {};
  const template = commands[providerName];
  if (!template || typeof template !== "string") {
    return { ok: false, output: "", error: `No command configured for provider '${providerName}'.`, durationMs: 0 };
  }

  const promptsDir = path.join(HUB_ROOT, ".state", "team-prompts");
  await ensureDir(promptsDir);
  const promptFile = path.join(promptsDir, `${Date.now()}-smart-pm.md`);
  await fs.writeFile(promptFile, prompt, "utf8");

  const command = renderTemplate(template, {
    repo_path: context.repoPath || process.cwd(),
    role_id: "pm",
    role_name: "PM",
    topic: "smart-pm",
    prompt_file: promptFile
  });

  const cliEnv = { ...runtimeEnv };
  const envExclude = context.providers?.providerEnvExclude?.[providerName];
  if (Array.isArray(envExclude)) {
    for (const key of envExclude) {
      delete cliEnv[key];
    }
  }

  const idleTimeoutMs = Number(context.providers?.providerIdleTimeoutMs) || 30_000;
  const maxTimeoutMs = Number(context.providers?.providerMaxTimeoutMs) || 5 * 60 * 1000;
  const exec = await runCommand(command, context.repoPath || process.cwd(), maxTimeoutMs, cliEnv, { idleTimeoutMs });

  await appendProviderTrace(`provider=${providerName} role=smart-pm status=${exec.ok ? "ok" : "fail"} timed_out=${exec.timedOut} ms=${exec.durationMs} repo=${compactTraceText(context.repoPath || process.cwd())}`);

  return {
    ok: exec.ok,
    output: extractStreamJsonText(exec.stdout),
    error: exec.ok ? null : compactErrorMessage(exec.stderr),
    durationMs: Date.now() - startedAt,
    timedOut: exec.timedOut
  };
}
