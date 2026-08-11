import type { PolicyDefinition } from "./types.js";
import { ConfigurationError } from "./errors.js";

export function validatePolicy(policy: PolicyDefinition): void {
  const requiredRules = new Set([
    "RULE-WORKFLOW-V1.3", "RULE-SCORE-V1.0", "RULE-SELECTION-V1.1", "RULE-SOURCE-V1.1",
    "RULE-IMPROVEMENT-V1.0", "RULE-RETENTION-V1.0", "RULE-REVIEW-OUTPUT-V1.1",
  ]);
  const configured = new Set(policy.rules.map((rule) => rule.id));
  const requiredDimensions = new Set(["authority", "evidence", "relevance", "impact", "novelty", "recency", "actionability"]);
  const requiredDomains = new Set(["基础", "机器学习与深度学习", "模型与生成式 AI", "数据与知识", "系统与工程", "安全与治理", "应用域", "Agent"]);
  const missing = [...requiredRules].filter((rule) => !configured.has(rule));
  const totalWeight = policy.score.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const problems: string[] = [];
  if (missing.length) problems.push(`policy is missing canonical rules: ${missing.join(", ")}`);
  if (policy.rules.length !== 7 || configured.size !== 7) problems.push("policy must contain each of the seven canonical rules exactly once");
  for (const rule of policy.rules) {
    const suffix = /-V([0-9]+\.[0-9]+)$/.exec(rule.id)?.[1];
    if (!suffix || suffix !== rule.version) problems.push(`rule ${rule.id} version does not match its ID`);
  }
  if (Math.abs(totalWeight - 1) > 1e-9) problems.push(`score weights must total 1; received ${totalWeight}`);
  const dimensions = new Set(policy.score.dimensions.map((dimension) => dimension.id));
  if (policy.score.dimensions.length !== 7 || dimensions.size !== 7 || [...requiredDimensions].some((id) => !dimensions.has(id as never))) problems.push("policy must define each canonical score dimension exactly once");
  if (policy.score.dimensions.some((dimension) => !Number.isFinite(dimension.weight) || dimension.weight <= 0 || dimension.weight > 1)) problems.push("score weights must be finite values in (0, 1]");
  if (policy.score.reviewMinimum >= policy.score.dailyThreshold) problems.push("reviewMinimum must be below dailyThreshold");
  if (policy.score.reviewMinimum < 0 || policy.score.dailyThreshold > 100) problems.push("score thresholds must stay within 0..100");
  if (!Number.isInteger(policy.score.dailyMaximum) || policy.score.dailyMaximum < 1 || !Number.isInteger(policy.score.perDomainMaximum) || policy.score.perDomainMaximum < 1) problems.push("selection caps must be positive integers");
  const domains = new Set(policy.domains);
  if (policy.domains.length !== requiredDomains.size || domains.size !== requiredDomains.size || [...requiredDomains].some((domain) => !domains.has(domain))) problems.push("policy must define each canonical intelligence domain exactly once");
  if (!Number.isInteger(policy.retention.quoteWordLimit) || policy.retention.quoteWordLimit < 1 || policy.retention.quoteWordLimit > 25) problems.push("quoteWordLimit must be an integer from 1 to 25");
  if (problems.length) throw new ConfigurationError("Policy resource is invalid", problems);
}
