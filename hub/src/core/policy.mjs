import path from "node:path";
import { HUB_ROOT, mergeUnique, pickFirstNonEmpty, readJsonFile } from "./utils.mjs";

const GLOBAL_POLICY_PATH = path.join(HUB_ROOT, "config", "global-policy.json");
const GLOBAL_MCP_REGISTRY_PATH = path.join(HUB_ROOT, "config", "mcp-registry.json");

function mergeRuleSets(globalRules = {}, repoRules = {}, moduleRules = {}) {
  return {
    requiredChecks: mergeUnique(
      globalRules.requiredChecks,
      mergeUnique(repoRules.requiredChecks, moduleRules.requiredChecks)
    ),
    forbiddenPatterns: mergeUnique(
      globalRules.forbiddenPatterns,
      mergeUnique(repoRules.forbiddenPatterns, moduleRules.forbiddenPatterns)
    ),
    requiredArtifacts: mergeUnique(
      globalRules.requiredArtifacts,
      mergeUnique(repoRules.requiredArtifacts, moduleRules.requiredArtifacts)
    ),
    codeOwners: mergeUnique(
      globalRules.codeOwners,
      mergeUnique(repoRules.codeOwners, moduleRules.codeOwners)
    ),
    notes: mergeUnique(globalRules.notes, mergeUnique(repoRules.notes, moduleRules.notes))
  };
}

function normalizeMcpEntries(entries = []) {
  return entries
    .filter((entry) => entry && entry.name)
    .map((entry) => ({
      name: entry.name,
      type: entry.type || "http",
      scope: entry.scope || "global",
      trust: entry.trust || "review-required",
      description: entry.description || "",
      endpoint: entry.endpoint || null,
      commands: entry.commands || []
    }));
}

function mergeMcpRegistry(globalMcp = [], repoMcp = []) {
  const merged = new Map();

  for (const entry of [...globalMcp, ...repoMcp]) {
    const existing = merged.get(entry.name);
    if (!existing) {
      merged.set(entry.name, entry);
      continue;
    }

    merged.set(entry.name, {
      ...existing,
      ...entry,
      commands: mergeUnique(existing.commands, entry.commands),
      trust: pickFirstNonEmpty(entry.trust, existing.trust) || "review-required",
      scope: pickFirstNonEmpty(entry.scope, existing.scope) || "global"
    });
  }

  return [...merged.values()];
}

export async function loadPolicyContext(repoPath) {
  const globalPolicy = (await readJsonFile(GLOBAL_POLICY_PATH, {})) || {};
  const repoPolicyPath = repoPath
    ? path.join(repoPath, ".agent-hub", "repo-profile.json")
    : null;
  const repoPolicy = repoPolicyPath ? (await readJsonFile(repoPolicyPath, {})) || {} : {};

  const moduleProfiles = repoPolicy.moduleProfiles || {};
  const mergedRules = mergeRuleSets(globalPolicy.rules, repoPolicy.rules, {});

  const contextPack = {
    global: globalPolicy,
    repo: repoPolicy,
    moduleProfiles,
    mergedRules
  };

  return contextPack;
}

export async function loadMcpContext(repoPath) {
  const globalRegistry = await readJsonFile(GLOBAL_MCP_REGISTRY_PATH, { mcps: [] });
  const repoRegistryPath = repoPath
    ? path.join(repoPath, ".agent-hub", "mcp-registry.json")
    : null;
  const repoRegistry = repoRegistryPath
    ? await readJsonFile(repoRegistryPath, { mcps: [] })
    : { mcps: [] };

  const merged = mergeMcpRegistry(
    normalizeMcpEntries(globalRegistry.mcps),
    normalizeMcpEntries(repoRegistry.mcps)
  );

  const grouped = {
    trusted: merged.filter((entry) => entry.trust === "trusted"),
    reviewRequired: merged.filter((entry) => entry.trust === "review-required"),
    blocked: merged.filter((entry) => entry.trust === "blocked")
  };

  return {
    globalRegistryPath: GLOBAL_MCP_REGISTRY_PATH,
    repoRegistryPath,
    merged,
    grouped
  };
}
