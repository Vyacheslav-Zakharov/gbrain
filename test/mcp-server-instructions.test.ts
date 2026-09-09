import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { GBRAIN_MCP_INSTRUCTIONS } from '../src/mcp/server-instructions.ts';

describe('MCP server instructions', () => {
  test('initialize advertises the retrieval-first contract', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: 'gbrain-test', version: '0' },
      { capabilities: { tools: {} }, instructions: GBRAIN_MCP_INSTRUCTIONS },
    );
    const client = new Client(
      { name: 'gbrain-test-client', version: '0' },
      { capabilities: {} },
    );

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getInstructions()).toBe(GBRAIN_MCP_INSTRUCTIONS);
      expect(client.getInstructions()).toContain('search or query');
      expect(client.getInstructions()).toContain('get_page');
      expect(client.getInstructions()).toContain('explicit source_id');
      expect(client.getInstructions()).toContain('verify the named source system');
      expect(client.getInstructions()).toContain('verify the write by reading it back');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
