const { spawn } = require("node:child_process");
const path = require("node:path");

const SERVER = path.join(__dirname, "dist", "index.js");

/** Spawns the MCP server over stdio and returns a tiny JSON-RPC client. */
function createClient({ env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, ...env },
  });
  let buffer = "";
  let nextId = 1;
  const waiters = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (!message.id || !waiters.has(message.id)) continue;
      const resolve = waiters.get(message.id);
      waiters.delete(message.id);
      resolve(message);
    }
  });
  child.stderr.on("data", () => {});

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`Timed out calling ${method}`)), 30000);
    });
  }

  async function initialize() {
    await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }

  /** Calls a tool and returns the parsed JSON payload (throws on MCP errors). */
  async function tool(name, args = {}) {
    const response = await call("tools/call", { name, arguments: args });
    if (response.error) throw new Error(response.error.message);
    return JSON.parse(response.result.content[0].text);
  }

  /** Calls a tool and returns the raw JSON-RPC response (for asserting on errors). */
  function raw(name, args = {}) {
    return call("tools/call", { name, arguments: args });
  }

  return { child, call, initialize, tool, raw };
}

module.exports = { createClient };
