// Isolated child: exercise the real command with exactly one controlled 404.
import { runCheckUpdate } from '../../../src/commands/check-update.ts';
const originalFetch = globalThis.fetch;
const requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(url);
  return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
}) as typeof fetch;
try {
  await runCheckUpdate(['--json']);
  if (requests.length !== 1 || requests[0] !== 'https://api.github.com/repos/garrytan/gbrain/releases/latest') {
    throw new Error(`Unexpected fetches: ${JSON.stringify(requests)}`);
  }
} finally {
  globalThis.fetch = originalFetch;
}
