import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGh(args, cwd, ghToken) {
  const env = ghToken ? { ...process.env, GH_TOKEN: ghToken } : process.env;
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      cwd,
      env,
      timeout: 2 * 60 * 1000,
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

export async function ensureGhAvailable(cwd, ghToken) {
  const res = await runGh(["--version"], cwd, ghToken);
  return {
    ok: res.ok,
    error: res.ok ? "" : res.stderr || "gh CLI is not available"
  };
}

export async function createPullRequest({ cwd, base, head, title, body, ghToken }) {
  const args = [
    "pr",
    "create",
    "--base",
    base,
    "--head",
    head,
    "--title",
    title,
    "--body",
    body
  ];

  const res = await runGh(args, cwd, ghToken);
  if (!res.ok) {
    return {
      ok: false,
      error: res.stderr || "gh pr create failed"
    };
  }

  const url = res.stdout.split("\n").map((line) => line.trim()).filter(Boolean).find((line) => line.startsWith("http")) || null;
  return {
    ok: true,
    url,
    raw: res.stdout
  };
}
