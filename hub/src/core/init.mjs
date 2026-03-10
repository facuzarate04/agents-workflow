import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HUB_ROOT, ensureDir, readJsonFile, writeJsonFile } from "./utils.mjs";

const execFileAsync = promisify(execFile);

const CONFIG_DIR = path.join(HUB_ROOT, "config");
const TEAM_DIR = path.join(HUB_ROOT, ".agent-hub");
const SLACK_DIR = path.join(CONFIG_DIR, "slack");

const FILES = {
  profiles: path.join(CONFIG_DIR, "profiles.json"),
  projects: path.join(CONFIG_DIR, "projects.json"),
  team: path.join(TEAM_DIR, "team.json"),
  slackEnv: path.join(SLACK_DIR, ".env"),
  repoMap: path.join(SLACK_DIR, "repo-map.json")
};

/**
 * Interactive setup wizard for first-time configuration.
 */
export async function runInit() {
  const rl = readline.createInterface({ input, output });

  console.log(`
┌─────────────────────────────────────┐
│      Agent Hub - Setup Wizard       │
└─────────────────────────────────────┘
`);

  // Check if already configured
  const existingProfiles = await readJsonFile(FILES.profiles, null);
  if (existingProfiles) {
    const overwrite = await ask(rl, "Config files already exist. Overwrite? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Setup cancelled.");
      rl.close();
      return;
    }
  }

  // --- Step 1: Detect CLI tools ---
  console.log("Detecting installed tools...\n");
  const detected = await detectTools();

  for (const [tool, info] of Object.entries(detected)) {
    const icon = info.available ? "✓" : "✗";
    const version = info.version ? ` (${info.version})` : "";
    console.log(`  ${icon} ${tool}${version}${info.available ? "" : " - not found"}`);
  }
  console.log();

  const hasAnyProvider = detected.claude.available || detected.codex.available;
  if (!hasAnyProvider) {
    console.log("Warning: No AI provider CLI found. Install claude or codex to use the hub.\n");
  }

  // --- Step 2: GitHub profile ---
  console.log("── GitHub Profile ──\n");

  const ghAccount = await ask(rl, "GitHub username or org: ");
  const ghTokenEnv = await ask(rl, "GitHub token env var name (default: GITHUB_TOKEN): ", "GITHUB_TOKEN");

  const wantSecondProfile = await ask(rl, "Add a second profile (e.g. personal)? (y/N): ");
  let secondProfile = null;
  if (wantSecondProfile.toLowerCase() === "y") {
    const account2 = await ask(rl, "Second profile GitHub username: ");
    const tokenEnv2 = await ask(rl, "Second profile token env var (default: GH_TOKEN_PERSONAL): ", "GH_TOKEN_PERSONAL");
    secondProfile = { account: account2, tokenEnv: tokenEnv2 };
  }

  // --- Step 3: Provider preference ---
  console.log("\n── Provider Setup ──\n");

  let primaryProvider = "claude-teams";
  let executionProvider = "claude-teams";

  if (detected.claude.available && detected.codex.available) {
    const providerChoice = await ask(rl, "Primary provider - (1) claude  (2) codex  (3) both [default: 3]: ", "3");
    if (providerChoice === "1") {
      primaryProvider = "claude-teams";
      executionProvider = "claude-teams";
    } else if (providerChoice === "2") {
      primaryProvider = "codex";
      executionProvider = "codex";
    }
    // "3" or default keeps both with claude as primary
  } else if (detected.codex.available) {
    primaryProvider = "codex";
    executionProvider = "codex";
  }
  // If only claude or neither, keep defaults

  // --- Step 4: Code review gate ---
  console.log("\n── Code Review Gate ──\n");
  const enableReview = await ask(rl, "Enable post-execution code review? (y/N): ");
  const reviewEnabled = enableReview.toLowerCase() === "y";

  // --- Step 5: Slack (optional) ---
  console.log("\n── Slack Integration (optional) ──\n");
  const wantSlack = await ask(rl, "Configure Slack integration? (y/N): ");
  let slackConfig = null;

  if (wantSlack.toLowerCase() === "y") {
    const botToken = await ask(rl, "Slack Bot Token: ");
    const appToken = await ask(rl, "Slack App Token: ");
    const defaultChannel = await ask(rl, "Default channel ID (optional): ", "");
    slackConfig = { botToken, appToken, defaultChannel };
  }

  // --- Step 6: First project (optional) ---
  console.log("\n── First Project (optional) ──\n");
  const wantProject = await ask(rl, "Add a project now? (y/N): ");
  let projectConfig = null;

  if (wantProject.toLowerCase() === "y") {
    const projectName = await ask(rl, "Project name: ");
    const repoPath = await ask(rl, "Repository path: ");
    const repoType = await ask(rl, "Type (e.g. nextjs, laravel, node): ", "node");
    projectConfig = { name: projectName, path: repoPath, type: repoType };
  }

  rl.close();

  // --- Generate config files ---
  console.log("\n── Generating config files ──\n");

  await ensureDir(CONFIG_DIR);
  await ensureDir(TEAM_DIR);
  await ensureDir(SLACK_DIR);

  // profiles.json
  const profiles = {
    profiles: {
      work: { account: ghAccount, tokenEnv: ghTokenEnv }
    }
  };
  if (secondProfile) {
    profiles.profiles.personal = secondProfile;
  }
  await writeJsonFile(FILES.profiles, profiles);
  console.log("  ✓ config/profiles.json");

  // team.json
  const teamConfig = buildTeamConfig({
    primaryProvider,
    executionProvider,
    detected,
    reviewEnabled,
    hasBothProviders: detected.claude.available && detected.codex.available
  });
  await writeJsonFile(FILES.team, teamConfig);
  console.log("  ✓ .agent-hub/team.json");

  // projects.json
  const projects = { projects: {} };
  if (projectConfig) {
    projects.projects[projectConfig.name] = {
      repos: {
        main: {
          path: projectConfig.path,
          type: projectConfig.type,
          description: `${projectConfig.name} repository`
        }
      },
      defaultRepo: "main"
    };
  }
  await writeJsonFile(FILES.projects, projects);
  console.log("  ✓ config/projects.json");

  // slack/.env
  if (slackConfig) {
    const envContent = [
      `SLACK_BOT_TOKEN=${slackConfig.botToken}`,
      `SLACK_APP_TOKEN=${slackConfig.appToken}`,
      `SLACK_DEFAULT_CHANNEL=${slackConfig.defaultChannel}`,
      `SLACK_DEFAULT_REPO=`,
      `SLACK_PM_MODE=true`,
      `SLACK_ALLOWED_USERS=`,
      `OPENAI_API_KEY=`,
      `ANTHROPIC_API_KEY=`
    ].join("\n") + "\n";
    await fs.writeFile(FILES.slackEnv, envContent, "utf8");
    console.log("  ✓ config/slack/.env");
  }

  // repo-map.json
  const repoMap = { channels: {} };
  await writeJsonFile(FILES.repoMap, repoMap);
  console.log("  ✓ config/slack/repo-map.json");

  // --- Summary ---
  const profileNames = Object.keys(profiles.profiles);

  console.log(`
┌─────────────────────────────────────┐
│          Setup Complete!            │
└─────────────────────────────────────┘

Profiles: ${profileNames.join(", ")}
Provider: ${primaryProvider}${detected.claude.available && detected.codex.available ? " (both available)" : ""}
Review gate: ${reviewEnabled ? "enabled" : "disabled"}
Slack: ${slackConfig ? "configured" : "skipped"}

Next steps:

  1. Select your profile:
     node bin/hub.mjs profile select ${profileNames[0]}

  2. Start using the hub:
     node bin/hub.mjs chat --repo /path/to/repo
     node bin/hub.mjs run --repo /path/to/repo "your request"
${slackConfig ? `
  3. Start Slack bot:
     node bin/hub.mjs slack socket
` : ""}
Config files are in hub/config/ and hub/.agent-hub/ (gitignored).
`);
}

// --- Helpers ---

async function ask(rl, question, defaultValue = "") {
  const answer = await rl.question(question);
  return answer.trim() || defaultValue;
}

async function detectTools() {
  const tools = {
    claude: { available: false, version: null },
    codex: { available: false, version: null },
    gh: { available: false, version: null },
    node: { available: true, version: process.version }
  };

  // Claude CLI
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 5000 });
    tools.claude.available = true;
    tools.claude.version = stdout.trim().split("\n")[0];
  } catch {
    // Check common install paths
    try {
      const { stdout } = await execFileAsync("which", ["claude"], { timeout: 3000 });
      if (stdout.trim()) {
        tools.claude.available = true;
        tools.claude.version = "found";
      }
    } catch { /* not installed */ }
  }

  // Codex CLI
  try {
    const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 5000 });
    tools.codex.available = true;
    tools.codex.version = stdout.trim().split("\n")[0];
  } catch {
    try {
      const { stdout } = await execFileAsync("which", ["codex"], { timeout: 3000 });
      if (stdout.trim()) {
        tools.codex.available = true;
        tools.codex.version = "found";
      }
    } catch { /* not installed */ }
  }

  // GitHub CLI
  try {
    const { stdout } = await execFileAsync("gh", ["--version"], { timeout: 5000 });
    tools.gh.available = true;
    tools.gh.version = stdout.trim().split("\n")[0].replace("gh version ", "");
  } catch { /* not installed */ }

  return tools;
}

function buildTeamConfig({ primaryProvider, executionProvider, detected, reviewEnabled, hasBothProviders }) {
  const providerCommands = {};
  const executionCommands = {};
  const pipelines = {};

  if (detected.claude.available) {
    providerCommands["claude-teams"] = "claude -p --verbose --output-format stream-json < {{prompt_file}}";
    executionCommands["claude-teams"] = "claude -p --verbose --output-format stream-json --permission-mode bypassPermissions --allowedTools Read,Write,Edit,Bash,Glob,Grep,Task,WebSearch,WebFetch < {{prompt_file}}";
  }

  if (detected.codex.available) {
    providerCommands["codex"] = "codex exec --skip-git-repo-check -c model='o4-mini' -c model_provider=openai < {{prompt_file}}";
  }

  // Build pipelines if both providers are available
  if (hasBothProviders) {
    const bothProviders = [primaryProvider === "claude-teams" ? "claude-teams" : "codex"];
    const secondary = primaryProvider === "claude-teams" ? "codex" : "claude-teams";
    bothProviders.push(secondary);

    pipelines["technical-consult"] = {
      pm: [...bothProviders],
      frontend: [...bothProviders],
      backend: [...bothProviders]
    };
  }

  const roleProvider = primaryProvider;

  const config = {
    version: "1.0",
    name: "my-team",
    providers: {
      brainstorm: primaryProvider,
      execution: executionProvider,
      fallback: "local-template",
      providerIdleTimeoutMs: 30000,
      providerMaxTimeoutMs: 300000,
      providerTimeoutMs: 300000,
      providerEnvExclude: {
        codex: ["OPENAI_API_KEY"],
        "claude-teams": ["ANTHROPIC_API_KEY"]
      },
      executionProvider,
      executionTimeoutMs: 600000,
      executionIdleTimeoutMs: 60000,
      providerCommands,
      ...(Object.keys(executionCommands).length > 0 ? { executionCommands } : {})
    },
    gates: {
      codeReview: {
        enabled: reviewEnabled,
        provider: primaryProvider,
        rulesFile: "AGENTS.md",
        maxDiffLines: 3000
      }
    },
    roles: [
      {
        id: "pm",
        name: "PM",
        persona: "Scope owner who translates goals into milestones and acceptance criteria.",
        responsibilities: ["Define scope and sequencing", "Clarify assumptions and dependencies", "Track risks and mitigations"],
        deliverables: ["Milestones", "Acceptance criteria"],
        expertise: ["planning", "delivery", "scope"],
        provider: roleProvider
      },
      {
        id: "frontend",
        name: "Frontend Senior",
        persona: "Senior UI engineer focused on UX integrity and client architecture.",
        responsibilities: ["Propose UI architecture changes", "Assess UX regressions and state handling"],
        deliverables: ["UI technical plan", "E2E validation notes"],
        expertise: ["frontend", "ux", "e2e", "performance"],
        provider: roleProvider
      },
      {
        id: "backend",
        name: "Backend Senior",
        persona: "Senior backend engineer focused on domain, APIs and data consistency.",
        responsibilities: ["Design backend changes", "Validate API and data impact"],
        deliverables: ["Backend technical plan", "Risk and rollback plan"],
        expertise: ["backend", "api", "database", "security", "performance"],
        provider: roleProvider
      },
      {
        id: "tech-lead",
        name: "Tech Lead",
        persona: "Senior technical leader who orchestrates development teams.",
        responsibilities: ["Break down goals into implementable tasks", "Delegate work to specialists", "Review code quality and architectural consistency"],
        deliverables: ["Task breakdown", "Implementation coordination", "Code review"],
        expertise: ["architecture", "code-review", "coordination", "delivery"],
        provider: roleProvider
      }
    ]
  };

  if (hasBothProviders) {
    config.providers.providerPipelines = pipelines;
    config.providers.parallelPipelineByMode = { "technical-consult": true };

    if (detected.claude.available) {
      config.providers.executionEnv = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" };
    }
  }

  return config;
}
