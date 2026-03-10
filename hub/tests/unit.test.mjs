import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

// ─── Memory ────────────────────────────────────────────────────────────
import {
  saveObservation,
  searchObservations,
  getObservation,
  getStats,
  softDelete,
  getRelevantContext,
  formatContextForPrompt,
  startSession,
  endSession,
  closeMemory
} from "../src/core/memory.mjs";

describe("Memory", () => {
  const TEST_PROJECT = `__unit_test_${Date.now()}`;
  const TEST_SESSION = `test-session-${Date.now()}`;
  let savedId;

  after(() => {
    closeMemory();
  });

  it("startSession creates a session", () => {
    const result = startSession({ sessionId: TEST_SESSION, project: TEST_PROJECT, channel: "test" });
    assert.ok(result.sessionId);
    assert.ok(result.startedAt);
  });

  it("saveObservation creates a new observation and getObservation retrieves it", () => {
    const result = saveObservation({
      sessionId: TEST_SESSION,
      type: "decision",
      title: "Use ESM modules",
      content: "The project will use ES modules exclusively for all source code.",
      project: TEST_PROJECT,
      scope: "project"
    });
    assert.equal(result.action, "created");
    assert.ok(result.id);
    savedId = Number(result.id);

    const obs = getObservation(savedId);
    assert.ok(obs);
    assert.equal(obs.title, "Use ESM modules");
    assert.equal(obs.project, TEST_PROJECT);
  });

  it("searchObservations finds observation by FTS content", () => {
    const results = searchObservations({ query: "ES modules exclusively", project: TEST_PROJECT });
    assert.ok(results.length > 0);
    const found = results.find((r) => Number(r.id) === savedId);
    assert.ok(found, "Expected saved observation in FTS results");
  });

  it("dedup returns deduplicated when same content within 15 min", () => {
    const result = saveObservation({
      sessionId: TEST_SESSION,
      type: "decision",
      title: "Use ESM modules",
      content: "The project will use ES modules exclusively for all source code.",
      project: TEST_PROJECT,
      scope: "project"
    });
    assert.equal(result.action, "deduplicated");
    assert.equal(Number(result.id), savedId);
  });

  it("topicKey upsert updates instead of inserting", () => {
    const first = saveObservation({
      sessionId: TEST_SESSION,
      type: "preference",
      title: "DB engine",
      content: "Use SQLite for local storage.",
      project: TEST_PROJECT,
      scope: "project",
      topicKey: `db-engine-${TEST_PROJECT}`
    });
    assert.equal(first.action, "created");

    const second = saveObservation({
      sessionId: TEST_SESSION,
      type: "preference",
      title: "DB engine v2",
      content: "Use PostgreSQL for production.",
      project: TEST_PROJECT,
      scope: "project",
      topicKey: `db-engine-${TEST_PROJECT}`
    });
    assert.equal(second.action, "updated");
    assert.equal(Number(second.id), Number(first.id));

    const obs = getObservation(Number(first.id));
    assert.equal(obs.title, "DB engine v2");
    assert.ok(obs.revision_count >= 2);
  });

  it("softDelete removes observation from queries", () => {
    const result = saveObservation({
      sessionId: TEST_SESSION,
      type: "error_pattern",
      title: "Temp observation for delete test",
      content: "This will be soft deleted shortly after creation.",
      project: TEST_PROJECT,
      scope: "project"
    });
    const id = Number(result.id);
    softDelete(id);
    const obs = getObservation(id);
    assert.equal(obs, null);
  });

  it("getRelevantContext returns results for the test project", () => {
    const ctx = getRelevantContext({ project: TEST_PROJECT, query: "modules" });
    assert.ok(Array.isArray(ctx));
    assert.ok(ctx.length > 0);
  });

  it("formatContextForPrompt produces expected output", () => {
    const observations = [
      { type: "decision", title: "Use ESM", content_preview: "ESM only", revision_count: 1 },
      { type: "preference", title: "Style", content_preview: "Prettier", revision_count: 3 }
    ];
    const output = formatContextForPrompt(observations);
    assert.ok(output.includes("Memory context"));
    assert.ok(output.includes("[decision] Use ESM"));
    assert.ok(output.includes("[rev 3]"));
    assert.ok(!output.includes("[rev 1]"));
  });

  it("formatContextForPrompt returns empty string for empty array", () => {
    assert.equal(formatContextForPrompt([]), "");
  });

  it("endSession marks session as ended", () => {
    const result = endSession({ sessionId: TEST_SESSION, summary: "Test complete" });
    assert.ok(result.sessionId);
    assert.ok(result.endedAt);
  });

  it("getStats returns counts", () => {
    const stats = getStats();
    assert.ok(typeof stats.totalObservations === "number");
    assert.ok(typeof stats.totalSessions === "number");
    assert.ok(Array.isArray(stats.byType));
    assert.ok(Array.isArray(stats.byProject));
    assert.ok(stats.dbPath);
  });
});

// ─── Config ────────────────────────────────────────────────────────────
import { loadTeamConfig } from "../src/team/config.mjs";

describe("Config", () => {
  it("loadTeamConfig returns merged config with expected keys", async () => {
    const { config } = await loadTeamConfig();
    assert.ok(config.version);
    assert.ok(config.name);
    assert.ok(typeof config.providers === "object");
    assert.ok(typeof config.gates === "object");
    assert.ok(Array.isArray(config.roles));
  });

  it("roles are sorted by id", async () => {
    const { config } = await loadTeamConfig();
    const ids = config.roles.map((r) => r.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(ids, sorted);
  });

  it("gates section exists", async () => {
    const { config } = await loadTeamConfig();
    assert.ok(config.gates !== undefined);
    assert.equal(typeof config.gates, "object");
  });
});

// ─── Envelope ──────────────────────────────────────────────────────────
import { normalizeToEnvelope } from "../src/team/providers.mjs";

describe("Envelope (normalizeToEnvelope)", () => {
  it("parses JSON inside a ```json block", () => {
    const raw = 'Some preamble\n```json\n{"summary":"all good","recommendations":["do X"]}\n```\nSome trailing text';
    const env = normalizeToEnvelope(raw, "tester");
    assert.equal(env.summary, "all good");
    assert.deepStrictEqual(env.recommendations, ["do X"]);
  });

  it("parses a plain JSON string", () => {
    const raw = '{"summary":"direct json","recommendations":["a","b"],"risks":["r1"]}';
    const env = normalizeToEnvelope(raw, "tester");
    assert.equal(env.summary, "direct json");
    assert.equal(env.recommendations.length, 2);
    assert.equal(env.risks.length, 1);
  });

  it("parses text with Recommendations: section", () => {
    const raw = [
      "This is the summary line.",
      "Recommendations:",
      "- Use caching",
      "- Add retries",
      "Risks:",
      "- Latency spikes"
    ].join("\n");
    const env = normalizeToEnvelope(raw, "tester");
    assert.equal(env.status, "completed");
    assert.equal(env.summary, "This is the summary line.");
    assert.ok(env.recommendations.length >= 2);
    assert.ok(env.risks.length >= 1);
  });

  it("returns a fallback envelope for random text", () => {
    const raw = "Just some random text without any structure at all";
    const env = normalizeToEnvelope(raw, "RandomRole");
    assert.equal(env.status, "completed");
    assert.ok(env.summary);
  });
});

// ─── Review ────────────────────────────────────────────────────────────
import { resolveReviewConfig, isCodeReviewEnabled, formatReviewForSlack } from "../src/core/review.mjs";

describe("Review parsing", () => {
  it("resolveReviewConfig merges with defaults", () => {
    const config = resolveReviewConfig({ gates: { codeReview: { enabled: true, maxDiffLines: 5000 } } });
    assert.equal(config.enabled, true);
    assert.equal(config.maxDiffLines, 5000);
    // defaults preserved
    assert.equal(config.provider, "claude-teams");
    assert.equal(config.timeoutMs, 180_000);
    assert.equal(config.rulesFile, "AGENTS.md");
  });

  it("isCodeReviewEnabled returns true when enabled", () => {
    assert.equal(isCodeReviewEnabled({ gates: { codeReview: { enabled: true } } }), true);
  });

  it("isCodeReviewEnabled returns false when disabled or missing", () => {
    assert.equal(isCodeReviewEnabled({ gates: {} }), false);
    assert.equal(isCodeReviewEnabled({}), false);
    assert.equal(isCodeReviewEnabled(null), false);
  });

  it("formatReviewForSlack with passed result", () => {
    const result = { passed: true, summary: "Looks great", issues: [], durationMs: 4200 };
    const output = formatReviewForSlack(result);
    assert.ok(output.includes("Approved"));
    assert.ok(output.includes("Looks great"));
    assert.ok(output.includes("4s"));
  });

  it("formatReviewForSlack with failed result and issues", () => {
    const result = {
      passed: false,
      summary: "Found problems",
      issues: [
        { severity: "critical", file: "index.js", description: "SQL injection" },
        { severity: "warning", file: "utils.js", description: "Missing null check" }
      ],
      durationMs: 7800
    };
    const output = formatReviewForSlack(result);
    assert.ok(output.includes("Changes Requested"));
    assert.ok(output.includes("index.js"));
    assert.ok(output.includes("SQL injection"));
    assert.ok(output.includes("utils.js"));
  });

  it("formatReviewForSlack with skipped result returns empty string", () => {
    const result = { skipped: true, passed: true, summary: "Skipped" };
    const output = formatReviewForSlack(result);
    assert.equal(output, "");
  });
});
