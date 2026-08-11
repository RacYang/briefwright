const START = "<!-- briefwright:index:start -->";
const END = "<!-- briefwright:index:end -->";

export function updateBriefingIndex(existing: string | undefined, title: string, relativeArtifact: string, marker?: string): string {
  const entry = marker ? `- [[${relativeArtifact.replace(/\.md$/, "")}|${relativeArtifact.replace(/\.md$/, "")}]]` : `- [${relativeArtifact.replace(/\.md$/, "")}](${relativeArtifact})`;
  const startMarker = marker ? `<!-- ${marker}:start -->` : START; const endMarker = marker ? `<!-- ${marker}:end -->` : END;
  if (existing === undefined) return `# ${title}\n\n${startMarker}\n${entry}\n${endMarker}\n`;
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error(`Briefing index is missing managed markers: ${title}`);
  const bodyStart = start + startMarker.length;
  const current = existing.slice(bodyStart, end).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries = [...new Set([...current, entry])].sort().reverse();
  return `${existing.slice(0, bodyStart)}\n${entries.join("\n")}\n${existing.slice(end)}`;
}

export function validateBriefingIndex(content: string, relativeArtifact: string, marker: string): void {
  const normalized = relativeArtifact.split(/[/\\]+/).join("/");
  if (normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Managed index target escapes the briefing root: ${relativeArtifact}`);
  }
  const target = normalized.replace(/\.md$/, "");
  if (!content.includes(`<!-- ${marker}:start -->`) || !content.includes(`<!-- ${marker}:end -->`) || !content.includes(`[[${target}|${target}]]`)) {
    throw new Error(`Managed index is missing markers or Wiki target ${target}`);
  }
}
