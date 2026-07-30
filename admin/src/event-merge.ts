export interface FeedEvent {
  id?: number;
  agent: string;
  operation: string;
  scopes: string;
  latency_ms: number;
  status: string;
  timestamp: string;
}

export function mergeEvents(current: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const all = [...incoming, ...current];
  const persisted = all.filter((event): event is FeedEvent & { id: number } => event.id != null);
  const matchedPersistedIds = new Set<number>();
  const seen = new Set<string>();
  return all
    .filter(event => {
      if (event.id == null) {
        const match = persisted.find(candidate =>
          !matchedPersistedIds.has(candidate.id)
          && candidate.agent === event.agent
          && candidate.operation === event.operation
          && candidate.status === event.status
          && candidate.latency_ms === event.latency_ms
          && Math.abs(new Date(candidate.timestamp).getTime() - new Date(event.timestamp).getTime()) < 5000,
        );
        if (match) {
          matchedPersistedIds.add(match.id);
          return false;
        }
      }
      const key = event.id != null
        ? `id:${event.id}`
        : `${event.timestamp}|${event.agent}|${event.operation}|${event.status}|${event.latency_ms}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 50);
}
