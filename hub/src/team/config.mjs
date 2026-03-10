import path from "node:path";
import { HUB_ROOT, readJsonFile, writeJsonFile } from "../core/utils.mjs";

const DEFAULT_TEAM_CONFIG_PATH = path.join(HUB_ROOT, "config", "team.default.json");
const GLOBAL_TEAM_CONFIG_PATH = path.join(HUB_ROOT, ".agent-hub", "team.json");

function normalizeRoles(roles = []) {
  return roles
    .filter((role) => role && role.id && role.name)
    .map((role) => ({
      id: role.id,
      name: role.name,
      persona: role.persona || "",
      responsibilities: role.responsibilities || [],
      deliverables: role.deliverables || [],
      provider: role.provider || "local-template",
      expertise: role.expertise || []
    }));
}

function mergeRoles(baseRoles = [], overrideRoles = []) {
  const map = new Map();

  for (const role of baseRoles) {
    map.set(role.id, role);
  }

  for (const role of overrideRoles) {
    const existing = map.get(role.id) || {};
    map.set(role.id, {
      ...existing,
      ...role,
      responsibilities: role.responsibilities || existing.responsibilities || [],
      deliverables: role.deliverables || existing.deliverables || [],
      expertise: role.expertise || existing.expertise || []
    });
  }

  return [...map.values()];
}

function sortRoles(roles) {
  return [...roles].sort((a, b) => a.id.localeCompare(b.id));
}

function deepMergeProviders(...sources) {
  const result = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
        result[key] = deepMergeProviders(result[key], value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

export async function loadTeamConfig(repoPath = null) {
  const defaults = (await readJsonFile(DEFAULT_TEAM_CONFIG_PATH, {})) || {};
  const globalConfig = (await readJsonFile(GLOBAL_TEAM_CONFIG_PATH, {})) || {};
  const repoPathConfig = repoPath ? path.join(repoPath, ".agent-hub", "team.json") : null;
  const repoConfig = repoPathConfig ? (await readJsonFile(repoPathConfig, {})) || {} : {};

  const defaultRoles = normalizeRoles(defaults.roles || []);
  const globalRoles = normalizeRoles(globalConfig.roles || []);
  const repoRoles = normalizeRoles(repoConfig.roles || []);

  const merged = {
    version: repoConfig.version || globalConfig.version || defaults.version || "1.0",
    name: repoConfig.name || globalConfig.name || defaults.name || "team",
    providers: deepMergeProviders(
      defaults.providers || {},
      globalConfig.providers || {},
      repoConfig.providers || {}
    ),
    gates: deepMergeProviders(
      defaults.gates || {},
      globalConfig.gates || {},
      repoConfig.gates || {}
    ),
    roles: sortRoles(mergeRoles(mergeRoles(defaultRoles, globalRoles), repoRoles))
  };

  return {
    config: merged,
    defaultConfigPath: DEFAULT_TEAM_CONFIG_PATH,
    globalConfigPath: GLOBAL_TEAM_CONFIG_PATH,
    repoConfigPath: repoPathConfig
  };
}

export async function scaffoldRoleInRepo({ repoPath, role }) {
  if (!repoPath) {
    throw new Error("repoPath is required to scaffold a role");
  }

  const repoConfigPath = path.join(repoPath, ".agent-hub", "team.json");
  const current = (await readJsonFile(repoConfigPath, null)) || {
    version: "1.0",
    name: "repo-team",
    providers: {},
    roles: []
  };

  const roles = normalizeRoles(current.roles || []);
  const existingIndex = roles.findIndex((entry) => entry.id === role.id);

  if (existingIndex >= 0) {
    roles[existingIndex] = {
      ...roles[existingIndex],
      ...role,
      responsibilities: role.responsibilities || roles[existingIndex].responsibilities,
      deliverables: role.deliverables || roles[existingIndex].deliverables
    };
  } else {
    roles.push({
      id: role.id,
      name: role.name,
      persona: role.persona || "",
      responsibilities: role.responsibilities || [],
      deliverables: role.deliverables || [],
      provider: role.provider || "local-template",
      expertise: role.expertise || []
    });
  }

  const updated = {
    ...current,
    roles: sortRoles(roles)
  };

  await writeJsonFile(repoConfigPath, updated);
  return {
    repoConfigPath,
    role: updated.roles.find((entry) => entry.id === role.id)
  };
}
