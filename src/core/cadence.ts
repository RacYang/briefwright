import type { EffectiveConfig } from "../config/types.js";
import { SqliteStateStore } from "../state/sqlite.js";

export function evaluateCadence(config: EffectiveConfig, store: SqliteStateStore, now = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(now);
  if (weekday !== "Mon") return { evaluated: false, reason: "Cadence governance runs on Monday in Asia/Shanghai", proposals: [] as string[] };
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const proposals: string[] = [];
  for (const source of config.preset.sources) {
    const bounds = source.cadence ?? { minimumHours: 6, defaultHours: 24, maximumHours: 168 };
    const metrics = store.sourceCadenceMetrics(source.id, since);
    if (metrics.humanLocked) continue;
    const current = metrics.currentHours ?? bounds.defaultHours;
    const ageDays = metrics.firstReceiptAt ? (now.getTime() - new Date(metrics.firstReceiptAt).getTime()) / 86_400_000 : 0;
    if (ageDays < 14 || metrics.successes < 5) continue;
    let proposed = current;
    let reason = "";
    if (metrics.successes >= 10 && metrics.selections === 0 && metrics.failures === 0) {
      proposed = Math.min(bounds.maximumHours, current * 2);
      reason = "30-day downshift: at least 10 successful receipts, zero selections, and no coverage failures";
    } else if (metrics.selections >= 3) {
      proposed = Math.max(bounds.minimumHours, current / 2);
      reason = "30-day upshift: repeated selected intelligence indicates a high-yield source";
    }
    if (!reason || Math.abs(proposed - current) / current < 0.25 || proposed === current) continue;
    const id = store.createCadenceProposal(source.id, current, proposed, reason, metrics, now.toISOString());
    if (id) proposals.push(id);
  }
  return { evaluated: true, reason: "weekly evaluation complete", proposals };
}
