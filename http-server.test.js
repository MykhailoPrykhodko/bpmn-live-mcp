const assert = require("node:assert/strict");
const test = require("node:test");
const { createHttpClient, createConnectedClient } = require("./test-http-client");

async function withHttpClient(options, fn) {
  const client = createHttpClient(options);
  try {
    await client.initialize();
    await fn(client);
  } finally {
    client.kill();
  }
}

test("HTTP transport: initialize, list tools, and round-trip a diagram", async () => {
  await withHttpClient({}, async (c) => {
    assert.ok(c.sessionId, "server must issue a session id on initialize");

    const tools = await c.listTools();
    assert.ok(tools.some((t) => t.name === "create_bpmn_diagram"));
    assert.ok(tools.some((t) => t.name === "open_bpmn_modeler"));

    const created = await c.tool("create_bpmn_diagram", { name: "HTTP diagram" });
    assert.equal(created.name, "HTTP diagram");

    const listed = await c.tool("list_bpmn_diagrams");
    assert.equal(listed.count, 1);

    const opened = await c.tool("open_bpmn_modeler", { diagramId: created.diagramId });
    const xmlResponse = await fetch(`${opened.url}/xml`);
    assert.equal(xmlResponse.status, 200);
  });
});

test("HTTP transport: diagrams are shared across sessions in the same server process", async () => {
  const client = createHttpClient({});
  try {
    await client.initialize();
    const created = await client.tool("create_bpmn_diagram", { name: "shared" });

    // Simulate a second, independent MCP client connecting to the same already-running
    // process (no new server spawned) - same port, different negotiated session id.
    const second = createConnectedClient(client.baseUrl);
    await second.initialize();
    assert.notEqual(second.sessionId, client.sessionId, "each client must get its own MCP session");
    const inspected = await second.tool("inspect_bpmn_diagram", { diagramId: created.diagramId });
    assert.equal(inspected.name, "shared");
  } finally {
    client.kill();
  }
});

test("HTTP transport: an unrecognised session id gets a fresh session instead of hanging", async () => {
  await withHttpClient({}, async (c) => {
    const { message } = await c.rawCall("tools/call", { name: "list_bpmn_diagrams", arguments: {} }, {
      "mcp-session-id": "00000000-0000-0000-0000-000000000000",
    });
    // Either a clean tool result (server issued a brand-new session for the request) or
    // a well-formed JSON-RPC error - never a hang and never raw HTML/garbage.
    assert.ok(message.jsonrpc === "2.0");
  });
});

test("HTTP transport: server survives well past a single request's timeout window", async () => {
  await withHttpClient({}, async (c) => {
    const created = await c.tool("create_bpmn_diagram", { name: "longevity" });
    // Five calls spread over several seconds - a fast smoke-test stand-in for the
    // multi-minute manual soak test that reproduced (and disproved, for this transport)
    // the originally reported ~10-minute modeler death.
    for (let i = 0; i < 5; i++) {
      const inspected = await c.tool("inspect_bpmn_diagram", { diagramId: created.diagramId });
      assert.equal(inspected.name, "longevity");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });
});
