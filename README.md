# BPMN Live MCP

A Model Context Protocol (MCP) server for creating and manipulating BPMN 2.0 workflow diagrams programmatically. This server enables AI assistants and other tools to generate, edit, and export business process diagrams in the standard BPMN format.

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

## Technical Details

### Architecture

- **Runtime**: Node.js with TypeScript
- **BPMN Engine**: bpmn-js (headless mode with jsdom)
- **Protocol**: Model Context Protocol (MCP)
- **Output**: BPMN 2.0 XML standard
- **Live UI**: Local HTTP modeler using the bpmn-js browser bundle

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

- [bpmn-js](https://bpmn.io/toolkit/bpmn-js/) - BPMN 2.0 rendering toolkit
- [Model Context Protocol](https://modelcontextprotocol.io/) - Protocol specification
