const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");

function createClient() {
  const child = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
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
      setTimeout(() => reject(new Error(`Timed out calling ${method}`)), 20000);
    });
  }

  return { child, call };
}

function toolJson(response) {
  return JSON.parse(response.result.content[0].text);
}

test("MCP exposes palette-created elements to inspection", async () => {
  const client = createClient();

  try {
    await client.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "1" },
    });
    client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

    const created = toolJson(await client.call("tools/call", {
      name: "create_bpmn_diagram",
      arguments: { name: "Palette integration test" },
    }));

    const opened = toolJson(await client.call("tools/call", {
      name: "open_bpmn_modeler",
      arguments: { diagramId: created.diagramId },
    }));

    const modelerInspection = toolJson(await client.call("tools/call", {
      name: "inspect_bpmn_modeler",
      arguments: { token: opened.token },
    }));
    assert.equal(modelerInspection.diagramId, created.diagramId);
    assert.equal(modelerInspection.modelerToken, opened.token);

    const participant = toolJson(await client.call("tools/call", {
      name: "add_bpmn_element",
      arguments: { diagramId: created.diagramId, elementType: "bpmn:Participant", name: "Operations" },
    }));

    const lane = toolJson(await client.call("tools/call", {
      name: "add_bpmn_element",
      arguments: {
        diagramId: created.diagramId,
        elementType: "bpmn:Lane",
        parentElementId: participant.elementId,
        name: "Infrastructure",
      },
    }));

    await client.call("tools/call", {
      name: "add_bpmn_element",
      arguments: {
        diagramId: created.diagramId,
        elementType: "bpmn:DataObjectReference",
        name: "Approval request",
      },
    });

    await client.call("tools/call", {
      name: "add_bpmn_element",
      arguments: {
        diagramId: created.diagramId,
        elementType: "bpmn:TextAnnotation",
        name: "Review all required sign-offs",
      },
    });

    const start = toolJson(await client.call("tools/call", {
      name: "add_bpmn_element",
      arguments: {
        diagramId: created.diagramId,
        elementType: "bpmn:StartEvent",
        parentElementId: lane.elementId,
        name: "Start review",
      },
    }));

    const task = toolJson(await client.call("tools/call", {
      name: "add_bpmn_element",
      arguments: {
        diagramId: created.diagramId,
        elementType: "bpmn:UserTask",
        parentElementId: lane.elementId,
        name: "Review request",
      },
    }));

    await client.call("tools/call", {
      name: "connect_bpmn_elements",
      arguments: {
        diagramId: created.diagramId,
        sourceElementId: start.elementId,
        targetElementId: task.elementId,
        connectionType: "bpmn:SequenceFlow",
      },
    });

    const currentXmlResponse = await fetch(`${opened.url}/xml`);
    const currentXml = await currentXmlResponse.text();
    const savedXmlResponse = await fetch(`${opened.url}/xml`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/xml",
        "If-Match": currentXmlResponse.headers.get("etag"),
      },
      body: currentXml,
    });
    assert.equal(savedXmlResponse.status, 200);

    const inspection = toolJson(await client.call("tools/call", {
      name: "inspect_bpmn_diagram",
      arguments: { diagramId: created.diagramId },
    }));

    assert.equal(participant.elementType, "bpmn:Participant");
    assert.equal(lane.elementType, "bpmn:Lane");
    assert.equal(inspection.lastModifiedSource, "modeler");
    assert.equal(inspection.counts["bpmn:Participant"], 1);
    assert.ok(inspection.counts["bpmn:Lane"] >= 1);
    assert.equal(inspection.counts["bpmn:DataObjectReference"], 1);
    assert.equal(inspection.counts["bpmn:TextAnnotation"], 1);
    assert.equal(inspection.counts["bpmn:SequenceFlow"], 1);
    assert.ok(inspection.elements.some((element) => element.sourceId === start.elementId && element.targetId === task.elementId));
    assert.ok(inspection.elements.some((element) => element.parentId === participant.elementId));

    await client.call("tools/call", {
      name: "close_bpmn_modeler",
      arguments: { token: opened.token },
    });
  } finally {
    client.child.kill();
  }
});
