import type { EffectiveConfig } from "../config/types.js";
import { SqliteStateStore } from "../state/sqlite.js";

export function evaluateCadence(config: EffectiveConfig, store: SqliteStateStore, now = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(now);
  if (weekday !== "Mon") return { evaluated: false, reason: "Cadence governance runs on Monday in Asia/Shanghai", proposals: [] as string[], activeOverrides: store.cadenceOverrides(config.preset.sources) };
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const proposals: string[] = [];
  const coverageGaps = new Set(store.coverageGapDomains(config.policy.domains, now));
  for (const source of config.preset.sources) {
    const bounds = source.cadence ?? { minimumHours: 6, defaultHours: 24, maximumHours: 168 };
    const metrics = store.sourceCadenceMetrics(source.id, since);
    if (metrics.humanLocked) { store.recordCadenceRecommendation(source.id, "none", now.toISOString()); continue; }
    const current = metrics.currentHours ?? bounds.defaultHours;
    const ageDays = metrics.firstReceiptAt ? (now.getTime() - new Date(metrics.firstReceiptAt).getTime()) / 86_400_000 : 0;
    if (ageDays < 14 || metrics.successes < 5) { store.recordCadenceRecommendation(source.id, "none", now.toISOString()); continue; }
    const reliability = metrics.successes + metrics.failures ? metrics.successes / (metrics.successes + metrics.failures) * 100 : 0;
    const updateActivity = metrics.successes ? Math.min(100, metrics.updates / metrics.successes * 100) : 0;
    const selectionYield = Math.min(100, metrics.selections / 2 * 100);
    const authority = Math.min(100, Math.max(0, source.priority ?? 50));
    const sourceDomains = (source.coverageDomains ?? (source.domain ? [source.domain] : [])).filter((domain) => config.policy.domains.includes(domain));
    const coverageGap = sourceDomains.some((domain) => coverageGaps.has(domain)) ? 100 : 0;
    const score = updateActivity * 0.4 + selectionYield * 0.25 + authority * 0.15 + coverageGap * 0.1 + reliability * 0.1;
    const levels = [24, 168, 720];
    const currentLevel = current <= 24 ? 0 : current <= 168 ? 1 : 2;
    let targetLevel = score >= 70 || metrics.selections >= 2 ? 0 : score >= 35 ? 1 : 2;
    if ((source.priority ?? 0) >= 98) targetLevel = 0;
    else if (source.evidenceTier === "primary" && (source.priority ?? 0) >= 90) targetLevel = Math.min(targetLevel, 1);
    if (targetLevel === currentLevel) { store.recordCadenceRecommendation(source.id, "none", now.toISOString()); continue; }
    const direction = targetLevel < currentLevel ? "up" : "down";
    if (direction === "down" && (ageDays < 30 || metrics.successes < 10 || metrics.selections > 0 || coverageGap > 0)) {
      store.recordCadenceRecommendation(source.id, "none", now.toISOString()); continue;
    }
    const immediate = direction === "up" && (metrics.selections >= 2 || metrics.updates >= 2);
    const streak = store.recordCadenceRecommendation(source.id, direction, now.toISOString());
    const requiredCycles = immediate ? 1 : direction === "up" ? 2 : 3;
    if (streak < requiredCycles) continue;
    const adjacentLevel = currentLevel + (direction === "up" ? -1 : 1);
    const proposed = Math.min(bounds.maximumHours, Math.max(bounds.minimumHours, levels[adjacentLevel]!));
    if (proposed === current) continue;
    const reason = `${direction === "up" ? "upshift" : "downshift"} score ${score.toFixed(1)} after ${streak} consecutive weekly cycle(s); updates=${metrics.updates}, selections=${metrics.selections}, coverageGap=${coverageGap.toFixed(1)}, reliability=${reliability.toFixed(1)}%`;
    const id = store.createCadenceProposal(source.id, current, proposed, reason, { ...metrics, score, components: { updateActivity, selectionYield, authority, coverageGap, reliability }, streak, requiredCycles }, now.toISOString());
    if (id) proposals.push(id);
  }
  return { evaluated: true, reason: "weekly evaluation complete", proposals, activeOverrides: store.cadenceOverrides(config.preset.sources) };
}
