import type { CaptureEnvelope } from "../connectors/types.js";
import type { AnalysisContext, ModelAnalysis, ModelProvider, ScoredDimension } from "./types.js";

const score = (value: number, reason: string): ScoredDimension => ({ value, reason });

export class FixtureModelProvider implements ModelProvider {
  readonly id = "fixture";
  readonly version = "1.0.0";

  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "Deterministic fixture provider is available" };
  }

  async analyze(capture: CaptureEnvelope, context: AnalysisContext): Promise<ModelAnalysis> {
    const relevant = context.interests.some((interest) => `${capture.title} ${capture.summary}`.toLowerCase().includes(interest.toLowerCase().split(" ")[0]!));
    return {
      title: capture.title,
      summary: capture.summary || capture.title,
      whyItMatters: relevant ? "The source directly overlaps the configured interests." : "The source may affect the monitored AI ecosystem.",
      domain: context.domains.includes("Agent") ? "Agent" : context.domains[0]!,
      claims: [capture.title],
      claimEvidence: [{ claimIndex: 0, excerpt: capture.title }],
      knowledgePotential: {
        reusableQuestion: true,
        mechanismIncrement: relevant,
        durableWithoutVersion: relevant,
        reason: relevant ? "The update can inform a reusable implementation decision." : "The durable mechanism is not yet clear.",
      },
      scores: {
        authority: score(capture.evidenceClass === "primary" ? 5 : 2, "Derived from the declared evidence class."),
        evidence: score(capture.evidenceClass === "primary" ? 5 : 2, "The capture links to its canonical source."),
        relevance: score(relevant ? 5 : 3, "Compared with configured interests."),
        impact: score(relevant ? 4 : 3, "Estimated impact for the fixture scenario."),
        novelty: score(4, "The capture represents a newly observed content hash."),
        recency: score(5, "The fixture is current for its frozen run clock."),
        actionability: score(relevant ? 4 : 2, "The update may change a near-term decision."),
      },
      exclusions: [],
    };
  }

  async analyzeBatch(captures: CaptureEnvelope[], context: AnalysisContext): Promise<ModelAnalysis[]> {
    return await Promise.all(captures.map((capture) => this.analyze(capture, context)));
  }
}
