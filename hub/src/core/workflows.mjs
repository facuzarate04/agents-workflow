import path from "node:path";
import { HUB_ROOT, readJsonFile } from "./utils.mjs";

export async function loadWorkflow(type) {
  const workflowPath = path.join(HUB_ROOT, "workflows", `${type}.json`);
  const workflow = await readJsonFile(workflowPath, null);

  if (!workflow) {
    throw new Error(`workflow not found: ${type}`);
  }

  return {
    workflowPath,
    workflow
  };
}

function makeGateResult(gate, taskSpec, policyContext) {
  const hardRequired = (policyContext.mergedRules.requiredChecks || []).includes(gate.id);

  return {
    id: gate.id,
    title: gate.title,
    status: taskSpec.constraints.includes("Plan and analyze only. Do not apply code changes.")
      ? "skipped"
      : "pending",
    required: hardRequired || gate.required === true,
    rationale: hardRequired
      ? "required by merged policy"
      : gate.required
        ? "required by workflow"
        : "optional"
  };
}

export function draftExecutionPlan({ workflow, taskSpec, policyContext, mcpContext }) {
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    summary: workflow.summary,
    steps: workflow.steps.map((step, index) => ({
      id: step.id,
      order: index + 1,
      title: step.title,
      objective: step.objective,
      status: "pending"
    })),
    gates: workflow.gates.map((gate) => makeGateResult(gate, taskSpec, policyContext)),
    selectedMcp: {
      trusted: mcpContext.grouped.trusted.map((entry) => entry.name),
      reviewRequired: mcpContext.grouped.reviewRequired.map((entry) => entry.name),
      blocked: mcpContext.grouped.blocked.map((entry) => entry.name)
    }
  };
}
