const TEXT_KEYS = ["#text", "_text", "__text", "text", "value"] as const;

export function normalizeScalarText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.length === 1 ? normalizeScalarText(value[0]) : undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of TEXT_KEYS) {
    const normalized = normalizeScalarText(record[key]);
    if (normalized) return normalized;
  }
  return undefined;
}

export function normalizeExternalKey(canonicalUrl: string, ...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeScalarText(candidate);
    if (normalized) return normalized;
  }
  return canonicalUrl;
}
