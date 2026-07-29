import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../api';
import type { SourceIngestCatalogTree } from './shared';
import { loadBootstrapSources } from './sourceIngestBootstrap';

export interface SourceIngestOverview {
  connectors: Array<{
    id: string;
    kind?: string;
    displayName: string;
    object: string;
    supportsChangedSince: boolean;
    credentialMode: string;
    status?: string;
    requiredKeys?: string[];
    requiredEnv?: string[];
    fields?: Array<{ key: string; label: string; defaultValue: string }>;
    safety?: string[];
  }>;
  profiles: { rows: Array<{ profile_id: string; status: string; current_version: number; profile_json: unknown }>; count: number };
  status: { rows: Array<Record<string, unknown>>; summary?: Record<string, unknown> };
  refresh: { count: number; due?: Array<Record<string, unknown>> };
  connector_configs?: { rows: Array<Record<string, unknown>>; count: number };
  source_tables?: Array<Record<string, unknown>>;
  catalog_tree?: SourceIngestCatalogTree;
  sources: Array<{ id: string; name: string; path?: string; federated?: boolean }>;
}

type SourceIngestBootstrapOptions = {
  setError: Dispatch<SetStateAction<string | null>>;
  setSelectedProfile: Dispatch<SetStateAction<string>>;
};

export function useSourceIngestBootstrap({ setError, setSelectedProfile }: SourceIngestBootstrapOptions) {
  const [data, setData] = useState<SourceIngestOverview | null>(null);
  const [schemaWorkbench, setSchemaWorkbench] = useState<unknown>(null);

  const load = useCallback(() => loadBootstrapSources({
    fetchOverview: async () => await api.sourceIngestOverview() as SourceIngestOverview,
    fetchSchemaWorkbench: () => api.sourceIngestSchemaView(),
    onOverview: overview => {
      setData(overview);
      const firstProfile = overview.profiles?.rows?.[0]?.profile_id;
      if (firstProfile) setSelectedProfile(current => current || firstProfile);
    },
    onSchemaWorkbench: setSchemaWorkbench,
    setError,
  }), [setError, setSelectedProfile]);

  const refreshCatalogTree = useCallback(async () => {
    const tree = await api.sourceIngestCatalogTree() as SourceIngestCatalogTree;
    setData(current => current ? { ...current, catalog_tree: tree } : current);
    return tree;
  }, []);

  return { data, schemaWorkbench, load, refreshCatalogTree };
}
