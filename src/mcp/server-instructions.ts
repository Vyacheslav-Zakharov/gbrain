/**
 * Agent-facing guidance advertised in the MCP initialize result.
 *
 * Keep this compact: MCP clients may add it to every conversation's system
 * context. The same constant is shared by stdio, OAuth HTTP, and legacy HTTP
 * so transport choice cannot change retrieval behavior.
 */
export const GBRAIN_MCP_INSTRUCTIONS = `Use GBrain as the institutional-memory layer for questions about people, organizations, projects, systems, processes, architecture, decisions, documentation, or prior context. When such a question may be covered by this brain, search GBrain before answering from memory: use search or query for discovery, then call get_page for the full relevant page before relying on details. Search snippets are pointers, not complete evidence. State which source and page slug support the answer, separate retrieved facts from interpretation, and say explicitly when no reliable page was found or access failed. For operationally current facts, verify the named source system when an approved tool exists; GBrain may provide context but is not proof of live state. For writes in a multi-source brain, pass an explicit source_id, keep sensitive data out of shared sources, and verify the write by reading it back.`;
