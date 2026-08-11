import type { PolicyDefinition } from "./types.js";
import { ConfigurationError } from "./errors.js";

export function validatePolicy(policy: PolicyDefinition): void {
  const requiredRules = new Set([
    "RULE-WORKFLOW-V1.3", "RULE-SCORE-V1.0", "RULE-SELECTION-V1.1", "RULE-SOURCE-V1.1",
    "RULE-IMPROVEMENT-V1.0", "RULE-RETENTION-V1.0", "RULE-REVIEW-OUTPUT-V1.1",
  ]);
  const configured = new Set(policy.rules.map((rule) => rule.id));
  const missing = [...requiredRules].filter((rule) => !configured.has(rule));
  const totalWeight = policy.score.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const problems: string[] = [];
  if (missing.length) problems.push(`policy is missing canonical rules: ${missing.join(", ")}`);
  if (Math.abs(totalWeight - 1) > 1e-9) problems.push(`score weights must total 1; received ${totalWeight}`);
  if (new Set(policy.score.dimensions.map((dimension) => dimension.id)).size !== 7) problems.push("policy must define seven unique score dimensions");
  if (policy.score.reviewMinimum >= policy.score.dailyThreshold) problems.push("reviewMinimum must be below dailyThreshold");
  if (problems.length) throw new ConfigurationError("Policy resource is invalid", problems);
}
