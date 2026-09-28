#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} = require("@modelcontextprotocol/sdk/types.js");
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const { PreviewServer, PreviewConflictError } = require("./preview-server");

let BpmnModeler: any;
let jsdomInstance: any;

interface DiagramState {
  modeler: any;
  xml: string;
  revision: number;
  lastModifiedAt: string;
  lastModifiedSource: "mcp" | "modeler";
  elementIdMap: Map<string, string>;
  operation: Promise<void>;
}

// In-memory storage for diagrams (keyed by diagram ID)
const diagrams = new Map<string, DiagramState>();

async function withDiagramLock<T>(diagram: DiagramState, action: () => Promise<T>): Promise<T> {
  const previous = diagram.operation;
  let release!: () => void;
  diagram.operation = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

const previewServer = new PreviewServer((diagramId: string) => {
  const diagram = diagrams.get(diagramId);
  if (!diagram) return undefined;

  return {
    getXml: () => withDiagramLock(diagram, async () => {
      const { xml } = await diagram.modeler.saveXML({ format: true });
      diagram.xml = xml || "";
      return { xml: diagram.xml, revision: diagram.revision };
    }),
    saveXml: (xml: string, expectedRevision: number) => withDiagramLock(diagram, async () => {
      if (expectedRevision !== diagram.revision) {
        throw new PreviewConflictError(diagram.revision);
      }

      const replacementModeler = new BpmnModeler({ container: createHeadlessCanvas() });
      await replacementModeler.importXML(xml);
      const saved = await replacementModeler.saveXML({ format: true });
      const previousModeler = diagram.modeler;
      diagram.modeler = replacementModeler;
      previousModeler.destroy?.();
      diagram.xml = saved.xml || "";
      markDiagramModified(diagram, "modeler");
      diagram.elementIdMap.clear();

      return { xml: diagram.xml, revision: diagram.revision };
    }),
  };
});

// Create a headless canvas for bpmn-js
function createHeadlessCanvas(): any {
  if (!jsdomInstance) {
    // Load the browser bundle
    const bpmnJsPath = path.join(__dirname, '../node_modules/bpmn-js/dist/bpmn-modeler.development.js');
    const bpmnJsBundle = fs.readFileSync(bpmnJsPath, 'utf-8');

    // Create jsdom with the script
    jsdomInstance = new JSDOM(
      "<!DOCTYPE html><html><body><div id='canvas'></div></body></html>",
      { runScripts: "outside-only" }
    );

    // Add CSS polyfill
    (jsdomInstance.window as any).CSS = {
      escape: (str: string) => str.replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, '\\$&')
    };

    // Add structuredClone polyfill
    if (!(jsdomInstance.window as any).structuredClone) {
      (jsdomInstance.window as any).structuredClone = function(obj: any) {
        return JSON.parse(JSON.stringify(obj));
      };
    }

    // Add SVGMatrix constructor
    (jsdomInstance.window as any).SVGMatrix = function() {
      return {
        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
        inverse: function() { return this; },
        multiply: function() { return this; },
        translate: function(x: number, y: number) {
          this.e += x;
          this.f += y;
          return this;
        },
        scale: function(s: number) {
          this.a *= s;
          this.d *= s;
          return this;
        }
      };
    };

    // Add SVG polyfills
    const SVGElement = jsdomInstance.window.SVGElement;
    const SVGGraphicsElement = (jsdomInstance.window as any).SVGGraphicsElement;

    // Polyfill getBBox
    if (SVGElement && !SVGElement.prototype.getBBox) {
      SVGElement.prototype.getBBox = function() {
        return { x: 0, y: 0, width: 100, height: 100 };
      };
    }

    // Polyfill getScreenCTM
    if (SVGElement && !SVGElement.prototype.getScreenCTM) {
      SVGElement.prototype.getScreenCTM = function() {
        return {
          a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
          inverse: function() { return this; },
          multiply: function() { return this; },
          translate: function() { return this; }
        };
      };
    }

    // Polyfill transform property
    const transformProp = {
      get: function(this: any): any {
        if (!this._transform) {
          const transformList = {
            numberOfItems: 0,
            _items: [] as any[],
            consolidate: function() { return null; },
            clear: function() {
              this._items = [];
              this.numberOfItems = 0;
            },
            initialize: function(newItem: any) {
              this._items = [newItem];
              this.numberOfItems = 1;
              return newItem;
            },
            getItem: function(index: number) {
              return this._items[index];
            },
            insertItemBefore: function(newItem: any, index: number) {
              this._items.splice(index, 0, newItem);
              this.numberOfItems = this._items.length;
              return newItem;
            },
            replaceItem: function(newItem: any, index: number) {
              this._items[index] = newItem;
              return newItem;
            },
            removeItem: function(index: number) {
              const item = this._items.splice(index, 1)[0];
              this.numberOfItems = this._items.length;
              return item;
            },
            appendItem: function(newItem: any) {
              this._items.push(newItem);
              this.numberOfItems = this._items.length;
              return newItem;
            },
            createSVGTransformFromMatrix: function(matrix: any) {
              return { type: 1, matrix, angle: 0 };
            }
          };
          this._transform = {
            baseVal: transformList,
            animVal: transformList
          };
        }
        return this._transform;
      }
    };

    if (SVGGraphicsElement) {
      Object.defineProperty(SVGGraphicsElement.prototype, 'transform', transformProp);
    }
    if (SVGElement) {
      Object.defineProperty(SVGElement.prototype, 'transform', transformProp);
    }

    // Polyfill createSVGMatrix and createSVGTransform for SVGSVGElement
    const SVGSVGElement = (jsdomInstance.window as any).SVGSVGElement;
    if (SVGSVGElement) {
      if (!SVGSVGElement.prototype.createSVGMatrix) {
        SVGSVGElement.prototype.createSVGMatrix = function() {
          return {
            a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
            inverse: function() { return this; },
            multiply: function() { return this; },
            translate: function(x: number, y: number) { return this; },
            scale: function(s: number) { return this; }
          };
        };
      }
      if (!SVGSVGElement.prototype.createSVGTransform) {
        SVGSVGElement.prototype.createSVGTransform = function() {
          return {
            type: 0,
            matrix: this.createSVGMatrix(),
            angle: 0,
            setMatrix: function(matrix: any) {},
            setTranslate: function(tx: number, ty: number) {},
            setScale: function(sx: number, sy: number) {},
            setRotate: function(angle: number, cx: number, cy: number) {}
          };
        };
      }
    }

    // Execute the bundle in the jsdom context
    jsdomInstance.window.eval(bpmnJsBundle);

    // Set globals (don't set navigator as it's read-only)
    (global as any).document = jsdomInstance.window.document;
    (global as any).window = jsdomInstance.window;

    // Get BpmnModeler from the window object
    BpmnModeler = (jsdomInstance.window as any).BpmnJS;
  }

  const canvas = jsdomInstance.window.document.createElement("div");
  canvas.className = "bpmn-headless-canvas";
  jsdomInstance.window.document.body.appendChild(canvas);
  return canvas;
}

// Create a new BPMN modeler instance
async function createModeler(): Promise<any> {
  const container = createHeadlessCanvas();
  const modeler = new BpmnModeler({ container });

  // Create a minimal BPMN diagram
  const initialXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                   xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                   xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                   id="Definitions_1"
                   targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  await modeler.importXML(initialXml);
  return modeler;
}

// Generate a unique diagram ID
function generateDiagramId(): string {
  return `diagram_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getDiagramElements(diagram: DiagramState): any[] {
  const elementRegistry = diagram.modeler.get("elementRegistry");
  return elementRegistry.filter((element: any) => {
    return element.type &&
      element.type !== "bpmn:Process" &&
      element.type !== "bpmn:Collaboration" &&
      element.type !== "label" &&
      !element.type.includes("BPMNDiagram");
  });
}

function getDocumentation(element: any): string[] {
  return (element.businessObject?.documentation || [])
    .map((entry: any) => entry.text)
    .filter((text: any): text is string => typeof text === "string");
}

function summarizeElement(element: any): Record<string, any> {
  const businessObject = element.businessObject || {};
  const eventDefinitions = (businessObject.eventDefinitions || [])
    .map((definition: any) => definition.$type)
    .filter(Boolean);
  const extensionTypes = (businessObject.extensionElements?.values || [])
    .map((extension: any) => extension.$type)
    .filter(Boolean);

  return {
    id: element.id,
    type: businessObject.$type || element.type,
    name: businessObject.name || "(unnamed)",
    parentId: element.parent?.id,
    hostId: element.host?.id || businessObject.attachedToRef?.id,
    sourceId: element.source?.id,
    targetId: element.target?.id,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    properties: {
      documentation: getDocumentation(element),
      eventDefinitions,
      extensionTypes,
      isExpanded: element.collapsed === undefined ? undefined : !element.collapsed,
      isInterrupting: businessObject.isInterrupting,
      cancelActivity: businessObject.cancelActivity,
      isForCompensation: businessObject.isForCompensation,
      triggeredByEvent: businessObject.triggeredByEvent,
      calledElement: businessObject.calledElement,
    },
  };
}

function markDiagramModified(diagram: DiagramState, source: "mcp" | "modeler" = "mcp"): void {
  diagram.revision += 1;
  diagram.lastModifiedAt = new Date().toISOString();
  diagram.lastModifiedSource = source;
}

function diagramInspection(diagramId: string, diagram: DiagramState, includeXml: boolean): Record<string, any> {
  const elements = getDiagramElements(diagram).map(summarizeElement);
  const counts: Record<string, number> = {};

  for (const element of elements) {
    counts[element.type] = (counts[element.type] || 0) + 1;
  }

  const inspection: Record<string, any> = {
    success: true,
    diagramId,
    revision: diagram.revision,
    lastModifiedAt: diagram.lastModifiedAt,
    lastModifiedSource: diagram.lastModifiedSource,
    elementCount: elements.length,
    counts,
    elements,
  };

  if (includeXml) {
    inspection.xml = diagram.xml;
  }

  return inspection;
}

const server = new Server(
  {
    name: "bpmn-js-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_bpmn_diagram",
        description: "Create a new BPMN diagram. Returns a diagram ID that can be used with other tools.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Optional name for the diagram",
            },
          },
        },
      },
      {
        name: "add_bpmn_element",
        description: "Add an element (task, gateway, event, etc.) to a BPMN diagram",
        inputSchema: {
          type: "object",
          properties: {
            diagramId: {
              type: "string",
              description: "The diagram ID returned from create_bpmn_diagram",
            },
            elementType: {
              type: "string",
              enum: [
                "bpmn:StartEvent",
                "bpmn:EndEvent",
                "bpmn:BoundaryEvent",
                "bpmn:Task",
                "bpmn:UserTask",
                "bpmn:ServiceTask",
                "bpmn:ScriptTask",
                "bpmn:ManualTask",
                "bpmn:BusinessRuleTask",
                "bpmn:SendTask",
                "bpmn:ReceiveTask",
                "bpmn:ExclusiveGateway",
                "bpmn:ParallelGateway",
                "bpmn:InclusiveGateway",
                "bpmn:EventBasedGateway",
                "bpmn:ComplexGateway",
                "bpmn:IntermediateCatchEvent",
                "bpmn:IntermediateThrowEvent",
                "bpmn:SubProcess",
                "bpmn:CallActivity",
                "bpmn:DataObjectReference",
                "bpmn:DataStoreReference",
                "bpmn:TextAnnotation",
                "bpmn:Group",
                "bpmn:Participant",
                "bpmn:Lane",
              ],
              description: "The type of BPMN element to add",
            },
            name: {
              type: "string",
              description: "The name/label for the element",
            },
            x: {
              type: "number",
              description: "X coordinate for the element (default: 100)",
            },
            y: {
              type: "number",
              description: "Y coordinate for the element (default: 100)",
            },
            parentElementId: {
              type: "string",
              description: "Optional parent container ID, required for lanes and nested elements",
            },
            hostElementId: {
              type: "string",
              description: "Host element ID for boundary events",
            },
            isExpanded: {
              type: "boolean",
              description: "Whether a subprocess or participant is expanded",
            },
            eventDefinitionType: {
              type: "string",
              description: "Optional event definition type, for example bpmn:TimerEventDefinition",
            },
          },
          required: ["diagramId", "elementType"],
        },
      },
      {
        name: "connect_bpmn_elements",
        description: "Connect two BPMN elements with a BPMN connection",
        inputSchema: {
          type: "object",
          properties: {
            diagramId: {
              type: "string",
              description: "The diagram ID",
            },
            sourceElementId: {
              type: "string",
              description: "The ID of the source element",
            },
            targetElementId: {
              type: "string",
              description: "The ID of the target element",
            },
            label: {
              type: "string",
              description: "Optional label for the connection",
            },
            connectionType: {
              type: "string",
              enum: [
                "bpmn:SequenceFlow",
                "bpmn:MessageFlow",
                "bpmn:Association",
                "bpmn:DataInputAssociation",
                "bpmn:DataOutputAssociation",
                "bpmn:ConversationLink",
              ],
              description: "BPMN connection type (defaults to bpmn:SequenceFlow)",
            },
          },
          required: ["diagramId", "sourceElementId", "targetElementId"],
        },
      },
      {
        name: "export_bpmn_xml",
        description: "Export a BPMN diagram as XML",
        inputSchema: {
          type: "object",
          properties: {
            diagramId: {
              type: "string",
              description: "The diagram ID",
            },
          },
          required: ["diagramId"],
        },
      },
      {
        name: "export_bpmn_svg",
        description: "Export a BPMN diagram as SVG",
        inputSchema: {
          type: "object",
          properties: {
            diagramId: {
              type: "string",
              description: "The diagram ID",
            },
          },
          required: ["diagramId"],
        },
      },
      {
        name: "open_bpmn_modeler",
        description: "Open a live local bpmn-js modeler for a BPMN diagram. Browser edits are saved to the MCP session when the user clicks Save.",
        inputSchema: {
          type: "object",
          properties: {
            diagramId: {
              type: "string",
              description: "The diagram ID",
            },
            openBrowser: {
              type: "boolean",
              description: "Open the returned modeler URL in the default browser",
              default: false,
            },
          },
          required: ["diagramId"],
        },
      },
      {
        name: "close_bpmn_modeler",
        description: "Close a live local bpmn-js modeler preview URL",
        inputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description: "The preview token returned by open_bpmn_modeler",
            },
          },
          required: ["token"],
        },
      },
      {
        name: "inspect_bpmn_modeler",
        description: "Inspect the latest diagram state behind a live bpmn-js modeler URL using its preview token",
        inputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description: "The preview token from the modeler URL or open_bpmn_modeler",
            },
            includeXml: {
              type: "boolean",
              description: "Include the complete normalized BPMN XML",
              default: false,
            },
          },
          required: ["token"],
        },
      },
      {
        name: "list_bpmn_elements",
        description: "List all current BPMN elements, connections, containers, and relationships",
        inputSchema: {
          type: "object",
          properties: {
            diagramId: {
              type: "string",
              description: "The diagram ID",
            },
          },
          required: ["diagramId"],
        },
      },
      {
        name: "inspect_bpmn_diagram",
        description: "Inspect the latest BPMN diagram state, including edits saved from the browser modeler",
        inputSchema: {
          type: "object",
          properties: {
            diagramId: {
              type: "string",
              description: "The diagram ID",
            },
            includeXml: {
              type: "boolean",
              description: "Include the complete normalized BPMN XML",
              default: false,
            },
          },
          required: ["diagramId"],
        },
      },
      {
        name: "import_bpmn_xml",
        description: "Import an existing BPMN XML diagram",
        inputSchema: {
          type: "object",
          properties: {
            xml: {
              type: "string",
              description: "The BPMN XML to import",
            },
          },
          required: ["xml"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "create_bpmn_diagram": {
        const diagramId = generateDiagramId();
        const modeler = await createModeler();
        const { xml } = await modeler.saveXML({ format: true });

        diagrams.set(diagramId, {
          modeler,
          xml: xml || "",
          revision: 0,
          lastModifiedAt: new Date().toISOString(),
          lastModifiedSource: "mcp",
          elementIdMap: new Map(),
          operation: Promise.resolve(),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                diagramId,
                message: `Created new BPMN diagram with ID: ${diagramId}`,
              }, null, 2),
            },
          ],
        };
      }

      case "add_bpmn_element": {
        const {
          diagramId,
          elementType,
          name: elementName,
          x = 100,
          y = 100,
          parentElementId,
          hostElementId,
          isExpanded,
          eventDefinitionType,
        } = args as any;
        const diagram = diagrams.get(diagramId);

        if (!diagram) {
          throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${diagramId}`);
        }

        const modeling = diagram.modeler.get("modeling");
        const elementFactory = diagram.modeler.get("elementFactory");
        const elementRegistry = diagram.modeler.get("elementRegistry");
        const canvas = diagram.modeler.get("canvas");
        const root = canvas.getRootElement();

        const participant = elementRegistry.filter((element: any) => {
          return element.type === "bpmn:Participant";
        })[0];
        const defaultParent = root.type === "bpmn:Process" ? root : participant || root;
        const parent = parentElementId
          ? elementRegistry.get(parentElementId)
          : elementType === "bpmn:Participant" ? root : defaultParent;
        if (!parent) {
          throw new McpError(ErrorCode.InvalidRequest, `Parent element not found: ${parentElementId}`);
        }

        let createdElement: any;

        if (elementType === "bpmn:Lane") {
          if (!parent || !["bpmn:Lane", "bpmn:Participant"].includes(parent.type)) {
            throw new McpError(ErrorCode.InvalidRequest, "A lane must be added to a participant or existing lane");
          }

          createdElement = modeling.addLane(parent, "bottom");
        } else {
          const attrs: Record<string, any> = {
            type: elementType,
            isExpanded,
            eventDefinitionType,
          };

          if (elementType === "bpmn:Participant") {
            attrs.isExpanded = isExpanded !== false;
          }

          const shape = elementType === "bpmn:Participant"
            ? elementFactory.createParticipantShape(attrs)
            : elementFactory.createShape(attrs);
          const host = hostElementId ? elementRegistry.get(hostElementId) : undefined;

          if (hostElementId && !host) {
            throw new McpError(ErrorCode.InvalidRequest, `Host element not found: ${hostElementId}`);
          }

          createdElement = modeling.createShape(
            shape,
            { x, y },
            host || parent,
            host ? { attach: true } : undefined,
          );
        }

        // Set the name if provided
        if (elementName) {
          modeling.updateLabel(createdElement, elementName);
        }

        // Store the element ID
        diagram.elementIdMap.set(createdElement.id, elementType);

        // Update stored XML
        const { xml } = await diagram.modeler.saveXML({ format: true });
        diagram.xml = xml || "";
        markDiagramModified(diagram);

        // Check if this element should typically be connected
        const needsConnection = elementType.includes('Event') || elementType.includes('Task') || elementType.includes('Gateway');
        const hint = needsConnection ? ' (not connected - use connect_bpmn_elements to create sequence flows)' : '';

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                elementId: createdElement.id,
                elementType,
                name: elementName,
                position: { x, y },
                message: `Added ${elementType} to diagram${hint}`,
              }, null, 2),
            },
          ],
        };
      }

      case "connect_bpmn_elements": {
        const {
          diagramId,
          sourceElementId,
          targetElementId,
          label,
          connectionType = "bpmn:SequenceFlow",
        } = args as any;
        const diagram = diagrams.get(diagramId);

        if (!diagram) {
          throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${diagramId}`);
        }

        const modeling = diagram.modeler.get("modeling");
        const elementRegistry = diagram.modeler.get("elementRegistry");

        const source = elementRegistry.get(sourceElementId);
        const target = elementRegistry.get(targetElementId);

        if (!source || !target) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Source or target element not found`
          );
        }

        // Create connection
        const connection = modeling.connect(source, target, {
          type: connectionType,
        });

        if (!connection) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Cannot create ${connectionType} between ${sourceElementId} and ${targetElementId}`,
          );
        }

        // Set label if provided
        if (label) {
          modeling.updateProperties(connection, { name: label });
        }

        // Update stored XML
        const { xml } = await diagram.modeler.saveXML({ format: true });
        diagram.xml = xml || "";
        markDiagramModified(diagram);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                connectionId: connection.id,
                message: `Connected ${sourceElementId} to ${targetElementId}`,
              }, null, 2),
            },
          ],
        };
      }

      case "export_bpmn_xml": {
        const { diagramId } = args as any;
        const diagram = diagrams.get(diagramId);

        if (!diagram) {
          throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${diagramId}`);
        }

        const { xml } = await diagram.modeler.saveXML({ format: true });

        // Check for disconnected elements
        const elements = getDiagramElements(diagram);
        const connectionTypes = new Set([
          "bpmn:SequenceFlow",
          "bpmn:MessageFlow",
          "bpmn:Association",
          "bpmn:DataInputAssociation",
          "bpmn:DataOutputAssociation",
          "bpmn:ConversationLink",
        ]);
        const nodes = elements.filter((element: any) => !connectionTypes.has(element.businessObject?.$type || element.type));
        const connections = elements.filter((element: any) => connectionTypes.has(element.businessObject?.$type || element.type));

        const warnings: string[] = [];
        if (nodes.length > 1 && connections.length === 0) {
          warnings.push(`Note: Diagram has ${nodes.length} BPMN nodes but no connections. Use connect_bpmn_elements to add flows.`);
        } else if (nodes.length > connections.length + 1) {
          warnings.push(`Tip: ${nodes.length} BPMN nodes with ${connections.length} connections; some elements may be disconnected.`);
        }

        return {
          content: [
            {
              type: "text",
              text: xml || "",
            },
            ...(warnings.length > 0 ? [{
              type: "text" as const,
              text: "\n" + warnings.join("\n"),
            }] : []),
          ],
        };
      }

      case "export_bpmn_svg": {
        const { diagramId } = args as any;
        const diagram = diagrams.get(diagramId);

        if (!diagram) {
          throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${diagramId}`);
        }

        const { svg } = await diagram.modeler.saveSVG();

        return {
          content: [
            {
              type: "text",
              text: svg || "",
            },
          ],
        };
      }

      case "open_bpmn_modeler": {
        const { diagramId, openBrowser = false } = args as any;
        const preview = await previewServer.open(diagramId, Boolean(openBrowser));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                diagramId,
                token: preview.token,
                url: preview.url,
                port: preview.port,
                message: `Open the live BPMN modeler at ${preview.url}. Click Save to write browser edits to the MCP session.`,
              }, null, 2),
            },
          ],
        };
      }

      case "close_bpmn_modeler": {
        const { token } = args as any;
        const closed = previewServer.close(token);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                token,
                closed,
                message: closed ? "BPMN modeler preview closed" : "BPMN modeler preview was not found",
              }, null, 2),
            },
          ],
        };
      }

      case "inspect_bpmn_modeler": {
        const { token, includeXml = false } = args as any;
        const preview = await previewServer.inspect(token);
        const diagram = diagrams.get(preview.diagramId);

        if (!diagram) {
          throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${preview.diagramId}`);
        }

        const inspection = diagramInspection(preview.diagramId, diagram, Boolean(includeXml));
        inspection.modelerToken = token;
        inspection.modelerExpiresAt = preview.expiresAt;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(inspection, null, 2),
            },
          ],
        };
      }

      case "list_bpmn_elements": {
        const { diagramId } = args as any;
        const diagram = diagrams.get(diagramId);

        if (!diagram) {
          throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${diagramId}`);
        }

        const elementList = await withDiagramLock(diagram, async () => {
          return getDiagramElements(diagram).map(summarizeElement);
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                diagramId,
                revision: diagram.revision,
                lastModifiedAt: diagram.lastModifiedAt,
                lastModifiedSource: diagram.lastModifiedSource,
                elements: elementList,
                count: elementList.length,
              }, null, 2),
            },
          ],
        };
      }

      case "inspect_bpmn_diagram": {
        const { diagramId, includeXml = false } = args as any;
        const diagram = diagrams.get(diagramId);

        if (!diagram) {
          throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${diagramId}`);
        }

        const inspection = await withDiagramLock(diagram, async () => {
          const { xml } = await diagram.modeler.saveXML({ format: true });
          diagram.xml = xml || "";
          return diagramInspection(diagramId, diagram, Boolean(includeXml));
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(inspection, null, 2),
            },
          ],
        };
      }

      case "import_bpmn_xml": {
        const { xml } = args as any;
        const diagramId = generateDiagramId();

        const container = createHeadlessCanvas();
        const modeler = new BpmnModeler({ container });

        await modeler.importXML(xml);

        diagrams.set(diagramId, {
          modeler,
          xml,
          revision: 1,
          lastModifiedAt: new Date().toISOString(),
          lastModifiedSource: "mcp",
          elementIdMap: new Map(),
          operation: Promise.resolve(),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                diagramId,
                message: `Imported BPMN diagram with ID: ${diagramId}`,
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  } catch (error: any) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${error.message}`
    );
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BPMN.js MCP server running on stdio");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void previewServer.stop().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  void previewServer.stop();
  console.error("Fatal error in main():", error);
  process.exit(1);
});
