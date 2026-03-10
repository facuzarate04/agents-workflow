import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadRun } from "../core/runs.mjs";
import { selectProfile } from "../core/profile.mjs";
import { handlePmMessage } from "./pm-agent.mjs";
import { runPreflightChecks, printPreflightResults } from "./preflight.mjs";
import { HUB_ROOT, readJsonFile, writeJsonFile } from "../core/utils.mjs";
import { resolveProjectContext } from "../core/projects.mjs";

const execFileAsync = promisify(execFile);
let slackEnvLoaded = false;
const SOCKET_TRACE_PATH = path.join(HUB_ROOT, ".state", "slack", "socket-trace.log");
const THREAD_STATE_PATH = path.join(HUB_ROOT, ".state", "slack", "threads.json");

async function checkActiveThread(threadKey) {
  const stateDoc = await readJsonFile(THREAD_STATE_PATH, { threads: {} });
  return Boolean(stateDoc?.threads?.[threadKey]);
}

function tryLoadEnvFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
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

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function loadSlackEnvIfNeeded() {
  if (slackEnvLoaded) {
    return;
  }

  const candidates = [
    process.env.SLACK_ENV_FILE,
    path.join(HUB_ROOT, "config", "slack", ".env"),
    path.join(HUB_ROOT, "slack", ".env"),
    path.join(process.cwd(), "slack", ".env")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (tryLoadEnvFile(candidate)) {
      break;
    }
  }

  slackEnvLoaded = true;
}

function requireEnv(name, optional = false) {
  const value = process.env[name];
  if (!value && !optional) {
    throw new Error(`missing env var: ${name}`);
  }
  return value || "";
}

function parseAllowedUsers(raw) {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getSlackConfig() {
  loadSlackEnvIfNeeded();
  return {
    botToken: requireEnv("SLACK_BOT_TOKEN", true),
    appToken: requireEnv("SLACK_APP_TOKEN", true),
    defaultChannel: requireEnv("SLACK_DEFAULT_CHANNEL", true),
    defaultRepo: requireEnv("SLACK_DEFAULT_REPO", true),
    repoMapPath: process.env.SLACK_REPO_MAP_PATH || path.join(HUB_ROOT, "config", "slack", "repo-map.json"),
    pmMode: (process.env.SLACK_PM_MODE || "true").toLowerCase() !== "false",
    allowedUsers: parseAllowedUsers(process.env.SLACK_ALLOWED_USERS || "")
  };
}

function requireBotToken(config) {
  if (!config.botToken) {
    throw new Error("missing env var: SLACK_BOT_TOKEN");
  }
}

async function loadRepoMap(repoMapPath) {
  const loaded = await readJsonFile(repoMapPath, { channels: {} });
  return loaded || { channels: {} };
}

async function resolveChannelConfig(channelId, config) {
  const repoMap = await loadRepoMap(config.repoMapPath);
  const entry = repoMap.channels?.[channelId];

  // Support both old format (string) and new format (object)
  if (typeof entry === "string") {
    return { repoPath: entry, profile: null, project: null };
  }

  if (entry && typeof entry === "object") {
    // Project-based channel mapping
    if (entry.project) {
      const projectCtx = await resolveProjectContext(entry.project);
      if (projectCtx) {
        return {
          repoPath: projectCtx.defaultRepoPath || config.defaultRepo || process.cwd(),
          profile: entry.profile || null,
          project: projectCtx
        };
      }
    }

    // Legacy single-repo mapping
    return { repoPath: entry.repoPath || config.defaultRepo || process.cwd(), profile: entry.profile || null, project: null };
  }

  return { repoPath: config.defaultRepo || process.cwd(), profile: null, project: null };
}

async function slackApi(method, payload, botToken) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(payload || {})
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`${method} failed: ${data.error || "unknown_error"}`);
  }

  return data;
}

async function slackApiWithConfig(method, payload = {}) {
  const config = getSlackConfig();
  requireBotToken(config);
  return slackApi(method, payload, config.botToken);
}

function truncateSlackText(text, max = 3500) {
  const safe = `${text || ""}`.trim();
  return safe.length > max ? `${safe.slice(0, max)}\n...` : safe;
}

function compactError(error) {
  const raw = `${error?.stack || error?.message || error || "unknown error"}`;
  const first = raw.split("\n").map((line) => line.trim()).find(Boolean) || "unknown error";
  return first.replace(/\/Users\/[^\s]+/g, "[path]");
}

function compactTraceText(text) {
  return `${text || ""}`.replace(/\s+/g, " ").replace(/\/Users\/[^\s]+/g, "[path]").trim();
}

function compactText(text, max = 140) {
  const safe = `${text || ""}`.replace(/\s+/g, " ").trim();
  if (!safe) return "";
  return safe.length > max ? `${safe.slice(0, max - 3)}...` : safe;
}

function appendSocketTrace(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.mkdirSync(path.dirname(SOCKET_TRACE_PATH), { recursive: true });
  fs.appendFileSync(SOCKET_TRACE_PATH, line, "utf8");
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderPmProgress(progress) {
  const lines = [
    "⏳ PM procesando consulta técnica...",
    `Pregunta: ${progress.question || "n/a"}`,
    `Progreso: ${progress.completed}/${progress.total || 0} roles`
  ];

  const entries = Object.values(progress.roles || {});
  if (entries.length > 0) {
    lines.push("");
    lines.push("Estado por rol:");
    for (const entry of entries) {
      const icon =
        entry.state === "completed" ? "✅"
          : entry.state === "failed" ? "❌"
            : entry.state === "running" ? "🔄"
              : "⏸️";
      const base = `${icon} ${entry.name}: ${entry.state || "pending"}`;
      const detail = `${entry.status ? ` | ${entry.status}` : ""}${Number.isFinite(entry.durationMs) ? ` | ${formatMs(entry.durationMs)}` : ""}`;
      lines.push(`- ${base}${detail}`);
    }
  }

  return lines.join("\n");
}

export async function listSlackChannels({ limit = 200, excludeArchived = true } = {}) {
  const payload = {
    limit,
    exclude_archived: excludeArchived,
    types: "public_channel,private_channel"
  };

  const data = await slackApiWithConfig("conversations.list", payload);
  return (data.channels || []).map((channel) => ({
    id: channel.id,
    name: channel.name,
    is_private: channel.is_private === true
  }));
}

export async function loadSlackRepoMap() {
  const config = getSlackConfig();
  return loadRepoMap(config.repoMapPath);
}

export async function saveSlackRepoMap(repoMap) {
  const config = getSlackConfig();
  const payload = {
    channels: {
      ...(repoMap?.channels || {})
    }
  };
  await writeJsonFile(config.repoMapPath, payload);
  return {
    repoMapPath: config.repoMapPath,
    repoMap: payload
  };
}

export async function setSlackRepoMapping({ channel, repoPath, profile = null, project = null }) {
  const current = await loadSlackRepoMap();
  let entry;
  if (project) {
    entry = { project };
    if (profile) entry.profile = profile;
  } else if (profile) {
    entry = { repoPath, profile };
  } else {
    entry = repoPath;
  }
  const next = {
    channels: {
      ...(current.channels || {}),
      [channel]: entry
    }
  };
  return saveSlackRepoMap(next);
}

export async function removeSlackRepoMapping({ channel }) {
  const current = await loadSlackRepoMap();
  const nextChannels = { ...(current.channels || {}) };
  delete nextChannels[channel];
  return saveSlackRepoMap({ channels: nextChannels });
}

export async function resolveSlackChannel(input) {
  if (!input) {
    throw new Error("channel input is required");
  }

  if (/^C[A-Z0-9]+$/i.test(input)) {
    return { id: input.toUpperCase(), name: null };
  }

  const normalized = input.replace(/^#/, "").toLowerCase();
  const channels = await listSlackChannels();
  const found = channels.find((channel) => channel.name.toLowerCase() === normalized);
  if (!found) {
    throw new Error(`channel not found by name: ${input}`);
  }

  return {
    id: found.id,
    name: found.name
  };
}

export async function postSlackMessage({ channel, text, threadTs = null }) {
  const config = getSlackConfig();
  requireBotToken(config);
  const targetChannel = channel || config.defaultChannel;
  if (!targetChannel) {
    throw new Error("missing Slack channel. Pass --channel or set SLACK_DEFAULT_CHANNEL");
  }

  const payload = {
    channel: targetChannel,
    text
  };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  return slackApi("chat.postMessage", payload, config.botToken);
}

export async function updateSlackMessage({ channel, ts, text }) {
  const config = getSlackConfig();
  requireBotToken(config);
  if (!channel || !ts) {
    throw new Error("updateSlackMessage requires channel and ts");
  }

  return slackApi("chat.update", { channel, ts, text }, config.botToken);
}

async function deleteSlackMessage({ channel, ts }) {
  const config = getSlackConfig();
  requireBotToken(config);
  if (!channel || !ts) return;
  try {
    await slackApi("chat.delete", { channel, ts }, config.botToken);
  } catch {
    // ignore — message may already be deleted or bot lacks permission
  }
}

export function formatRunSummary(run) {
  const lines = [
    `*Run:* ${run.runId}`,
    `*Status:* ${run.taskResult.status}`,
    `*Workflow:* ${run.taskResult.workflow}`,
    `*Profile:* ${run.taskResult.profile || "n/a"}`,
    `*Goal:* ${run.taskResult.goal}`
  ];

  const failedGates = (run.gateReport.gates || []).filter((gate) => gate.status === "failed");
  if (failedGates.length > 0) {
    lines.push(`*Failed gates:* ${failedGates.map((gate) => gate.id).join(", ")}`);
  }

  if (run.taskResult.lastPr?.url) {
    lines.push(`*PR:* ${run.taskResult.lastPr.url}`);
  }

  return lines.join("\n");
}

export async function notifyRunToSlack({ runId, channel, threadTs = null }) {
  const run = await loadRun(runId);
  const text = formatRunSummary(run);
  const response = await postSlackMessage({ channel, threadTs, text });

  return {
    runId,
    channel: response.channel,
    ts: response.ts,
    text
  };
}

async function openSocketUrl(appToken) {
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  const data = await response.json();
  if (!data.ok || !data.url) {
    throw new Error(`apps.connections.open failed: ${data.error || "unknown_error"}`);
  }

  return data.url;
}

function extractCommand(text) {
  if (!text) {
    return null;
  }

  const cleaned = text.replace(/<@[^>]+>/g, "").trim();
  if (!cleaned.toLowerCase().startsWith("hub ")) {
    return null;
  }

  return cleaned.slice(4).trim();
}

async function runHubCommand(commandText) {
  const args = commandText.split(/\s+/).filter(Boolean);
  const entry = new URL("../../bin/hub.mjs", import.meta.url);

  try {
    const { stdout, stderr } = await execFileAsync("node", [entry.pathname, ...args], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 20
    });

    const out = (stdout || stderr || "(sin salida)").trim();
    return {
      ok: true,
      output: out
    };
  } catch (error) {
    const out = (error.stdout || error.stderr || error.message || "(error sin salida)").trim();
    return {
      ok: false,
      output: out
    };
  }
}

function isUserAllowed(userId, allowedUsers) {
  if (!allowedUsers || allowedUsers.length === 0) {
    return true;
  }

  return allowedUsers.includes(userId);
}

async function handleSlackEvent(ev, config) {
  const threadTs = ev.thread_ts || ev.ts;
  appendSocketTrace(`event ${ev.type} channel=${ev.channel} thread=${threadTs} user=${ev.user}`);

  let statusMsg = null;
  let stageUpdateChain = Promise.resolve();

  try {
    if (!isUserAllowed(ev.user, config.allowedUsers)) {
      await postSlackMessage({
        channel: ev.channel,
        threadTs,
        text: "No autorizado para ejecutar comandos del hub."
      });
      appendSocketTrace(`blocked unauthorized user=${ev.user}`);
      return;
    }

    const command = extractCommand(ev.text);
    const threadKey = `${ev.channel}:${threadTs}`;

    if (config.pmMode) {
      // Status message = ephemeral progress indicator (edited, then deleted)
      statusMsg = await postSlackMessage({
        channel: ev.channel,
        threadTs,
        text: "🧠 Pensando..."
      });

      const channelConfig = await resolveChannelConfig(ev.channel, config);
      const resolvedRepo = channelConfig.repoPath;

      // Auto-select git profile for this channel (needed for run/pushpr commands)
      if (channelConfig.profile) {
        try {
          await selectProfile(channelConfig.profile);
        } catch (error) {
          appendSocketTrace(`profile_select_error profile=${channelConfig.profile} error="${compactError(error)}" thread=${threadKey}`);
        }
      }

      appendSocketTrace(`pm_mode repo=${compactTraceText(resolvedRepo)} profile=${channelConfig.profile || "none"} thread=${threadKey}`);

      // Progress state for expert consultations
      const progress = { question: "", total: 0, completed: 0, roles: {} };

      const queueStatusUpdate = (text) => {
        if (!statusMsg?.ts) return;
        stageUpdateChain = stageUpdateChain
          .then(() => updateSlackMessage({
            channel: ev.channel,
            ts: statusMsg.ts,
            text: truncateSlackText(text)
          }))
          .catch((error) => {
            appendSocketTrace(`progress_update_error thread=${threadKey} error="${compactError(error)}"`);
          });
      };

      const pm = await handlePmMessage({
        text: ev.text,
        threadKey,
        context: {
          defaultRepo: resolvedRepo,
          channel: ev.channel,
          profile: channelConfig.profile || null,
          project: channelConfig.project || null
        },
        runHubCommand,
        onStage: async (stage) => {
          if (!stage || typeof stage !== "object") return;

          if (stage.type === "pm_thinking") {
            queueStatusUpdate(`🧠 Analizando: ${stage.question || "..."}`);
            appendSocketTrace(`stage pm_thinking thread=${threadKey}`);
            return;
          }

          if (stage.type === "pm_provider_trying") {
            queueStatusUpdate(`🧠 Analizando con *${stage.provider}*...`);
            appendSocketTrace(`stage pm_provider_trying provider=${stage.provider} thread=${threadKey}`);
            return;
          }

          if (stage.type === "pm_provider_failed") {
            const duration = Number.isFinite(stage.durationMs) ? ` (${formatMs(stage.durationMs)})` : "";
            queueStatusUpdate(`⚠️ ${stage.provider} falló${duration}. Intentando siguiente...`);
            appendSocketTrace(`stage pm_provider_failed provider=${stage.provider} reason="${stage.reason}" ms=${stage.durationMs} thread=${threadKey}`);
            return;
          }

          if (stage.type === "pm_analysis") {
            appendSocketTrace(`stage pm_analysis ok=${stage.ok} ms=${stage.durationMs} consult=${(stage.consultRoles || []).join(",")} thread=${threadKey}`);
            return;
          }

          if (stage.type === "consult_started") {
            progress.question = stage.question || progress.question;
            progress.total = stage.totalRoles || progress.total;
            for (const role of stage.roles || []) {
              progress.roles[role.id] = { name: role.name, state: "pending", status: "" };
            }
            queueStatusUpdate(renderPmProgress(progress));
            appendSocketTrace(`stage consult_started roles=${progress.total} thread=${threadKey}`);
            return;
          }

          if (stage.type === "role_started") {
            const entry = progress.roles[stage.roleId] || { name: stage.roleName || stage.roleId, state: "pending", status: "" };
            entry.state = "running";
            entry.status = "";
            progress.roles[stage.roleId] = entry;
            queueStatusUpdate(renderPmProgress(progress));
            appendSocketTrace(`stage role_started role=${stage.roleId} thread=${threadKey}`);
            return;
          }

          if (stage.type === "role_completed") {
            const entry = progress.roles[stage.roleId] || { name: stage.roleName || stage.roleId, state: "pending", status: "" };
            entry.state = stage.status === "completed" ? "completed" : "failed";
            entry.status = compactText(stage.note || stage.status || "");
            entry.durationMs = stage.durationMs;
            progress.roles[stage.roleId] = entry;
            progress.completed = Object.values(progress.roles).filter((r) => r.state === "completed" || r.state === "failed").length;
            queueStatusUpdate(renderPmProgress(progress));
            appendSocketTrace(`stage role_completed role=${stage.roleId} status=${stage.status} ms=${stage.durationMs} note="${compactText(stage.note, 220)}" thread=${threadKey}`);
            return;
          }

          if (stage.type === "consult_completed") {
            progress.completed = progress.total || progress.completed;
            queueStatusUpdate(renderPmProgress(progress));
            appendSocketTrace(`stage consult_completed thread=${threadKey}`);
            return;
          }

          if (stage.type === "consult_heartbeat") {
            progress.elapsedMs = stage.elapsedMs;
            queueStatusUpdate(`${renderPmProgress(progress)}\n\nTiempo: ${formatMs(stage.elapsedMs)}`);
            appendSocketTrace(`stage consult_heartbeat elapsed_ms=${stage.elapsedMs} thread=${threadKey}`);
            return;
          }

          if (stage.type === "execute_started") {
            queueStatusUpdate(`🚀 Ejecutando: ${stage.goal || "..."}`);
            appendSocketTrace(`stage execute_started thread=${threadKey}`);
            return;
          }

          if (stage.type === "execute_heartbeat") {
            queueStatusUpdate(`🔨 Implementando... (${formatMs(stage.elapsedMs)})`);
            return;
          }

          if (stage.type === "execute_completed") {
            const icon = stage.ok ? "✅" : "❌";
            queueStatusUpdate(`${icon} Ejecucion ${stage.ok ? "completada" : "fallida"} (${formatMs(stage.durationMs)})`);
            appendSocketTrace(`stage execute_completed ok=${stage.ok} ms=${stage.durationMs} thread=${threadKey}`);
            return;
          }

          if (stage.type === "review_started") {
            queueStatusUpdate(`🔍 Ejecutando code review...`);
            return;
          }

          if (stage.type === "review_completed") {
            const icon = stage.passed ? "✅" : "⚠️";
            queueStatusUpdate(`${icon} Code review ${stage.passed ? "aprobado" : "con observaciones"} (${formatMs(stage.durationMs)})`);
            return;
          }

          if (stage.type === "createpr_started") {
            queueStatusUpdate(`📤 Creando PR para ${stage.branch || "..."}...`);
            return;
          }

          if (stage.type === "createpr_completed") {
            const icon = stage.ok ? "✅" : "❌";
            queueStatusUpdate(`${icon} PR ${stage.ok ? "creado" : "fallido"}${stage.url ? `: ${stage.url}` : ""}`);
            appendSocketTrace(`stage createpr_completed ok=${stage.ok} branch=${stage.branch} thread=${threadKey}`);
            return;
          }
        }
      });

      // Wait for any pending status updates to finish
      await stageUpdateChain;

      // Delete the ephemeral progress message
      await deleteSlackMessage({ channel: ev.channel, ts: statusMsg?.ts });

      // Post the final answer as a thread reply (the actual conversation)
      await postSlackMessage({
        channel: ev.channel,
        threadTs,
        text: truncateSlackText(pm.message)
      });

      appendSocketTrace(`pm_response ok=${pm.ok} thread=${threadKey}`);
      return;
    }

    // Non-PM mode: hub commands
    statusMsg = await postSlackMessage({
      channel: ev.channel,
      threadTs,
      text: "⏳ Ejecutando..."
    });

    if (!command) {
      await updateSlackMessage({
        channel: ev.channel,
        ts: statusMsg.ts,
        text: "Usa formato: `hub <comando>`"
      });
      appendSocketTrace(`missing_command thread=${threadKey}`);
      return;
    }

    const result = await runHubCommand(command);
    const output = `\`hub ${command}\`\n\n${result.ok ? "✅" : "❌"}\n\n\`\`\`\n${truncateSlackText(result.output, 3000)}\n\`\`\``;
    await updateSlackMessage({
      channel: ev.channel,
      ts: statusMsg.ts,
      text: output
    });
    appendSocketTrace(`hub_command ok=${result.ok} cmd="${command}" thread=${threadKey}`);
  } catch (error) {
    const summary = compactError(error);
    appendSocketTrace(`handler_error thread=${threadTs} error="${summary}"`);

    const errText = `❌ Error: ${summary}`;

    // Clean up progress message if it exists
    if (statusMsg?.ts) {
      await deleteSlackMessage({ channel: ev.channel, ts: statusMsg.ts });
    }

    // Post error as a thread reply
    await postSlackMessage({
      channel: ev.channel,
      threadTs,
      text: truncateSlackText(errText)
    });
  }
}

const DEDUP_TTL_MS = 60_000;
const processedEvents = new Map();

function isDuplicateEvent(eventKey) {
  const now = Date.now();
  // Prune expired entries periodically
  if (processedEvents.size > 200) {
    for (const [key, ts] of processedEvents) {
      if (now - ts > DEDUP_TTL_MS) processedEvents.delete(key);
    }
  }
  if (processedEvents.has(eventKey)) return true;
  processedEvents.set(eventKey, now);
  return false;
}

export async function startSlackSocketMode() {
  const config = getSlackConfig();
  requireBotToken(config);
  if (!config.appToken) {
    throw new Error("missing SLACK_APP_TOKEN for socket mode");
  }

  // --- Banner ---
  console.log("");
  console.log("\x1b[1mAgent Hub — Slack Socket Mode\x1b[0m");
  console.log(`PID: ${process.pid} | PM Mode: ${config.pmMode ? "on" : "off"} | Default repo: ${config.defaultRepo || "none"}`);

  // --- Pre-flight checks ---
  const preflightResults = await runPreflightChecks({
    repoMapPath: config.repoMapPath,
    defaultRepo: config.defaultRepo
  });
  printPreflightResults(preflightResults);

  // Get bot user ID to filter out our own messages
  const authInfo = await slackApi("auth.test", {}, config.botToken);
  const botUserId = authInfo.user_id;

  appendSocketTrace(
    `socket_boot pid=${process.pid} bot_user=${botUserId} cwd=${compactTraceText(process.cwd())} pm_mode=${config.pmMode} default_repo=${compactTraceText(config.defaultRepo || "")} repo_map=${compactTraceText(config.repoMapPath || "")} openai_key=${process.env.OPENAI_API_KEY ? "set" : "missing"}`
  );

  const socketUrl = await openSocketUrl(config.appToken);
  const ws = new WebSocket(socketUrl);

  ws.addEventListener("open", () => {
    console.log(`[slack] socket mode connected (bot=${botUserId})`);
    console.log("Listening for Slack events...");
    console.log("");
  });

  ws.addEventListener("message", async (event) => {
    let envelope = null;
    try {
      envelope = JSON.parse(event.data.toString());
    } catch {
      return;
    }

    if (envelope?.envelope_id) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    const payload = envelope?.payload;
    if (!payload || payload.type !== "event_callback") {
      return;
    }

    const ev = payload.event;
    if (!ev) {
      return;
    }

    // Deduplicate: Slack sends both app_mention and message events for the same
    // @mention in a thread. Use client_msg_id or channel:ts as unique key.
    const eventKey = ev.client_msg_id || `${ev.channel}:${ev.ts}`;
    if (isDuplicateEvent(eventKey)) {
      appendSocketTrace(`dedup_skip type=${ev.type} key=${eventKey} channel=${ev.channel}`);
      return;
    }

    // Handle @mentions (existing behavior — new conversations or explicit mentions)
    if (ev.type === "app_mention") {
      await handleSlackEvent(ev, config);
      return;
    }

    // Handle thread follow-ups (messages in threads where bot is already active)
    if (ev.type === "message") {
      // Skip bot's own messages
      if (ev.bot_id || ev.user === botUserId) return;
      // Skip subtypes (edits, joins, etc.)
      if (ev.subtype) return;
      // Only process messages in threads
      if (!ev.thread_ts) return;
      // Only respond in threads where the bot was previously engaged
      const threadKey = `${ev.channel}:${ev.thread_ts}`;
      const active = await checkActiveThread(threadKey);
      if (!active) return;

      appendSocketTrace(`thread_followup channel=${ev.channel} thread=${ev.thread_ts} user=${ev.user}`);
      await handleSlackEvent(ev, config);
    }
  });

  ws.addEventListener("close", () => {
    console.log("[slack] socket mode disconnected");
  });

  ws.addEventListener("error", (error) => {
    console.error(`[slack] socket error: ${error.message || error}`);
  });

  return ws;
}
