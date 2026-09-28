const { spawn } = require("node:child_process");
const path = require("node:path");

const SERVER = path.join(__dirname, "dist", "http-server.js");

/**
 * Extracts the first `data: {...}` SSE line from a Streamable HTTP response body and
 * parses it as JSON-RPC. The HTTP transport wraps every response as a one-shot SSE
 * event even for simple request/response calls, so this is the standard way to read it.
 */
function parseSseJson(body) {
  const match = body.match(/^data:\s*(.+)$/m);
  if (!match) throw new Error(`No SSE data line found in response: ${body.slice(0, 300)}`);
  return JSON.parse(match[1]);
}

/**
 * Spawns http-server.js as a real child process on `port` (random free port if omitted)
 * and returns a minimal MCP-over-HTTP client bound to it. Mirrors createClient() in
 * test-client.js (the stdio equivalent) so the two test suites read the same way.
 */
function createHttpClient({ env = {}, port } = {}) {
  const boundPort = port ?? 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, BPMN_MCP_HTTP_PORT: String(boundPort) },
  });

  let stderrBuffer = "";
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${boundPort}/mcp`;
  let sessionId;
  let nextId = 1;

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
  });

  /** Waits for the server's synchronous startup log line on stdout. */
  function waitForListening(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (/listening on/.test(stdoutBuffer)) return resolve();
        if (child.exitCode !== null) return reject(new Error(`http-server exited early: ${stderrBuffer || stdoutBuffer}`));
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for http-server to start: ${stderrBuffer || stdoutBuffer}`));
        setTimeout(check, 50);
      };
      check();
    });
  }

  async function rawCall(method, params, extraHeaders = {}) {
    const id = nextId++;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extraHeaders,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const response = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) sessionId = newSessionId;

    const text = await response.text();
    return { status: response.status, response, message: text ? parseSseJson(text) : undefined };
  }

  async function notify(method, params) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  }

  async function initialize() {
    await waitForListening();
    const { message } = await rawCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "http-test", version: "1" },
    });
    if (message.error) throw new Error(`initialize failed: ${message.error.message}`);
    await notify("notifications/initialized", {});
    return message.result;
  }

  async function raw(name, args = {}) {
    const { message } = await rawCall("tools/call", { name, arguments: args });
    return message;
  }

  async function tool(name, args = {}) {
    const message = await raw(name, args);
    if (message.error) throw new Error(message.error.message);
    return JSON.parse(message.result.content[0].text);
  }

  async function listTools() {
    const { message } = await rawCall("tools/list", {});
    if (message.error) throw new Error(message.error.message);
    return message.result.tools;
  }

  function kill() {
    child.kill();
  }

  return { child, baseUrl, initialize, tool, raw, listTools, rawCall, kill, get sessionId() { return sessionId; } };
}

/**
 * Builds an HTTP-only client bound to an already-running server (no spawn). Use this to
 * simulate a second, independent MCP client connecting to a server started by another
 * createHttpClient() call.
 */
function createConnectedClient(baseUrl) {
  let sessionId;
  let nextId = 1;

  async function rawCall(method, params, extraHeaders = {}) {
    const id = nextId++;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extraHeaders,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const response = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) sessionId = newSessionId;

    const text = await response.text();
    return { status: response.status, response, message: text ? parseSseJson(text) : undefined };
  }

  async function notify(method, params) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  }

  async function initialize() {
    const { message } = await rawCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "http-test-second", version: "1" },
    });
    if (message.error) throw new Error(`initialize failed: ${message.error.message}`);
    await notify("notifications/initialized", {});
    return message.result;
  }

  async function tool(name, args = {}) {
    const { message } = await rawCall("tools/call", { name, arguments: args });
    if (message.error) throw new Error(message.error.message);
    return JSON.parse(message.result.content[0].text);
  }

  return { baseUrl, initialize, tool, rawCall, get sessionId() { return sessionId; } };
}

module.exports = { createHttpClient, createConnectedClient, parseSseJson };
