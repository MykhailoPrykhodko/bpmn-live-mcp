const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");
const { createClient } = require("./test-client");

async function withClient(options, fn) {
  const client = createClient(options);
  try {
    await client.initialize();
    await fn(client);
  } finally {
    client.child.kill();
  }
}

test("diagram name is stored and listed; delete frees the diagram and revokes modeler links", async () => {
  await withClient({}, async (c) => {
    const created = await c.tool("create_bpmn_diagram", { name: "Order flow" });
    assert.equal(created.name, "Order flow");

    const listed = await c.tool("list_bpmn_diagrams");
    assert.equal(listed.count, 1);
    assert.equal(listed.diagrams[0].name, "Order flow");
    assert.equal((await c.tool("inspect_bpmn_diagram", { diagramId: created.diagramId })).name, "Order flow");

    const opened = await c.tool("open_bpmn_modeler", { diagramId: created.diagramId });
    assert.equal((await fetch(`${opened.url}/xml`)).status, 200);

    await c.tool("delete_bpmn_diagram", { diagramId: created.diagramId });
    assert.equal((await c.tool("list_bpmn_diagrams")).count, 0);
    assert.equal((await fetch(`${opened.url}/xml`)).status, 404);

    const afterDelete = await c.raw("add_bpmn_element", { diagramId: created.diagramId, elementType: "bpmn:Task" });
    assert.match(afterDelete.error.message, /Diagram not found/);
    const again = await c.raw("delete_bpmn_diagram", { diagramId: created.diagramId });
    assert.match(again.error.message, /Diagram not found/);
  });
});

test("elements without coordinates are laid out left to right without overlapping", async () => {
  await withClient({}, async (c) => {
    const { diagramId } = await c.tool("create_bpmn_diagram");
    const start = await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:StartEvent", name: "Start" });
    const task = await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:UserTask", name: "Review" });
    const end = await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:EndEvent", name: "Done" });

    assert.ok(start.position.x < task.position.x && task.position.x < end.position.x);
    assert.equal(start.position.y, task.position.y);
    assert.equal(task.position.y, end.position.y);

    // Explicit coordinates still win, and a single coordinate can be overridden.
    const manual = await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:Task", x: 500, y: 400 });
    assert.deepEqual(manual.position, { x: 500, y: 400 });
    const partial = await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:Task", y: 50 });
    assert.equal(partial.position.y, 50);

    const listed = await c.tool("list_bpmn_elements", { diagramId });
    const shapes = listed.elements.filter((e) => e.width !== undefined && e.type !== "bpmn:SequenceFlow");
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i], b = shapes[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        assert.equal(overlap, false, `${a.id} overlaps ${b.id}`);
      }
    }
  });
});

test("boundary events attach to the host edge and artifacts sit above the flow", async () => {
  await withClient({}, async (c) => {
    const { diagramId } = await c.tool("create_bpmn_diagram");
    const task = await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:Task", name: "Work" });
    const boundary = await c.tool("add_bpmn_element", {
      diagramId, elementType: "bpmn:BoundaryEvent", hostElementId: task.elementId, eventDefinitionType: "bpmn:TimerEventDefinition",
    });
    const note = await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:TextAnnotation", name: "Note" });
    assert.equal(boundary.position.x, task.position.x);
    assert.ok(note.position.y < task.position.y);
  });
});

test("concurrent MCP edits are serialised and none are lost", async () => {
  await withClient({}, async (c) => {
    const { diagramId } = await c.tool("create_bpmn_diagram");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:Task", name: `Task ${i}` })),
    );
    assert.equal(new Set(results.map((r) => r.elementId)).size, 8);
    assert.equal(new Set(results.map((r) => r.position.x)).size, 8, "serialised adds must see each other for placement");

    const inspection = await c.tool("inspect_bpmn_diagram", { diagramId });
    assert.equal(inspection.counts["bpmn:Task"], 8);
    assert.equal(inspection.revision, 8);
  });
});

test("a delete racing with edits never corrupts state", async () => {
  await withClient({}, async (c) => {
    const { diagramId } = await c.tool("create_bpmn_diagram");
    const pending = [
      c.raw("add_bpmn_element", { diagramId, elementType: "bpmn:Task" }),
      c.raw("add_bpmn_element", { diagramId, elementType: "bpmn:Task" }),
      c.raw("delete_bpmn_diagram", { diagramId }),
      c.raw("add_bpmn_element", { diagramId, elementType: "bpmn:Task" }),
    ];
    const responses = await Promise.all(pending);
    for (const response of responses) {
      if (response.error) assert.match(response.error.message, /Diagram (was deleted|not found)/);
    }
    assert.equal((await c.tool("list_bpmn_diagrams")).count, 0);
  });
});

test("invalid XML import fails cleanly and does not register a diagram", async () => {
  await withClient({}, async (c) => {
    const bad = await c.raw("import_bpmn_xml", { xml: "<not-bpmn/>" });
    assert.ok(bad.error);
    const empty = await c.raw("import_bpmn_xml", { xml: "  " });
    assert.match(empty.error.message, /non-empty/);
    assert.equal((await c.tool("list_bpmn_diagrams")).count, 0);

    const { diagramId } = await c.tool("create_bpmn_diagram");
    await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:StartEvent" });
    const exported = await c.call("tools/call", { name: "export_bpmn_xml", arguments: { diagramId } });
    const xml = exported.result.content[0].text;
    const imported = await c.tool("import_bpmn_xml", { xml, name: "Round trip" });
    assert.equal(imported.name, "Round trip");
  });
});

test("diagram cap is enforced and freed by delete", async () => {
  await withClient({ env: { BPMN_MCP_MAX_DIAGRAMS: "2" } }, async (c) => {
    const a = await c.tool("create_bpmn_diagram");
    await c.tool("create_bpmn_diagram");
    const third = await c.raw("create_bpmn_diagram");
    assert.match(third.error.message, /Diagram limit reached/);

    await c.tool("delete_bpmn_diagram", { diagramId: a.diagramId });
    await c.tool("create_bpmn_diagram");
  });
});

test("idle diagrams expire after the configured TTL", async () => {
  await withClient({ env: { BPMN_MCP_DIAGRAM_TTL_MINUTES: "0.02" } }, async (c) => {
    const { diagramId } = await c.tool("create_bpmn_diagram");
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const response = await c.raw("inspect_bpmn_diagram", { diagramId });
    assert.match(response.error.message, /Diagram not found/);
  });
});

test("bpmn-js is resolved independent of the working directory", async () => {
  await withClient({ cwd: os.tmpdir() }, async (c) => {
    const { diagramId } = await c.tool("create_bpmn_diagram");
    await c.tool("add_bpmn_element", { diagramId, elementType: "bpmn:Task", name: "Long task name to exercise labels" });
    const svg = await c.call("tools/call", { name: "export_bpmn_svg", arguments: { diagramId } });
    assert.match(svg.result.content[0].text, /<svg/);
  });
});

// jsdom's default virtualConsole forwards jsdom-internal events (CSS parse warnings,
// unimplemented-API notices, script errors) to the real global `console`, which writes
// to process.stdout - the exact channel MCP's stdio transport uses to frame JSON-RPC
// messages. A single such event corrupts the stream and silently breaks every request
// after it (observed as generic client-side request timeouts on subsequent calls).
// This guards that every stdout line is well-formed JSON-RPC across a burst of the
// operations most likely to exercise jsdom's SVG/CSS code paths.
test("jsdom console events never corrupt the stdio JSON-RPC stream", async () => {
  const client = createClient();
  const stdoutLines = [];
  let stdoutBuffer = "";
  const malformedLines = [];

  client.child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let index;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line) continue;
      stdoutLines.push(line);
      try {
        JSON.parse(line);
      } catch {
        malformedLines.push(line);
      }
    }
  });

  try {
    await client.initialize();

    const diagrams = await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.tool("create_bpmn_diagram", { name: `stress-${i}` })),
    );
    await Promise.all(
      diagrams.map((d) =>
        client.tool("add_bpmn_element", { diagramId: d.diagramId, elementType: "bpmn:Task", name: "x" })),
    );
    await Promise.all(diagrams.map((d) => client.call("tools/call", { name: "export_bpmn_svg", arguments: { diagramId: d.diagramId } })));

    assert.ok(stdoutLines.length >= diagrams.length, "expected at least one JSON-RPC line per call");
    assert.deepEqual(malformedLines, [], "stdout must contain only well-formed JSON-RPC lines");
  } finally {
    client.child.kill();
  }
});
