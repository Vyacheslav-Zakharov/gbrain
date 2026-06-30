export const SOURCE_SYNC_BEGIN = '<!-- gbrain-source-sync:start';
export const SOURCE_SYNC_END = '<!-- gbrain-source-sync:end -->';

export interface ManagedBlockMergeResult {
  content: string;
  action: 'inserted' | 'replaced' | 'unchanged';
  previousBlock?: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockStartRe(profileId: string, externalRef: string): RegExp {
  return new RegExp(`<!-- gbrain-source-sync:start\\s+profile="${escapeRe(profileId)}"\\s+external_ref="${escapeRe(externalRef)}"\\s+-->[\\s\\S]*?<!-- gbrain-source-sync:end -->`, 'm');
}

export function renderManagedBlock(profileId: string, externalRef: string, body: string): string {
  return `${SOURCE_SYNC_BEGIN} profile="${profileId}" external_ref="${externalRef}" -->\n${body.trim()}\n${SOURCE_SYNC_END}`;
}

export function mergeManagedBlock(existingContent: string, profileId: string, externalRef: string, body: string): ManagedBlockMergeResult {
  const nextBlock = renderManagedBlock(profileId, externalRef, body);
  const match = existingContent.match(blockStartRe(profileId, externalRef));
  if (!match) {
    const sep = existingContent.endsWith('\n') || existingContent.length === 0 ? '' : '\n\n';
    return { content: `${existingContent}${sep}${nextBlock}\n`, action: 'inserted' };
  }
  if (match[0] === nextBlock) return { content: existingContent, action: 'unchanged', previousBlock: match[0] };
  return { content: existingContent.replace(match[0], nextBlock), action: 'replaced', previousBlock: match[0] };
}
