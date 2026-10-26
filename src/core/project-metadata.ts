/** Shared project write contract. No defaults, role inference or Jira writes. */
export function assertProjectMetadata(sourceId: string | undefined, slug: string, type: string, fm: Record<string, unknown>): void {
  if (sourceId !== 'shared' || type !== 'project') return;
  const fields = slug === 'projects/other'
    ? ['status', 'short_title', 'jira_sync']
    : ['status', 'short_title', 'domain', 'lead', 'jira_sync'];
  const missing = fields.filter(key => fm[key] === undefined || fm[key] === null || fm[key] === '');
  // Keep legacy authoring statuses; Jira eligibility is a separate contract.
  const statuses = new Set(['idea','active','stable','on-hold','done','dropped','paused','draft','retired']);
  const invalid = fields.filter(key => {
    if (missing.includes(key)) return false;
    const value = fm[key];
    if (key === 'jira_sync') return typeof value !== 'boolean';
    if (typeof value !== 'string' || !value.trim() || /[<>]/.test(value)) return true;
    if (key === 'status') return !statuses.has(value);
    if (key === 'domain') return !/^digital\/data-domains\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
    if (key === 'lead') return !/^hcm\/employees\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
    return false;
  });
  if (missing.length || invalid.length) throw new Error(
    `${missing.length ? 'PROJECT_METADATA_REQUIRED' : 'PROJECT_METADATA_INVALID'} ${sourceId}:${slug}: ask all fields together; missing: ${missing.join(', ') || 'none'}; invalid: ${invalid.join(', ') || 'none'}. Persist explicit values, never infer lead from owner or default jira_sync. Confirm whether this is an actual project or documentation; documentation uses an explicit supported type such as note, even under projects/. Do not reclassify a real project to bypass validation.`
  );
}
