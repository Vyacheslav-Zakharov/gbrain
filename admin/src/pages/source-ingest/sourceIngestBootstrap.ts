export type BootstrapSources<TOverview, TSchemaWorkbench> = {
  fetchOverview: () => Promise<TOverview>;
  fetchSchemaWorkbench: () => Promise<TSchemaWorkbench>;
  onOverview: (overview: TOverview) => void;
  onSchemaWorkbench: (schemaWorkbench: TSchemaWorkbench) => void;
  setError: (error: string | null) => void;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadBootstrapSources<TOverview, TSchemaWorkbench>({
  fetchOverview,
  fetchSchemaWorkbench,
  onOverview,
  onSchemaWorkbench,
  setError,
}: BootstrapSources<TOverview, TSchemaWorkbench>): Promise<void> {
  setError(null);
  let primaryError: string | null = null;

  try {
    onOverview(await fetchOverview());
  } catch (error) {
    primaryError = toErrorMessage(error);
    setError(primaryError);
  }

  try {
    onSchemaWorkbench(await fetchSchemaWorkbench());
  } catch (error) {
    if (primaryError === null) {
      setError(`schema_view_unavailable: ${toErrorMessage(error)}`);
    }
  }
}
