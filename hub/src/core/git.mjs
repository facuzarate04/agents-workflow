import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HUB_ROOT, nowIso } from "./utils.mjs";

const execFileAsync = promisify(execFile);

function toSlug(input) {
  return input.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runGit(repoPath, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: process.env,
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

export async function runGitInCwd(cwd, args) {
  return runGit(cwd, args);
}

async function resolveBaseRef(repoPath, preferredRef) {
  if (preferredRef) {
    return preferredRef;
  }

  const current = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.ok && current.stdout && current.stdout !== "HEAD") {
    return current.stdout;
  }

  const fallback = await runGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (fallback.ok && fallback.stdout.includes("/")) {
    return fallback.stdout.split("/").pop();
  }

  return "main";
}

export function buildWorktreeContext(repoPath, runId, branchHint = null) {
  const repoSlug = toSlug(repoPath);
  const worktreePath = path.join(HUB_ROOT, ".state", "worktrees", repoSlug, runId);
  const branch = branchHint || `codex/run-${runId}`;

  return {
    branch,
    worktreePath
  };
}

export async function ensureWorktreeForRun({ repoPath, runId, branchHint = null, baseRefHint = null }) {
  const ctx = buildWorktreeContext(repoPath, runId, branchHint);
  const baseRef = await resolveBaseRef(repoPath, baseRefHint);

  await fs.mkdir(path.dirname(ctx.worktreePath), { recursive: true });

  const existing = await pathExists(ctx.worktreePath);
  if (!existing) {
    let selectedBranch = ctx.branch;
    let addResult = await runGit(repoPath, [
      "worktree",
      "add",
      "-b",
      selectedBranch,
      ctx.worktreePath,
      baseRef
    ]);

    // Fallback when 'codex' branch name blocks refs/heads/codex/* namespace.
    if (
      !addResult.ok &&
      selectedBranch.startsWith("codex/") &&
      addResult.stderr.includes("cannot lock ref")
    ) {
      selectedBranch = `codex-run-${runId}`;
      addResult = await runGit(repoPath, [
        "worktree",
        "add",
        "-b",
        selectedBranch,
        ctx.worktreePath,
        baseRef
      ]);
    }

    if (!addResult.ok) {
      return {
        ok: false,
        error: addResult.stderr || "failed to create git worktree",
        context: {
          ...ctx,
          branch: selectedBranch,
          baseRef
        }
      };
    }

    ctx.branch = selectedBranch;
  }

  return {
    ok: true,
    context: {
      ...ctx,
      baseRef,
      createdAt: nowIso()
    }
  };
}

export async function cleanupWorktreeForRun({ repoPath, worktreePath, branch, removeBranch = false }) {
  const removeWorktree = await runGit(repoPath, ["worktree", "remove", "--force", worktreePath]);
  if (!removeWorktree.ok) {
    return {
      ok: false,
      error: removeWorktree.stderr || "failed to remove worktree"
    };
  }

  if (removeBranch && branch) {
    const deleteBranch = await runGit(repoPath, ["branch", "-D", branch]);
    if (!deleteBranch.ok) {
      return {
        ok: false,
        error: deleteBranch.stderr || "failed to delete branch"
      };
    }
  }

  return { ok: true };
}

export async function inspectWorktreeChanges(worktreePath) {
  const status = await runGitInCwd(worktreePath, ["status", "--porcelain"]);
  if (!status.ok) {
    return {
      ok: false,
      error: status.stderr || "could not inspect worktree status"
    };
  }

  const changedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim());

  const diff = await runGitInCwd(worktreePath, ["diff", "--patch", "HEAD"]);
  return {
    ok: true,
    changedFiles,
    diff: diff.ok ? diff.stdout : "",
    diffError: diff.ok ? "" : diff.stderr || ""
  };
}

export async function commitWorktreeChanges(worktreePath, message) {
  const add = await runGitInCwd(worktreePath, ["add", "-A"]);
  if (!add.ok) {
    return {
      ok: false,
      error: add.stderr || "failed to stage changes"
    };
  }

  const commit = await runGitInCwd(worktreePath, ["commit", "-m", message]);
  if (!commit.ok) {
    return {
      ok: false,
      error: commit.stderr || "failed to commit changes"
    };
  }

  const sha = await runGitInCwd(worktreePath, ["rev-parse", "HEAD"]);
  return {
    ok: true,
    commitSha: sha.ok ? sha.stdout : null,
    stdout: commit.stdout
  };
}

export async function pushWorktreeBranch(worktreePath, branch) {
  const push = await runGitInCwd(worktreePath, ["push", "-u", "origin", branch]);
  if (!push.ok) {
    return {
      ok: false,
      error: push.stderr || "failed to push branch to origin"
    };
  }

  return {
    ok: true,
    stdout: push.stdout
  };
}
