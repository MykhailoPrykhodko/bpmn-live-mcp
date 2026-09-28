#!/usr/bin/env node

export {}; // Force this file to be treated as a module (see mcp-server.ts).

// HTTP entry point: runs the BPMN MCP server as a persistent local process that agents
// connect to over the network instead of spawning it themselves over stdio.
//
// Why this exists: over stdio, the MCP JSON-RPC framing shares the same pipe (stdout)
// that any stray console output from a dependency (jsdom, bpmn-js, etc.) could write to,
// and the process's lifetime is tied to whatever spawned it - if the parent agent process
// restarts, dies, or is killed after some idle period, the whole diagram session (and any
// open modeler tabs) dies with it. Running this file instead gives you:
//   - A process you start once and leave running, independent of any single agent/session.
//   - Diagrams and modeler tokens that survive an agent restart/reconnect.
//   - stdout is free for normal Node/process logging; nothing depends on it staying clean.
//
// Usage: `npm run start:http` (see package.json), then point any MCP-over-HTTP client at
// `http://127.0.0.1:<port>/mcp` (see README.md for the exact client configuration).

const http = require("http");
const { randomUUID } = require("crypto");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpServer, startDiagramSweeper, previewServer, pkg } = require("./mcp-server");

const HOST = process.env.BPMN_MCP_HTTP_HOST || "127.0.0.1";
const PORT = Number(process.env.BPMN_MCP_HTTP_PORT || 3939);
const MCP_PATH = "/mcp";

// One MCP `Server` + transport per client session, keyed by the `mcp-session-id` header
// the SDK generates on `initialize` and expects on every subsequent request. This is the
// pattern the SDK's stateful-mode docs describe: `Server` may only ever be connected to
// a single transport, and a transport tracks exactly one session's stream state.
const sessions = new Map<string, { transport: any; server: any }>();

async function createSession(): Promise<{ transport: any; server: any }> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // DNS-rebinding protection: only accept requests that present one of these Host
    // headers, matching the loopback-only posture already used by preview-server.ts.
    // Extend BPMN_MCP_HTTP_HOST/PORT together if you need to bind elsewhere.
    enableDnsRebindingProtection: true,
    allowedHosts: [`${HOST}:${PORT}`, `localhost:${PORT}`],
    onsessioninitialized: (sessionId: string) => {
      sessions.set(sessionId, { transport, server });
    },
    onsessionclosed: (sessionId: string) => {
      sessions.delete(sessionId);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await server.connect(transport);
  return { transport, server };
}

async function handleMcpRequest(request: any, response: any): Promise<void> {
  const sessionId = request.headers["mcp-session-id"];
  const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

  if (existing) {
    await existing.transport.handleRequest(request, response);
    return;
  }

  if (typeof sessionId === "string") {
    // Client presented a session id we don't recognise (process restarted, TTL expired,
    // etc.). Let the transport itself produce the SDK's standard "Session not found"
    // response rather than reimplementing that error shape here.
    const { transport } = await createSession();
    await transport.handleRequest(request, response);
    return;
  }

  // No session id: this must be an initialize request starting a brand-new session.
  const { transport } = await createSession();
  await transport.handleRequest(request, response);
}

function sendJson(response: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(payload);
}

const httpServer = http.createServer((request: any, response: any) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);

  if (url.pathname !== MCP_PATH) {
    sendJson(response, 404, { error: "Not found. The MCP endpoint is " + MCP_PATH });
    return;
  }

  void handleMcpRequest(request, response).catch((error: unknown) => {
    console.error("HTTP MCP request failed:", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal server error" });
    } else {
      response.end();
    }
  });
});

async function shutdown(): Promise<void> {
  await previewServer.stop();
  for (const { transport } of sessions.values()) {
    await transport.close().catch(() => {});
  }
  sessions.clear();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

startDiagramSweeper();

httpServer.listen(PORT, HOST, () => {
  console.log(`${pkg.name} v${pkg.version} listening on http://${HOST}:${PORT}${MCP_PATH}`);
  console.log("This process runs independently of any MCP client; leave it running and connect to it over HTTP.");
});

httpServer.on("error", (error: unknown) => {
  console.error("Fatal error starting HTTP MCP server:", error);
  process.exit(1);
});
