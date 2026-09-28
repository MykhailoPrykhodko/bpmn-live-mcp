// Shared BPMN MCP engine and Server factory. Both entry points (stdio in index.ts,
// HTTP in http-server.ts) import this module. Diagram state, the preview server, and
// the TTL sweeper are process-wide singletons shared by every transport/session; only
// the MCP `Server` object (which is bound 1:1 to a transport) is created fresh per call
// to `createMcpServer()`.
export {}; // Force this file to be treated as a module so its top-level names don't
           // collide with index.ts/http-server.ts (both plain CommonJS `require`s).


const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} = require("@modelcontextprotocol/sdk/types.js");
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { PreviewServer, PreviewConflictError } = require("./preview-server");

let BpmnModeler: any;
let jsdomInstance: any;

interface DiagramState {
  id: string;
  name?: string;
  modeler: any;
  container: any;
  xml: string;
  revision: number;
  createdAt: string;
  lastModifiedAt: string;
  lastModifiedSource: "mcp" | "modeler";
  lastAccessedAt: number;
  disposed: boolean;
  operation: Promise<void>;
}

const pkg = require("../package.json");

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Idle diagrams are disposed after this long (0 disables expiry).
const DIAGRAM_TTL_MS = envNumber("BPMN_MCP_DIAGRAM_TTL_MINUTES", 24 * 60) * 60 * 1000;
// Upper bound on concurrently held diagrams (0 disables the cap).
const MAX_DIAGRAMS = envNumber("BPMN_MCP_MAX_DIAGRAMS", 50);
// A single locked diagram operation (import/export/tool call) may not run longer than this.
// Without a bound, one stuck bpmn-js/jsdom promise wedges withDiagramLock's queue forever:
// every later operation on that diagram (including the modeler's XML polling) queues behind
// it indefinitely, and the corresponding HTTP responses never call res.end(), which leaks
// sockets into CLOSE_WAIT and eventually times out the browser's fetch AbortController.
const DIAGRAM_OPERATION_TIMEOUT_MS = envNumber("BPMN_MCP_OPERATION_TIMEOUT_MS", 20_000);

// In-memory storage for diagrams (keyed by diagram ID)
const diagrams = new Map<string, DiagramState>();

/** Rejects with `message` after `ms` if `promise` has not already settled. Does not cancel `promise`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Serialises every operation on one diagram. NOT re-entrant: never call it
 * from inside another withDiagramLock/withDiagram callback for the same diagram.
 *
 * Bounds each action with DIAGRAM_OPERATION_TIMEOUT_MS so a single stuck operation
 * (e.g. a pathological bpmn-js import) can never wedge the lock for later callers -
 * the lock is always released in `finally`, even if `action()` never settles.
 */
async function withDiagramLock<T>(diagram: DiagramState, action: () => Promise<T>): Promise<T> {
  const previous = diagram.operation;
  let release!: () => void;
  diagram.operation = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    if (diagram.disposed) {
      throw new McpError(ErrorCode.InvalidRequest, `Diagram was deleted: ${diagram.id}`);
    }
    diagram.lastAccessedAt = Date.now();
    return await withTimeout(
      action(),
      DIAGRAM_OPERATION_TIMEOUT_MS,
      `Diagram operation timed out after ${DIAGRAM_OPERATION_TIMEOUT_MS}ms: ${diagram.id}`,
    );
  } finally {
    release();
  }
}

/** Looks a diagram up by ID and runs `action` on it under the diagram lock. */
async function withDiagram<T>(diagramId: string, action: (diagram: DiagramState) => Promise<T>): Promise<T> {
  const diagram = diagrams.get(diagramId);
  if (!diagram) {
    throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${diagramId}`);
  }
  return withDiagramLock(diagram, () => action(diagram));
}

/** Destroys the bpmn-js instance and removes its canvas from the jsdom document. */
function disposeModeler(modeler: any, container: any): void {
  try {
    modeler?.destroy?.();
  } catch {
    // best effort
  }
  try {
    container?.remove?.();
  } catch {
    // best effort
  }
}

async function disposeDiagram(diagramId: string): Promise<boolean> {
  const diagram = diagrams.get(diagramId);
  if (!diagram) return false;

  // Remove from the registry first so nothing new can look it up, then wait for
  // in-flight operations before tearing the modeler down.
  diagrams.delete(diagramId);
  previewServer.closeForDiagram(diagramId);

  const previous = diagram.operation;
  let release!: () => void;
  diagram.operation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    diagram.disposed = true;
    disposeModeler(diagram.modeler, diagram.container);
  } finally {
    release();
  }
  return true;
}

async function sweepExpiredDiagrams(): Promise<void> {
  if (DIAGRAM_TTL_MS <= 0) return;
  const cutoff = Date.now() - DIAGRAM_TTL_MS;
  for (const [id, diagram] of [...diagrams]) {
    if (diagram.lastAccessedAt < cutoff) {
      await disposeDiagram(id);
    }
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

      // instantiateModeler disposes the new instance itself if the import fails
      const replacement = await instantiateModeler(xml);
      let saved: any;
      try {
        saved = await replacement.modeler.saveXML({ format: true });
      } catch (error) {
        disposeModeler(replacement.modeler, replacement.container);
        throw error;
      }

      const previous = { modeler: diagram.modeler, container: diagram.container };
      diagram.modeler = replacement.modeler;
      diagram.container = replacement.container;
      disposeModeler(previous.modeler, previous.container);
      diagram.xml = saved.xml || "";
      markDiagramModified(diagram, "modeler");

      return { xml: diagram.xml, revision: diagram.revision };
    }),
  };
});

// Resolve the bpmn-js bundle through Node's module resolution so it works with
// hoisted, global and npx installs (not only a local ./node_modules).
function resolveBpmnJsBundle(): string {
  const dist = path.join(path.dirname(require.resolve("bpmn-js/package.json")), "dist");
  const preferred = process.env.BPMN_MCP_BUNDLE === "development"
    ? "bpmn-modeler.development.js"
    : "bpmn-modeler.production.min.js";
  const fallback = "bpmn-modeler.development.js";
  const preferredPath = path.join(dist, preferred);
  return fs.existsSync(preferredPath) ? preferredPath : path.join(dist, fallback);
}

// Lazily boot the shared jsdom window and load bpmn-js into it
function ensureJsdom(): void {
  if (!jsdomInstance) {
    // Load the browser bundle
    const bpmnJsPath = resolveBpmnJsBundle();
    const bpmnJsBundle = fs.readFileSync(bpmnJsPath, 'utf-8');

    // jsdom's default virtualConsole forwards jsdom-internal log/warn/error events
    // (CSS parse warnings, unimplemented-API notices, script errors, etc.) straight to
    // the real global `console`, which writes to process.stdout. That is the exact
    // channel the MCP stdio transport uses to frame JSON-RPC messages, so a single
    // jsdom console event at the wrong moment corrupts the stream and silently breaks
    // every request after it (client-visible as generic request timeouts). Route jsdom's
    // console to stderr instead so it can never interleave with JSON-RPC on stdout.
    const jsdomConsole = new VirtualConsole();
    jsdomConsole.on("jsdomError", (error: any) => {
      console.error("[bpmn-js-mcp] jsdom error:", error?.stack || error?.message || error);
    });
    for (const level of ["log", "info", "warn", "error", "debug", "dir", "trace"] as const) {
      jsdomConsole.on(level, (...args: unknown[]) => {
        console.error(`[bpmn-js-mcp] jsdom ${level}:`, ...args);
      });
    }

    // Create jsdom with the script
    jsdomInstance = new JSDOM(
      "<!DOCTYPE html><html><body><div id='canvas'></div></body></html>",
      { runScripts: "outside-only", virtualConsole: jsdomConsole }
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
}

// Create a headless canvas for bpmn-js
function createHeadlessCanvas(): any {
  ensureJsdom();
  const canvas = jsdomInstance.window.document.createElement("div");
  canvas.className = "bpmn-headless-canvas";
  jsdomInstance.window.document.body.appendChild(canvas);
  return canvas;
}

/** Creates a modeler on its own canvas and imports `xml`; cleans up if the import fails. */
async function instantiateModeler(xml: string): Promise<{ modeler: any; container: any }> {
  const container = createHeadlessCanvas();
  const modeler = new BpmnModeler({ container });
  try {
    await modeler.importXML(xml);
  } catch (error) {
    disposeModeler(modeler, container);
    throw error;
  }
  return { modeler, container };
}

// Create a new BPMN modeler instance
async function createModeler(): Promise<{ modeler: any; container: any }> {
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

  return instantiateModeler(initialXml);
}

// Generate a unique diagram ID
function generateDiagramId(): string {
  return `diagram_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function registerDiagram(init: { name?: string; modeler: any; container: any; xml: string; revision: number }): DiagramState {
  if (MAX_DIAGRAMS > 0 && diagrams.size >= MAX_DIAGRAMS) {
    disposeModeler(init.modeler, init.container);
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Diagram limit reached (${MAX_DIAGRAMS}). Use delete_bpmn_diagram to remove diagrams you no longer need, ` +
        `or raise BPMN_MCP_MAX_DIAGRAMS.`,
    );
  }

  const now = new Date();
  const diagram: DiagramState = {
    id: generateDiagramId(),
    name: init.name,
    modeler: init.modeler,
    container: init.container,
    xml: init.xml,
    revision: init.revision,
    createdAt: now.toISOString(),
    lastModifiedAt: now.toISOString(),
    lastModifiedSource: "mcp",
    lastAccessedAt: now.getTime(),
    disposed: false,
    operation: Promise.resolve(),
  };
  diagrams.set(diagram.id, diagram);
  return diagram;
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
    name: diagram.name,
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

/**
 * Builds a fresh MCP `Server` bound to the shared diagram engine above. The SDK requires
 * one `Server` per transport connection ("Already connected to a transport" otherwise),
 * so HTTP mode calls this once per session while stdio mode calls it once for its single
 * long-lived connection. All request handlers close over the module-scope `diagrams` map,
 * `previewServer`, etc., so every session sees and can operate on the same diagrams.
 */
function createMcpServer(): any {
  const server = new Server(
    {
      name: pkg.name,
      version: pkg.version,
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
              description: "X coordinate of the element centre. If omitted, the element is placed automatically after the last flow element in its container.",
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
            name: {
              type: "string",
              description: "Optional name for the imported diagram",
            },
          },
          required: ["xml"],
        },
      },
      {
        name: "list_bpmn_diagrams",
        description: "List the diagrams currently held in this MCP session (ID, name, revision, timestamps).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "delete_bpmn_diagram",
        description: "Delete a diagram from the MCP session, free its resources and revoke any open modeler links for it.",
        inputSchema: {
          type: "object",
          properties: {
            diagramId: {
              type: "string",
              description: "The diagram ID to delete",
            },
          },
          required: ["diagramId"],
        },
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Automatic placement
// ---------------------------------------------------------------------------

const FLOW_GAP = 60;
const START_X = 150;
const START_Y = 200;
const ARTIFACT_TYPES = new Set([
  "bpmn:DataObjectReference",
  "bpmn:DataStoreReference",
  "bpmn:TextAnnotation",
  "bpmn:Group",
]);
const NON_FLOW_TYPES = new Set([
  ...ARTIFACT_TYPES,
  "bpmn:Lane",
  "bpmn:Participant",
  "bpmn:BoundaryEvent",
  "label",
]);

function isFlowNode(element: any): boolean {
  return Boolean(element?.type) &&
    !element.labelTarget &&
    !element.waypoints &&
    element.width !== undefined &&
    !NON_FLOW_TYPES.has(element.type);
}

/**
 * Picks a centre point for a new element when the caller gave no coordinates:
 * flow nodes continue left-to-right after the right-most flow node of the same
 * container, artifacts sit above it, boundary events sit on the host's bottom
 * edge and participants stack vertically.
 */
function defaultPosition(elementType: string, shape: any, parent: any, host: any): { x: number; y: number } {
  if (host) {
    return { x: host.x + host.width / 2, y: host.y + host.height };
  }

  const children: any[] = parent.children || [];

  if (elementType === "bpmn:Participant") {
    const participants = children.filter((child) => child.type === "bpmn:Participant");
    const bottom = participants.reduce((max, child) => Math.max(max, child.y + child.height), 0);
    return {
      x: 100 + shape.width / 2,
      y: (participants.length ? bottom + 30 : 80) + shape.height / 2,
    };
  }

  const hasBounds = parent.x !== undefined && parent.width !== undefined;
  const flowNodes = children.filter(isFlowNode);
  const last = flowNodes.reduce<any>(
    (best, child) => (!best || child.x + child.width > best.x + best.width ? child : best),
    undefined,
  );

  if (ARTIFACT_TYPES.has(elementType)) {
    if (last) return { x: last.x + last.width / 2, y: last.y - 90 };
    return hasBounds
      ? { x: parent.x + 100, y: parent.y + 40 }
      : { x: START_X, y: START_Y - 120 };
  }

  if (last) {
    return {
      x: last.x + last.width + FLOW_GAP + shape.width / 2,
      y: last.y + last.height / 2,
    };
  }

  return hasBounds
    ? { x: parent.x + 70 + shape.width / 2, y: parent.y + parent.height / 2 }
    : { x: START_X, y: START_Y };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function jsonResult(payload: Record<string, any>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function refreshXml(diagram: DiagramState): Promise<string> {
  const { xml } = await diagram.modeler.saveXML({ format: true });
  diagram.xml = xml || "";
  return diagram.xml;
}

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "create_bpmn_diagram": {
          const { name: diagramName } = (args || {}) as any;
          const { modeler, container } = await createModeler();
          let xml = "";
          try {
          xml = (await modeler.saveXML({ format: true })).xml || "";
        } catch (error) {
          disposeModeler(modeler, container);
          throw error;
        }

        const diagram = registerDiagram({ name: diagramName, modeler, container, xml, revision: 0 });

        return jsonResult({
          success: true,
          diagramId: diagram.id,
          name: diagram.name,
          message: `Created new BPMN diagram with ID: ${diagram.id}`,
        });
      }

      case "add_bpmn_element": {
        const {
          diagramId,
          elementType,
          name: elementName,
          x,
          y,
          parentElementId,
          hostElementId,
          isExpanded,
          eventDefinitionType,
        } = args as any;

        return withDiagram(diagramId, async (diagram) => {
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
          let position: { x: number; y: number } | undefined;

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

            const auto = defaultPosition(elementType, shape, host || parent, host);
            position = {
              x: typeof x === "number" ? x : auto.x,
              y: typeof y === "number" ? y : auto.y,
            };

            createdElement = modeling.createShape(
              shape,
              position,
              host || parent,
              host ? { attach: true } : undefined,
            );
          }

          // Set the name if provided
          if (elementName) {
            modeling.updateLabel(createdElement, elementName);
          }

          // Update stored XML
          await refreshXml(diagram);
          markDiagramModified(diagram);

          // Check if this element should typically be connected
          const needsConnection = elementType.includes('Event') || elementType.includes('Task') || elementType.includes('Gateway');
          const hint = needsConnection ? ' (not connected - use connect_bpmn_elements to create sequence flows)' : '';

          return jsonResult({
            success: true,
            elementId: createdElement.id,
            elementType,
            name: elementName,
            position: position ?? { x: createdElement.x, y: createdElement.y },
            message: `Added ${elementType} to diagram${hint}`,
          });
        });
      }

      case "connect_bpmn_elements": {
        const {
          diagramId,
          sourceElementId,
          targetElementId,
          label,
          connectionType = "bpmn:SequenceFlow",
        } = args as any;

        return withDiagram(diagramId, async (diagram) => {
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
          await refreshXml(diagram);
          markDiagramModified(diagram);

          return jsonResult({
            success: true,
            connectionId: connection.id,
            message: `Connected ${sourceElementId} to ${targetElementId}`,
          });
        });
      }

      case "export_bpmn_xml": {
        const { diagramId } = args as any;

        return withDiagram(diagramId, async (diagram) => {
          const xml = await refreshXml(diagram);

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
                type: "text" as const,
                text: xml,
              },
              ...(warnings.length > 0 ? [{
                type: "text" as const,
                text: "\n" + warnings.join("\n"),
              }] : []),
            ],
          };
        });
      }

      case "export_bpmn_svg": {
        const { diagramId } = args as any;

        return withDiagram(diagramId, async (diagram) => {
          const { svg } = await diagram.modeler.saveSVG();

          return {
            content: [
              {
                type: "text" as const,
                text: svg || "",
              },
            ],
          };
        });
      }

      case "open_bpmn_modeler": {
        const { diagramId, openBrowser = false } = args as any;
        const preview = await previewServer.open(diagramId, Boolean(openBrowser));

        return jsonResult({
          success: true,
          diagramId,
          token: preview.token,
          url: preview.url,
          port: preview.port,
          message: `Open the live BPMN modeler at ${preview.url}. Click Save to write browser edits to the MCP session.`,
        });
      }

      case "close_bpmn_modeler": {
        const { token } = args as any;
        const closed = previewServer.close(token);

        return jsonResult({
          success: true,
          token,
          closed,
          message: closed ? "BPMN modeler preview closed" : "BPMN modeler preview was not found",
        });
      }

      case "inspect_bpmn_modeler": {
        const { token, includeXml = false } = args as any;
        // previewServer.inspect takes the diagram lock itself, so it must finish
        // before we take the lock again below.
        const preview = await previewServer.inspect(token);

        const inspection = await withDiagram(preview.diagramId, async (diagram) => {
          if (includeXml) await refreshXml(diagram);
          return diagramInspection(preview.diagramId, diagram, Boolean(includeXml));
        });
        inspection.modelerToken = token;
        inspection.modelerExpiresAt = preview.expiresAt;

        return jsonResult(inspection);
      }

      case "list_bpmn_elements": {
        const { diagramId } = args as any;

        return withDiagram(diagramId, async (diagram) => {
          const elementList = getDiagramElements(diagram).map(summarizeElement);

          return jsonResult({
            success: true,
            diagramId,
            name: diagram.name,
            revision: diagram.revision,
            lastModifiedAt: diagram.lastModifiedAt,
            lastModifiedSource: diagram.lastModifiedSource,
            elements: elementList,
            count: elementList.length,
          });
        });
      }

      case "inspect_bpmn_diagram": {
        const { diagramId, includeXml = false } = args as any;

        const inspection = await withDiagram(diagramId, async (diagram) => {
          await refreshXml(diagram);
          return diagramInspection(diagramId, diagram, Boolean(includeXml));
        });

        return jsonResult(inspection);
      }

      case "import_bpmn_xml": {
        const { xml, name: diagramName } = args as any;
        if (typeof xml !== "string" || !xml.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "xml must be a non-empty string");
        }

        // instantiateModeler disposes its own canvas/modeler if the import fails
        const { modeler, container } = await instantiateModeler(xml);
        const diagram = registerDiagram({ name: diagramName, modeler, container, xml, revision: 1 });

        return jsonResult({
          success: true,
          diagramId: diagram.id,
          name: diagram.name,
          message: `Imported BPMN diagram with ID: ${diagram.id}`,
        });
      }

      case "list_bpmn_diagrams": {
        const list = [...diagrams.values()].map((diagram) => ({
          diagramId: diagram.id,
          name: diagram.name,
          revision: diagram.revision,
          createdAt: diagram.createdAt,
          lastModifiedAt: diagram.lastModifiedAt,
          lastModifiedSource: diagram.lastModifiedSource,
          lastAccessedAt: new Date(diagram.lastAccessedAt).toISOString(),
        }));

        return jsonResult({ success: true, count: list.length, diagrams: list });
      }

      case "delete_bpmn_diagram": {
        const { diagramId } = args as any;
        const deleted = await disposeDiagram(diagramId);
        if (!deleted) {
          throw new McpError(ErrorCode.InvalidRequest, `Diagram not found: ${diagramId}`);
        }

        return jsonResult({
          success: true,
          diagramId,
          message: `Deleted diagram ${diagramId} and revoked its modeler links`,
        });
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

  return server;
}

/** Idle-diagram sweeper. Callers should invoke this once per process (not once per session). */
function startDiagramSweeper(): NodeJS.Timeout | undefined {
  if (DIAGRAM_TTL_MS <= 0) return undefined;
  const sweeper = setInterval(() => {
    void sweepExpiredDiagrams().catch((error: unknown) => console.error("Diagram sweep failed:", error));
  }, Math.min(5 * 60 * 1000, Math.max(1000, DIAGRAM_TTL_MS)));
  sweeper.unref();
  return sweeper;
}

module.exports = { createMcpServer, startDiagramSweeper, previewServer, pkg };
