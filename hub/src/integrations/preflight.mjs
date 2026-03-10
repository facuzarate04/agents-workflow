import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadTeamConfig } from "../team/config.mjs";
import { listAllowedProfiles, resolveProfileToken } from "../core/profile.mjs";

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 15_000;

function ok(label, detail) {
  return { status: "ok", label, detail };
}
function warn(label, detail) {
  return { status: "warn", label, detail };
}
function fail(label, detail) {
  return { status: "fail", label, detail };
}

async function quickExec(command, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: opts.env || process.env,
      cwd: opts.cwd || process.cwd()
    });
    return { ok: true, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error.stderr?.trim() || error.message };
  }
}

async function checkClaudeCli(providerCommands) {
  const template = providerCommands?.["claude-teams"] || "";
  const cliMatch = template.match(/\/cli\.js/);
  if (!cliMatch) {
    return warn("Claude CLI", "no claude-teams command configured");
  }

  const cliPathMatch = template.match(/(\/\S+cli\.js)/);
  const cliPath = cliPathMatch ? cliPathMatch[1] : null;
  if (!cliPath) {
    return warn("Claude CLI", "could not extract CLI path from command");
  }

  const nodeMatch = template.match(/(\/\S+\/bin\/node)/);
  const nodePath = nodeMatch ? nodeMatch[1] : "node";

  const res = await quickExec(nodePath, [cliPath, "--version"]);
  if (!res.ok) {
    return fail("Claude CLI", `not reachable: ${res.stderr}`);
  }

  return ok("Claude CLI", `v${res.stdout.replace(/^claude-code\s*/i, "").trim()} (app auth)`);
}

async function checkCodexCli(providerCommands) {
  const template = providerCommands?.codex || "";
  const codexMatch = template.match(/(\/\S+\/codex)/);
  const codexPath = codexMatch ? codexMatch[1] : "codex";

  const res = await quickExec(codexPath, ["--version"]);
  if (!res.ok) {
    return fail("Codex CLI", `not reachable: ${res.stderr}`);
  }

  return ok("Codex CLI", `v${res.stdout.trim()}`);
}

async function checkGhCli() {
  const res = await quickExec("gh", ["--version"]);
  if (!res.ok) {
    return fail("gh CLI", "not installed");
  }

  const version = res.stdout.split("\n")[0] || res.stdout;
  return ok("gh CLI", version.replace(/^gh\s+version\s*/i, "v").trim());
}

async function checkGitSwitch(profile, account) {
  const res = await quickExec("zsh", ["-lic", `git-switch ${profile}`]);
  if (!res.ok) {
    return warn(`git-switch ${profile}`, res.stderr);
  }
  return ok(`git-switch ${profile}`, `${account}`);
}

async function checkGhToken(profile, account) {
  const token = await resolveProfileToken(profile);
  if (!token) {
    return warn(`GH_TOKEN (${profile})`, "not set");
  }

  const res = await quickExec("gh", ["api", "user", "--jq", ".login"], {
    env: { ...process.env, GH_TOKEN: token }
  });

  if (!res.ok) {
    return warn(`GH_TOKEN (${profile})`, `set but invalid: ${res.stderr.slice(0, 80)}`);
  }

  const login = res.stdout.trim();
  if (login.toLowerCase() !== account.toLowerCase()) {
    return warn(`GH_TOKEN (${profile})`, `authenticated as '${login}', expected '${account}'`);
  }

  return ok(`GH_TOKEN (${profile})`, `authenticated as ${login}`);
}

async function checkRepoPath(channelId, repoPath) {
  const label = `Repo ${channelId}`;
  try {
    const stat = await fs.stat(repoPath);
    if (!stat.isDirectory()) {
      return fail(label, `not a directory: ${repoPath}`);
    }

    const gitStat = await fs.stat(`${repoPath}/.git`).catch(() => null);
    if (!gitStat) {
      return warn(label, `no .git: ${repoPath}`);
    }

    return ok(label, repoPath);
  } catch {
    return fail(label, `path not found: ${repoPath}`);
  }
}

export async function runPreflightChecks({ repoMapPath, defaultRepo }) {
  const results = [];

  // Load team config for provider commands
  const repoPath = defaultRepo || process.cwd();
  let providers = {};
  try {
    const loaded = await loadTeamConfig(repoPath);
    providers = loaded.config?.providers || {};
  } catch {
    results.push(warn("Team config", "could not load team.json"));
  }

  // Provider checks (parallel)
  const [claude, codex, gh] = await Promise.all([
    checkClaudeCli(providers.providerCommands),
    checkCodexCli(providers.providerCommands),
    checkGhCli()
  ]);
  results.push(claude, codex, gh);

  // Profile and token checks (sequential — git-switch changes global state)
  const profiles = await listAllowedProfiles();
  for (const { profile, account } of profiles) {
    results.push(await checkGitSwitch(profile, account));
    results.push(await checkGhToken(profile, account));
  }

  // Repo-map checks (parallel)
  try {
    const { readJsonFile } = await import("../core/utils.mjs");
    const repoMap = await readJsonFile(repoMapPath, { channels: {} });
    const channels = repoMap?.channels || {};
    const repoChecks = Object.entries(channels).map(([channelId, entry]) => {
      const rp = typeof entry === "string" ? entry : entry?.repoPath;
      return rp ? checkRepoPath(channelId, rp) : Promise.resolve(warn(`Repo ${channelId}`, "no repoPath"));
    });
    results.push(...await Promise.all(repoChecks));
  } catch {
    results.push(warn("Repo map", "could not load repo-map.json"));
  }

  return results;
}

export function printPreflightResults(results) {
  const icons = { ok: "\x1b[32m[ok]\x1b[0m", warn: "\x1b[33m[!!]\x1b[0m", fail: "\x1b[31m[!!]\x1b[0m" };

  console.log("");
  console.log("Pre-flight checks:");
  for (const r of results) {
    const icon = icons[r.status] || "[??]";
    console.log(`  ${icon} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
  }

  const warns = results.filter((r) => r.status === "warn").length;
  const fails = results.filter((r) => r.status === "fail").length;
  if (warns > 0 || fails > 0) {
    console.log("");
    console.log(`  ${fails > 0 ? "\x1b[31m" : "\x1b[33m"}${fails} failed, ${warns} warnings\x1b[0m`);
  } else {
    console.log("");
    console.log("  \x1b[32mAll checks passed\x1b[0m");
  }
  console.log("");
}
