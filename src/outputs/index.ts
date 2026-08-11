const START = "<!-- briefwright:index:start -->";
const END = "<!-- briefwright:index:end -->";

export function updateBriefingIndex(existing: string | undefined, title: string, relativeArtifact: string): string {
  const entry = `- [${relativeArtifact.replace(/\.md$/, "")}](${relativeArtifact})`;
  if (existing === undefined) return `# ${title}\n\n${START}\n${entry}\n${END}\n`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start < 0 || end < start) throw new Error(`Briefing index is missing managed markers: ${title}`);
  const bodyStart = start + START.length;
  const current = existing.slice(bodyStart, end).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries = [...new Set([...current, entry])].sort().reverse();
  return `${existing.slice(0, bodyStart)}\n${entries.join("\n")}\n${existing.slice(end)}`;
}
