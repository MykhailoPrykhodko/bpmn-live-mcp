# BPMN Live MCP

A Model Context Protocol (MCP) server for creating and manipulating [BPMN 2.0](https://www.omg.org/spec/BPMN/2.0/) workflow diagrams programmatically. This server enables AI assistants and other tools to generate, edit, and export business process diagrams in the standard BPMN format.

![BPMN Diagram Example](./docs/images/bpmn.png)

## Features

- **Create BPMN Diagrams**: Generate new workflow diagrams from scratch
- **Add Process Elements**: Insert events, tasks, gateways, and subprocesses
- **Connect Elements**: Create sequence flows between workflow components
- **Export Formats**: Save diagrams as BPMN 2.0 XML or SVG
- **Import Support**: Load and modify existing BPMN XML files
- **Live Modeler**: Open a local bpmn-js modeler and explicitly save changes to the MCP session
- **Native Palette**: Use the full bpmn-js palette and context pad in the browser modeler
- **Smart Hints**: Get helpful nudges to ensure complete workflows with proper connections
- **Automatic Placement**: Elements added without coordinates are laid out left-to-right instead of stacking
- **Session Management**: List and delete diagrams; idle diagrams expire automatically

## Installation

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Local Setup

1. Clone the repository:
```bash
git clone https://github.com/MykhailoPrykhodko/bpmn-live-mcp.git
cd bpmn-live-mcp
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

## Configuration

### For Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bpmn": {
      "command": "node",
      "args": ["/absolute/path/to/bpmn-live-mcp/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/bpmn-live-mcp` with the actual path where you cloned this repository.

### For Other AI Tools

This MCP server works with any tool that supports the Model Context Protocol. Configure it to run:
```bash
node /absolute/path/to/bpmn-live-mcp/dist/index.js
```

### For OpenCode

Add the server to an OpenCode project configuration at `.opencode/opencode.json` or to the global OpenCode configuration at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bpmn": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "cwd": "/absolute/path/to/bpmn-live-mcp",
      "enabled": true
    }
  }
}
```

Use the absolute path to your local `bpmn-live-mcp` project in `cwd`. Build the server before using it:

```bash
npm install
npm run build
```

Restart OpenCode after changing its MCP configuration. You can then ask OpenCode to create, inspect, edit, or export BPMN diagrams using the `bpmn` MCP tools.

## Running as a Persistent Server (Recommended)

By default (`dist/index.js`), this MCP server runs over **stdio**: your AI client spawns it as a child process and owns its entire lifetime. If that client restarts, disconnects, or is killed, the server (and every open diagram/modeler session) dies with it - including any diagram you were actively editing in the live modeler.

For a more robust setup, run the server as a **standalone HTTP process** instead. Start it once, leave it running, and point any number of MCP clients at it over the network. Diagrams and modeler sessions then live in that one long-running process, independent of any single client connection.

### Starting the HTTP server

```bash
npm run build
npm run start:http
```

This starts an MCP server listening on `http://127.0.0.1:3939/mcp` (loopback only, by default). You'll see:

```text
bpmn-js-mcp v1.1.0 listening on http://127.0.0.1:3939/mcp
This process runs independently of any MCP client; leave it running and connect to it over HTTP.
```

Leave that terminal open (or run it under a process manager such as `pm2`, `nssm`, or a systemd/Windows service) and connect to it from your AI tool.

### Configuration

| Environment variable | Default | Description |
|---|---|---|
| `BPMN_MCP_HTTP_HOST` | `127.0.0.1` | Host to bind to. Keep this loopback-only unless you have a specific reason to expose it, since diagram editing has no authentication. |
| `BPMN_MCP_HTTP_PORT` | `3939` | Port to listen on. |
| `BPMN_MCP_DIAGRAM_TTL_MINUTES` | `1440` (24h) | Same as stdio mode: idle diagrams are freed after this long. |
| `BPMN_MCP_MAX_DIAGRAMS` | `50` | Same as stdio mode: cap on concurrently held diagrams. |

### Connecting OpenCode to the HTTP server

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bpmn": {
      "type": "remote",
      "url": "http://127.0.0.1:3939/mcp",
      "enabled": true
    }
  }
}
```

Unlike the `local` configuration above, OpenCode does not spawn or manage this process - it only connects to it. Start `npm run start:http` yourself, once, and it stays available across OpenCode restarts, new chat sessions, and even OpenCode crashes.

### Connecting other MCP clients

Any client that supports the MCP **Streamable HTTP** transport can connect the same way: point it at `http://127.0.0.1:3939/mcp`. The server issues a session id on `initialize` (via the `mcp-session-id` response header) and expects it echoed back on every subsequent request, per the standard MCP Streamable HTTP session lifecycle.

## Usage

Once configured, you can ask your AI assistant to create BPMN diagrams. Here are some example requests:

![Full Output Example](./docs/images/full-output.png)

### Creating a Simple Workflow

```
Create a BPMN diagram for an order processing workflow with these steps:
1. Order Received (start event)
2. Validate Order (user task)
3. Process Payment (service task)
4. Order Complete (end event)

Connect them with sequence flows.
```

![Query Example](./docs/images/query.png)

### Creating a Workflow with Decision Points

```
Create a BPMN diagram for customer support ticket routing:
- Start: Ticket Received
- Task: Categorize Ticket
- Gateway: Check Priority
  - If High: Escalate to Senior Support
  - If Normal: Assign to Support Team
- Both paths lead to: Ticket Resolved (end)
```

### Opening the Live Modeler

After creating or importing a diagram, open a browser-based modeler without exporting a file:

```
Open the live BPMN modeler for diagram diagram_123
```

The `open_bpmn_modeler` tool returns a local URL. Open that URL in a browser to edit the diagram with bpmn-js. Browser changes remain local until you click **Save** or press `Ctrl/Cmd + S`, then they are saved back to the active MCP diagram session.

The modeler includes local-file open and drag-and-drop, a guarded **New** action that resets the active diagram, undo/redo, zoom and fullscreen controls, keyboard shortcuts, and downloads for both `diagram.bpmn` and `diagram.svg`.

The modeler runs on loopback only (`127.0.0.1`). The URL is tokenized and expires after one hour. If MCP changes the diagram while the browser has unsaved edits, the modeler reports a conflict instead of overwriting the newer change.

To inspect the same live modeler session from chat, copy the token after `/modeler/` in the URL and call `inspect_bpmn_modeler`. The token is tied to the running MCP process and becomes invalid after that process restarts.

### Using the Modeler from OpenCode

1. Create or import a diagram in OpenCode:

```text
Create the archiving approval BPMN diagram and return its diagram ID.
```

2. Open the live modeler:

```text
Open the live BPMN modeler for diagram diagram_123
```

3. Open the returned local URL in a browser. Use the native bpmn-js palette and context pad to add tasks, events, gateways, lanes, participants, annotations, data objects, and connections.

4. Click **Save** in the modeler, or press `Ctrl+S` / `Cmd+S`. Edits remain local until explicitly saved.

5. Ask OpenCode to inspect the saved modeler session. Copy the token from the URL, which is the value after `/modeler/`:

```text
Inspect the live BPMN modeler using token 20a865e6d4217dade1c64448b9b9e2a70ad7dff5b615db14
```

OpenCode can use `inspect_bpmn_modeler` to resolve the token and read the latest diagram state. It can also use `inspect_bpmn_diagram` with the resolved diagram ID.

The modeler provides separate **Download BPMN** and **Download SVG** actions. These downloads do not replace the explicit MCP Save action.

## Available Tools

The MCP server provides these tools:

### `create_bpmn_diagram`
Creates a new BPMN diagram and returns a diagram ID.

### `add_bpmn_element`
Adds an element to the diagram. Supported types:
- Events: `bpmn:StartEvent`, `bpmn:EndEvent`, `bpmn:IntermediateCatchEvent`, `bpmn:IntermediateThrowEvent`
- Tasks: `bpmn:Task`, `bpmn:UserTask`, `bpmn:ServiceTask`, `bpmn:ScriptTask`, `bpmn:ManualTask`, `bpmn:BusinessRuleTask`, `bpmn:SendTask`, `bpmn:ReceiveTask`
- Gateways: `bpmn:ExclusiveGateway`, `bpmn:ParallelGateway`, `bpmn:InclusiveGateway`, `bpmn:EventBasedGateway`, `bpmn:ComplexGateway`
- Containers and artifacts: `bpmn:SubProcess`, `bpmn:CallActivity`, `bpmn:Participant`, `bpmn:Lane`, `bpmn:DataObjectReference`, `bpmn:DataStoreReference`, `bpmn:TextAnnotation`, `bpmn:Group`
- Boundary events: `bpmn:BoundaryEvent`

Use `parentElementId` for lanes and nested elements, `hostElementId` for boundary events, and `eventDefinitionType` for typed events.

### `connect_bpmn_elements`
Creates a BPMN connection between two elements. Supported connection types include sequence flows, message flows, associations, data associations, and conversation links.

### `export_bpmn_xml`
Exports the diagram as BPMN 2.0 XML format.

### `export_bpmn_svg`
Exports the diagram as SVG for visualization.

### `open_bpmn_modeler`
Starts a local browser-based bpmn-js modeler for a diagram and returns a tokenized URL. Browser edits are explicitly saved to the MCP session using revision checks.

### `close_bpmn_modeler`
Revokes a modeler URL before its normal expiration.

### `inspect_bpmn_modeler`
Resolves a live modeler URL token to its MCP diagram and returns the latest inspection data. Use the token from the URL when the diagram ID is not available in chat.

### `list_bpmn_elements`
Lists all current elements, connections, containers, relationships, and revision metadata, including browser modeler edits.

### `inspect_bpmn_diagram`
Returns a chat-friendly summary of the latest diagram state, including element counts, properties, relationships, revision, and the last modification source. Set `includeXml` to `true` to include normalized BPMN XML.

### `import_bpmn_xml`
Imports an existing BPMN XML file for editing.

### `list_bpmn_diagrams`

Lists the diagrams held in the current MCP session (ID, name, revision, timestamps).

### `delete_bpmn_diagram`

Deletes a diagram, frees its resources and revokes any open modeler links for it.

## Automatic Placement

`add_bpmn_element` accepts optional `x` / `y` (element centre). When they are omitted the server picks a position:

- Flow nodes continue left-to-right after the right-most flow node in the same container (process, participant, lane or sub-process), on the same row.
- Data objects, data stores, annotations and groups are placed above the flow.
- Boundary events attach to the bottom edge of their host.
- Participants stack vertically.

Branching flows (for example the two outgoing paths of a gateway) still need explicit `y` values to sit on separate rows. The response always reports the position that was used.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BPMN_MCP_DIAGRAM_TTL_MINUTES` | `1440` | Dispose diagrams that were idle this long (`0` disables expiry) |
| `BPMN_MCP_MAX_DIAGRAMS` | `50` | Maximum diagrams held at once (`0` disables the cap) |
| `BPMN_MCP_BUNDLE` | `production` | Set to `development` to load the unminified bpmn-js bundle for debugging |

## Example Output

The server generates standard BPMN 2.0 XML files that can be opened in:
- [Camunda Modeler](https://camunda.com/download/modeler/)
- [bpmn.io](https://bpmn.io/)
- Any BPMN 2.0 compliant tool

Example XML output:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                   xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                   xmlns:di="http://www.omg.org/spec/DD/20100524/DI">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Event_1" name="Start">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:task id="Task_1" name="Process">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:task>
    <bpmn:endEvent id="Event_2" name="End">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Event_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Event_2" />
  </bpmn:process>
  <!-- Diagram information omitted for brevity -->
</bpmn:definitions>
```

## Development

### Running in Development Mode

```bash
npm run watch
```

This will rebuild the project automatically when source files change.

### Testing

You can test the server manually using the MCP protocol:

```bash
node dist/index.js
```

Then send JSON-RPC requests via stdin. Example:
```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

Run the automated modeler and MCP integration tests with:

```bash
npm test
```

This includes `http-server.test.js`, which spawns `dist/http-server.js` as a real subprocess and drives it over the MCP Streamable HTTP protocol - the same code path used in [Running as a Persistent Server](#running-as-a-persistent-server-recommended).

## Technical Details

### Architecture

- **Runtime**: Node.js with TypeScript
- **BPMN Engine**: bpmn-js (headless mode with jsdom)
- **Protocol**: Model Context Protocol (MCP)
- **Output**: BPMN 2.0 XML standard
- **Live UI**: Local HTTP modeler using the bpmn-js browser bundle
- **Entry points**: `src/index.ts` (stdio, client-spawned) and `src/http-server.ts` (persistent HTTP server, see [Running as a Persistent Server](#running-as-a-persistent-server-recommended)) both build on the shared engine in `src/mcp-server.ts`, so tool behavior is identical regardless of transport.

### Smart Workflow Hints

The server includes helpful hints to ensure complete diagrams:
- Reminds you to connect elements when adding tasks/events
- Warns when exporting diagrams with disconnected elements
- Suggests using `connect_bpmn_elements` to create proper workflows

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Support

For issues or questions:
- Open an issue on GitHub
- Check existing issues for solutions

## Related Projects

- [BPMN 2.0 specification (OMG)](https://www.omg.org/spec/BPMN/2.0/) - The standard this server produces
- [bpmn.io](https://bpmn.io/) - Open-source BPMN tooling, including a [web modeler](https://demo.bpmn.io/) for viewing exported diagrams
- [bpmn-js](https://bpmn.io/toolkit/bpmn-js/) - BPMN 2.0 rendering toolkit
- [Model Context Protocol](https://modelcontextprotocol.io/) - Protocol specification

## Changes

### 1.2.0

**Bug fixes**

- **stdio corruption / "MCP error -32001" on every call after the first diagram:** `jsdom`'s default virtual console forwarded jsdom-internal events (CSS/SVG warnings, unimplemented-API notices) straight to Node's real `console`, which writes to `process.stdout` - the exact byte stream the stdio MCP transport uses to frame JSON-RPC. A single such event corrupted the stream and made every later response unparseable to the client (visible as generic request timeouts starting right after the first `create_bpmn_diagram`). jsdom's console is now routed to `console.error` (stderr) instead, so it can never interleave with JSON-RPC on stdout.
- **A single stuck diagram operation could wedge the whole diagram forever:** every operation on a diagram is serialised through a per-diagram lock; there was no bound on how long a locked operation could run, so one hung `import`/`saveXML` call blocked every later request on that diagram indefinitely (observed as sockets piling up in `CLOSE_WAIT` and the browser modeler's own requests failing with "signal is aborted without reason" after its 10s timeout). Locked operations are now bounded by `BPMN_MCP_OPERATION_TIMEOUT_MS` (default 20s); a stuck operation now fails cleanly and releases the lock instead of blocking the diagram forever.

**Additions**

- **New HTTP transport (`src/http-server.ts`, `npm run start:http`):** run the server as a persistent local process that any number of MCP clients connect to over `http://127.0.0.1:3939/mcp`, instead of each client spawning and owning it over stdio. This decouples diagram/modeler session lifetime from any single client connection - the concrete case reported was a live modeler session dying after roughly ten minutes; the underlying stdio process was proven stable well past that window in isolation (an 11-minute soak test with periodic tool calls never failed), so the death was in how the *client* hosted the child process, not in the server itself. Running the server out-of-process via HTTP sidesteps that entirely: a soak test against the HTTP transport ran the browser modeler's exact polling pattern (one `GET /xml` per second) for 10.5 minutes with zero failures, then a save. See [Running as a Persistent Server](#running-as-a-persistent-server-recommended).
- Server-side logic is now shared between both entry points via `src/mcp-server.ts` (`createMcpServer()` + `startDiagramSweeper()`), so tool behavior is identical over stdio and HTTP; `src/index.ts` is now a thin stdio entry point.

**Tests**

- New `http-server.test.js` (with `test-http-client.js`) covering: initialize / list tools / round-trip a diagram over HTTP, diagram state shared across independent MCP sessions on one server process, graceful handling of an unrecognised session id, and survival across multiple calls spread over several seconds. `npm test` now runs 16 tests across 4 files.
- New `mcp-patches.test.js` stress test that bursts diagram creation/element-add/export in parallel and asserts every line on stdout is well-formed JSON-RPC, guarding the stdio-corruption fix above.

### 1.1.0

**Bug fixes**

- **Concurrency:** every operation on a diagram (add, connect, export, list, inspect, import-related saves, browser saves) now runs under the per-diagram lock. Previously only browser saves and `list` / `inspect` were locked, so an MCP edit could land on a modeler that a browser save had just replaced and be lost.
- **Diagram names:** `create_bpmn_diagram`'s `name` is now stored and returned by `create`, `list_bpmn_elements`, `inspect_bpmn_diagram` and `list_bpmn_diagrams`. `import_bpmn_xml` also accepts an optional `name`.
- **Element stacking:** elements added without `x` / `y` are placed automatically (see [Automatic Placement](#automatic-placement)) instead of all landing at (100, 100). The response reports the actual position.
- **Resource leaks:** replaced or deleted modelers are destroyed and their canvases removed from the jsdom document. Failed XML imports (via MCP or the browser Save) no longer leave an orphaned canvas behind.
- **bpmn-js resolution:** the bundle is located with `require.resolve` instead of a hard-coded `../node_modules` path, so hoisted, global and `npx` installs work. It now loads the production bundle by default.

**Additions**

- New tools `list_bpmn_diagrams` and `delete_bpmn_diagram`; deleting a diagram also revokes its modeler URLs (`PreviewServer.closeForDiagram`).
- Idle diagram expiry and a diagram-count cap, configurable through environment variables (see above).
- Deleted or expired diagrams return a clear `Diagram was deleted` / `Diagram not found` error, including for operations that were queued when the delete happened.
- `import_bpmn_xml` rejects empty input with a clear error.
- Diagram IDs use `crypto.randomUUID()` instead of `Math.random()`.
- The MCP server name and version are read from `package.json`.
- Links to the BPMN 2.0 specification and bpmn.io added to the introduction and Related Projects.

**Removed**

- The unused `elementIdMap` state field.

**Tests**

- New `mcp-patches.test.js` (with a shared `test-client.js`) covering names and listing, delete and link revocation, auto-placement and overlap, boundary events and artifacts, concurrent edits, delete racing with edits, invalid imports, the diagram cap, TTL expiry, and running from a different working directory. `npm test` runs all suites (11 tests).

**Not changed (candidates for a later release)**

- Tool arguments are still cast with `as any` rather than validated with a schema library.
- The XML is still re-serialised after each mutation.
- Element update, delete and move tools, a validation tool, batch creation, and persistence across restarts.
- CI workflow, committing `package-lock.json`, and the `bpmn-js-mcp` vs `bpmn-live-mcp` naming mismatch.
