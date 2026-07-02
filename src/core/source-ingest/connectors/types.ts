export interface SourceObjectDescriptor {
  name: string;
  displayName?: string;
  estimatedCount?: number;
  supportsChangedSince?: boolean;
}

export interface SourceRecord {
  external_id: string;
  data: Record<string, unknown>;
  source_updated_at?: string | null;
}

export interface SourceRecordBatch {
  records: SourceRecord[];
  cursor?: string | null;
}

export interface FieldProfile {
  name: string;
  observedTypes: string[];
  nullRatio: number;
  cardinality: number;
  samples: unknown[];
}

export interface DiscoveryProfile {
  connectorId: string;
  objectName: string;
  totalEstimate?: number;
  sampled: number;
  fields: FieldProfile[];
  idCandidates: string[];
  updatedAtCandidates: string[];
  parentCandidates: string[];
  warnings: string[];
  samples: SourceRecord[];
}

export interface SourceFetchOptions {
  fields?: string[];
}

export interface SourceConnector {
  id: string;
  displayName: string;
  listObjects(): Promise<SourceObjectDescriptor[]>;
  sample(objectName: string, limit: number, opts?: SourceFetchOptions): Promise<SourceRecord[]>;
  fetchAll?(objectName: string, cursorOrOpts?: string | SourceFetchOptions, opts?: SourceFetchOptions): AsyncIterable<SourceRecordBatch>;
  fetchChangedSince?(objectName: string, since: string, opts?: SourceFetchOptions): AsyncIterable<SourceRecordBatch>;
  fetchById?(objectName: string, id: string, opts?: SourceFetchOptions): Promise<SourceRecord | null>;
}
