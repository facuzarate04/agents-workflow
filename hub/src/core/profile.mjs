import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HUB_ROOT, nowIso, readJsonFile, writeJsonFile } from "./utils.mjs";

const execFileAsync = promisify(execFile);
const PROFILE_STATE_PATH = path.join(HUB_ROOT, ".state", "profile.json");
const PROFILES_CONFIG_PATH = path.join(HUB_ROOT, "config", "profiles.json");

let _cachedProfiles = null;

async function loadProfiles() {
  if (_cachedProfiles) return _cachedProfiles;

  const data = await readJsonFile(PROFILES_CONFIG_PATH, null);
  if (!data?.profiles || Object.keys(data.profiles).length === 0) {
    throw new Error(
      `No profiles configured. Copy config/profiles.example.json to config/profiles.json and add your GitHub accounts.`
    );
  }

  _cachedProfiles = data.profiles;
  return _cachedProfiles;
}

export function resetProfileCache() {
  _cachedProfiles = null;
}

export async function listAllowedProfiles() {
  const profiles = await loadProfiles();
  return Object.entries(profiles).map(([profile, { account }]) => ({ profile, account }));
}

export async function resolveProfileToken(profile) {
  const profiles = await loadProfiles();
  const entry = profiles[(profile || "").trim().toLowerCase()];
  if (!entry) return null;
  const token = process.env[entry.tokenEnv];
  return token || null;
}

export async function getProfileState() {
  return (await readJsonFile(PROFILE_STATE_PATH, null)) || null;
}

export async function requireSelectedProfile() {
  const state = await getProfileState();
  if (!state?.profile) {
    const profiles = await listAllowedProfiles();
    const names = profiles.map((p) => p.profile).join("|");
    throw new Error(`no git profile selected. Run: hub profile select ${names}`);
  }

  return state;
}

export async function selectProfile(profile) {
  const profiles = await loadProfiles();
  const normalized = (profile || "").trim().toLowerCase();
  if (!(normalized in profiles)) {
    const allowed = Object.keys(profiles).join(", ");
    throw new Error(`invalid profile. Allowed: ${allowed}`);
  }

  const account = profiles[normalized].account;

  try {
    await execFileAsync("zsh", ["-lic", `git-switch ${normalized}`], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 60 * 1000,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    const stderr = error.stderr?.trim() || error.message;
    throw new Error(`git-switch failed for profile '${normalized}': ${stderr}`);
  }

  const state = {
    profile: normalized,
    account,
    switchedAt: nowIso()
  };

  await writeJsonFile(PROFILE_STATE_PATH, state);
  return state;
}
