#!/usr/bin/env node

export {}; // Force this file to be treated as a module (see mcp-server.ts).
// Stdio entry point. This is what Claude Desktop, OpenCode (local/spawned mode), and any
// other MCP client that spawns a child process over stdio should point at. It owns the
// process lifecycle (signal handling, exit codes) but delegates all diagram/tool logic to
// the shared engine in mcp-server.ts, which is also used by the HTTP entry point
// (http-server.ts) for long-lived remote/local-server deployments.

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createMcpServer, startDiagramSweeper, previewServer } = require("./mcp-server");

async function main() {
  startDiagramSweeper();

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BPMN.js MCP server running on stdio");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void previewServer.stop().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  void previewServer.stop();
  console.error("Fatal error in main():", error);
  process.exit(1);
});
