import { nowIso } from "./utils.mjs";

const WORKFLOW_KEYWORDS = {
  bugfix: ["bug", "fix", "error", "falla", "falla", "regresion", "regresión", "parche"],
  refactor: ["refactor", "limpieza", "deuda tecnica", "deuda técnica", "simplifica", "modulariza"],
  feature: ["feature", "implementa", "agrega", "añade", "nueva funcionalidad", "new feature"],
  understand: ["entender", "analiza", "explora", "mapa", "arquitectura", "reglas de negocio", "diagnostico", "diagnóstico"]
};

const RISK_HINTS = {
  high: ["migracion", "migración", "billing", "payment", "auth", "autentic", "schema", "breaking", "produccion", "producción"],
  low: ["typo", "docs", "readme", "comentario", "format"]
};

function countMatches(text, words) {
  return words.reduce((acc, word) => (text.includes(word) ? acc + 1 : acc), 0);
}

function inferWorkflow(text) {
  let selected = "understand";
  let maxScore = -1;

  for (const [workflow, words] of Object.entries(WORKFLOW_KEYWORDS)) {
    const score = countMatches(text, words);
    if (score > maxScore) {
      maxScore = score;
      selected = workflow;
    }
  }

  return selected;
}

function inferRisk(text) {
  const highScore = countMatches(text, RISK_HINTS.high);
  const lowScore = countMatches(text, RISK_HINTS.low);

  if (highScore >= 2) {
    return "high";
  }

  if (lowScore >= 1 && highScore === 0) {
    return "low";
  }

  return "medium";
}

function extractConstraints(text) {
  const constraints = [];

  if (text.includes("no modifiques api") || text.includes("sin tocar api") || text.includes("no cambies api")) {
    constraints.push("Do not modify public API contracts.");
  }

  if (text.includes("read only") || text.includes("solo lectura")) {
    constraints.push("Plan and analyze only. Do not apply code changes.");
  }

  if (text.includes("sin migraciones") || text.includes("no migrations")) {
    constraints.push("Avoid schema migrations.");
  }

  if (text.includes("parche minimo") || text.includes("parche mínimo")) {
    constraints.push("Prioritize minimal patch scope.");
  }

  return constraints;
}

export function parseNaturalTask(input, options = {}) {
  if (!input || !input.trim()) {
    throw new Error("missing task description");
  }

  const normalized = input.toLowerCase();
  const workflow = inferWorkflow(normalized);

  return {
    type: workflow,
    intent: workflow,
    goal: input.trim(),
    createdAt: nowIso(),
    riskHint: inferRisk(normalized),
    repoPath: options.repoPath,
    branch: options.branch || null,
    constraints: extractConstraints(normalized),
    metadata: {
      channel: options.channel || "cli-chat",
      requestedBy: options.requestedBy || "local-user",
      language: options.language || "es"
    }
  };
}
