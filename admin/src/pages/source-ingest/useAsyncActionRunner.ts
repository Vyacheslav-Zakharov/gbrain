import { useCallback, useState } from 'react';

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAsyncActionRunner() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(null);
    try {
      return await action();
    } catch (error) {
      setError(toErrorMessage(error));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  return { busy, error, setError, run };
}
