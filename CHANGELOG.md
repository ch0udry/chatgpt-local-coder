# Changelog

## 2026-10-09

### Added
- Native MCP stdio entrypoint (`src/stdio.ts`) for MCPHub-managed execution.
- Reuse of the existing MCP tool factory, project runtime, and upstream MCP manager in stdio mode without changing the HTTP entrypoint.

### Verified
- TypeScript build succeeds.
- Both HTTP and stdio transports discover the same 51 MCP tools with the `full` tool profile.
- MCPHub stdio connection initializes successfully and lists 51 tools.

### Unchanged
- Existing Streamable HTTP transport and admin server implementation.
