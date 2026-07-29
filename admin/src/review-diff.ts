export function formatChangedDraftFields(
  original: object,
  draft: object,
  fields: string[],
): string {
  const before = original as Record<string, unknown>;
  const after = draft as Record<string, unknown>;
  return fields
    .flatMap(field => [
      `- ${field}: ${JSON.stringify(before[field] ?? null)}`,
      `+ ${field}: ${JSON.stringify(after[field] ?? null)}`,
    ])
    .join('\n');
}
