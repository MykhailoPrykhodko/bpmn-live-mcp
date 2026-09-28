import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import { spawn } from "child_process";

export interface DiagramPreviewState {
  getXml: () => Promise<{ xml: string; revision: number }>;
  saveXml: (xml: string, expectedRevision: number) => Promise<{ xml: string; revision: number }>;
}

export class PreviewConflictError extends Error {
  constructor(public readonly revision: number) {
    super(`Diagram revision conflict; current revision is ${revision}`);
    this.name = "PreviewConflictError";
  }
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

interface PreviewSession {
  diagramId: string;
  expiresAt: number;
}

interface PreviewResult {
  token: string;
  url: string;
  port: number;
}

interface PreviewInspection {
  token: string;
  diagramId: string;
  revision: number;
  xml: string;
  expiresAt: number;
}

const MAX_XML_SIZE = 5 * 1024 * 1024;
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const EMPTY_DIAGRAM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_New"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_New" isExecutable="true" />
  <bpmndi:BPMNDiagram id="BPMNDiagram_New">
    <bpmndi:BPMNPlane id="BPMNPlane_New" bpmnElement="Process_New" />
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

export class PreviewServer {
  private readonly diagrams: (diagramId: string) => DiagramPreviewState | undefined;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly assetRoot: string;
  private readonly previews = new Map<string, PreviewSession>();
  private server: http.Server | undefined;
  private startPromise: Promise<number> | undefined;
  private port: number | undefined;

  constructor(
    diagrams: (diagramId: string) => DiagramPreviewState | undefined,
    options: { host?: string; port?: number; assetRoot?: string } = {},
  ) {
    this.diagrams = diagrams;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.assetRoot = options.assetRoot ?? path.join(path.dirname(require.resolve("bpmn-js/package.json")), "dist");
  }

  async open(diagramId: string, openBrowser = false): Promise<PreviewResult> {
    if (!this.diagrams(diagramId)) {
      throw new Error(`Diagram not found: ${diagramId}`);
    }

    const port = await this.ensureServer();
    this.pruneExpiredPreviews();

    const token = randomBytes(24).toString("hex");
    this.previews.set(token, {
      diagramId,
      expiresAt: Date.now() + PREVIEW_TTL_MS,
    });

    const url = `http://${this.host}:${port}/modeler/${token}`;
    if (openBrowser) {
      this.openExternal(url);
    }

    return { token, url, port };
  }

  close(token: string): boolean {
    return this.previews.delete(token);
  }

  async inspect(token: string): Promise<PreviewInspection> {
    this.pruneExpiredPreviews();
    const preview = this.previews.get(token);
    if (!preview) {
      throw new Error(`Preview not found or expired: ${token}`);
    }

    const diagram = this.diagrams(preview.diagramId);
    if (!diagram) {
      throw new Error(`Diagram not found: ${preview.diagramId}`);
    }

    const current = await diagram.getXml();
    return {
      token,
      diagramId: preview.diagramId,
      revision: current.revision,
      xml: current.xml,
      expiresAt: preview.expiresAt,
    };
  }

  async stop(): Promise<void> {
    this.previews.clear();
    this.startPromise = undefined;
    this.port = undefined;

    if (!this.server) return;

    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async ensureServer(): Promise<number> {
    if (this.port !== undefined) return this.port;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<number>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request, response);
      });

      server.once("error", reject);
      server.listen(this.requestedPort, this.host, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Unable to determine preview server port"));
          return;
        }

        this.server = server;
        this.port = address.port;
        resolve(address.port);
      });
    }).catch((error) => {
      this.startPromise = undefined;
      throw error;
    });

    return this.startPromise;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      this.pruneExpiredPreviews();
      const requestUrl = new URL(request.url ?? "/", `http://${this.host}`);
      const segments = requestUrl.pathname.split("/").filter(Boolean);

      if (segments[0] === "assets") {
        await this.serveAsset(segments.slice(1).join("/"), response);
        return;
      }

      if (segments[0] !== "modeler" || !segments[1]) {
        this.sendText(response, 404, "Not found");
        return;
      }

      const token = segments[1];
      const preview = this.previews.get(token);
      if (!preview) {
        this.sendText(response, 404, "Preview not found or expired");
        return;
      }

      const diagram = this.diagrams(preview.diagramId);
      if (!diagram) {
        this.sendText(response, 404, "Diagram not found");
        return;
      }

      const resource = segments[2] ?? "";
      if (resource === "") {
        if (request.method !== "GET") {
          this.sendText(response, 405, "Method not allowed");
          return;
        }
        this.sendHtml(response, this.modelerHtml(token));
        return;
      }

      if (resource === "client.js") {
        if (request.method !== "GET") {
          this.sendText(response, 405, "Method not allowed");
          return;
        }
        this.sendJavaScript(response, this.modelerClient(token));
        return;
      }

      if (resource === "xml") {
        await this.handleXml(request, response, diagram, token);
        return;
      }

      this.sendText(response, 404, "Not found");
    } catch (error) {
      if (error instanceof PreviewConflictError) {
        this.sendJson(response, 409, { error: error.message, revision: error.revision });
        return;
      }

      if (error instanceof RequestBodyTooLargeError) {
        this.sendJson(response, 413, { error: error.message });
        return;
      }

      this.sendJson(response, 500, { error: error instanceof Error ? error.message : "Preview request failed" });
    }
  }

  private async handleXml(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    diagram: DiagramPreviewState,
    token: string,
  ): Promise<void> {
    if (request.method === "GET") {
      const current = await diagram.getXml();
      const etag = this.revisionTag(current.revision);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("ETag", etag);
      response.setHeader("X-BPMN-Revision", String(current.revision));

      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304);
        response.end();
        return;
      }

      this.sendXml(response, current.xml);
      return;
    }

    if (request.method !== "PUT") {
      this.sendText(response, 405, "Method not allowed");
      return;
    }

    const expectedRevision = this.parseRevision(request.headers["if-match"]);
    if (expectedRevision === undefined) {
      this.sendJson(response, 428, { error: "If-Match revision header is required" });
      return;
    }

    const xml = await this.readBody(request);
    const saved = await diagram.saveXml(xml, expectedRevision);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("ETag", this.revisionTag(saved.revision));
    response.setHeader("X-BPMN-Revision", String(saved.revision));
    this.sendJson(response, 200, {
      success: true,
      token,
      revision: saved.revision,
      xmlHash: createHash("sha256").update(saved.xml).digest("hex"),
    });
  }

  private async serveAsset(relativePath: string, response: http.ServerResponse): Promise<void> {
    if (!relativePath || relativePath.includes("..")) {
      this.sendText(response, 404, "Asset not found");
      return;
    }

    const assetPath = /^(bpmn-(modeler|navigated-viewer|viewer)\.(development|production\.min)\.js)$/.test(relativePath)
      ? relativePath
      : path.join("assets", relativePath);
    const filePath = path.resolve(this.assetRoot, assetPath);
    const root = path.resolve(this.assetRoot) + path.sep;
    if (!filePath.startsWith(root)) {
      this.sendText(response, 404, "Asset not found");
      return;
    }

    try {
      const data = await fs.promises.readFile(filePath);
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.setHeader("Content-Type", this.contentType(filePath));
      response.writeHead(200);
      response.end(data);
    } catch {
      this.sendText(response, 404, "Asset not found");
    }
  }

  private async readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_XML_SIZE) {
          reject(new RequestBodyTooLargeError());
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }

  private parseRevision(value: string | string[] | undefined): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw) return undefined;
    const parsed = Number(raw.replace(/^"|"$/g, ""));
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }

  private revisionTag(revision: number): string {
    return `"${revision}"`;
  }

  private pruneExpiredPreviews(): void {
    const now = Date.now();
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(token);
    }
  }

  private modelerHtml(token: string): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BPMN Modeler</title>
  <link rel="stylesheet" href="/assets/diagram-js.css">
  <link rel="stylesheet" href="/assets/bpmn-js.css">
  <link rel="stylesheet" href="/assets/bpmn-font/css/bpmn.css">
  <style>
    html, body { height: 100%; margin: 0; font-family: Arial, sans-serif; }
    body { display: flex; flex-direction: column; background: #f8f9fa; color: #29313a; }
    #toolbar { min-height: 44px; display: flex; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid #d9dde3; background: white; flex-wrap: wrap; }
    .toolbar-group { display: flex; align-items: center; gap: 5px; }
    .toolbar-group strong { margin-right: 5px; }
    #toolbar button { border: 1px solid #b8c0ca; border-radius: 4px; background: white; color: #29313a; padding: 5px 9px; cursor: pointer; }
    #toolbar button:hover:not(:disabled) { background: #f0f3f6; }
    #toolbar button:disabled { cursor: default; opacity: .45; }
    #status { color: #59636e; font-size: 13px; margin-left: auto; white-space: nowrap; }
    #canvas { flex: 1; min-height: 0; position: relative; }
    #canvas.dragover { outline: 3px dashed #3b82f6; outline-offset: -8px; }
    #alerts { position: absolute; top: 58px; left: 50%; z-index: 10; transform: translateX(-50%); max-width: min(760px, calc(100% - 40px)); }
    .alert { border: 1px solid #f0ad4e; border-radius: 4px; background: #fff8e6; box-shadow: 0 3px 12px rgba(0,0,0,.12); padding: 10px 14px; margin-bottom: 8px; }
    .alert.error { border-color: #d92d20; background: #fff1f0; }
    .alert button { float: right; border: 0; background: transparent; cursor: pointer; font-size: 18px; }
    .alert pre { max-height: 180px; overflow: auto; white-space: pre-wrap; margin: 8px 0 0; font: 12px monospace; }
    #shortcuts { position: absolute; top: 55px; right: 12px; z-index: 20; width: 330px; border: 1px solid #c8ced6; border-radius: 5px; background: white; box-shadow: 0 5px 18px rgba(0,0,0,.18); padding: 14px; }
    #shortcuts h3 { margin: 0 0 10px; }
    #shortcuts table { width: 100%; border-collapse: collapse; font-size: 12px; }
    #shortcuts td { padding: 4px 0; border-bottom: 1px solid #edf0f2; }
    #shortcuts td:last-child { text-align: right; font-family: monospace; }
  </style>
</head>
<body>
  <div id="toolbar">
    <div class="toolbar-group">
      <strong>BPMN Modeler</strong>
      <button id="new" type="button" title="Reset the active MCP diagram">New</button>
      <button id="open" type="button" title="Open BPMN diagram from local file system">Open</button>
      <button id="save" type="button" title="Save changes to the MCP diagram" disabled>Save</button>
      <input id="file" type="file" accept=".bpmn,.xml,application/xml,text/xml" hidden>
    </div>
    <div class="toolbar-group">
      <button id="undo" type="button" title="Undo" disabled>Undo</button>
      <button id="redo" type="button" title="Redo" disabled>Redo</button>
      <button id="download-bpmn" type="button" title="Download BPMN 2.0 file">Download BPMN</button>
      <button id="download-svg" type="button" title="Download SVG image">Download SVG</button>
    </div>
    <div class="toolbar-group">
      <button id="reload" type="button" title="Reload the MCP version">Reload</button>
      <button id="fit" type="button" title="Fit diagram to viewport">Fit</button>
      <button id="zoom-in" type="button" title="Zoom in">+</button>
      <button id="zoom-out" type="button" title="Zoom out">-</button>
      <button id="fullscreen" type="button" title="Toggle fullscreen">Fullscreen</button>
      <button id="shortcuts-toggle" type="button" title="Show keyboard shortcuts">Shortcuts</button>
    </div>
    <span id="status">Loading...</span>
  </div>
  <div id="alerts" hidden></div>
  <div id="shortcuts" hidden>
    <h3>Keyboard Shortcuts</h3>
    <table>
      <tr><td>Open BPMN file</td><td>Ctrl/Cmd + O</td></tr>
      <tr><td>Save to MCP</td><td>Ctrl/Cmd + S</td></tr>
      <tr><td>Undo</td><td>Ctrl/Cmd + Z</td></tr>
      <tr><td>Redo</td><td>Ctrl/Cmd + Shift + Z</td></tr>
      <tr><td>Select all</td><td>Ctrl/Cmd + A</td></tr>
      <tr><td>Direct editing</td><td>E</td></tr>
      <tr><td>Hand tool</td><td>H</td></tr>
      <tr><td>Lasso tool</td><td>L</td></tr>
      <tr><td>Space tool</td><td>S</td></tr>
    </table>
  </div>
  <div id="canvas"></div>
  <script src="/assets/bpmn-modeler.development.js"></script>
  <script src="/modeler/${token}/client.js"></script>
</body>
</html>`;
  }

  private modelerClient(token: string): string {
    const xmlUrl = JSON.stringify(`/modeler/${token}/xml`);
    const emptyXml = JSON.stringify(EMPTY_DIAGRAM_XML);
    return `(() => {
  const XML_URL = ${xmlUrl};
  const EMPTY_XML = ${emptyXml};
  const status = document.getElementById('status');
  const alerts = document.getElementById('alerts');
  const shortcuts = document.getElementById('shortcuts');
  const canvasElement = document.getElementById('canvas');
  const fileInput = document.getElementById('file');
  const modeler = new BpmnJS({ container: '#canvas' });
  const canvas = modeler.get('canvas');
  const commandStack = modeler.get('commandStack');
  let revision = -1;
  let localDirty = false;
  let saving = false;
  let conflict = false;
  let ignoreChanges = false;

  function setStatus(message, error) {
    status.textContent = message;
    status.style.color = error ? '#b42318' : '#59636e';
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function clearAlert() {
    alerts.hidden = true;
    alerts.textContent = '';
  }

  function showAlert(message, type, details) {
    alerts.hidden = false;
    alerts.innerHTML = '<div class="alert ' + (type === 'error' ? 'error' : '') + '">' +
      '<button type="button" aria-label="Close">&times;</button>' +
      '<strong>' + escapeHtml(message) + '</strong>' +
      (details ? '<pre>' + escapeHtml(details) + '</pre>' : '') +
      '</div>';
    alerts.querySelector('button').addEventListener('click', clearAlert);
  }

  function showWarnings(warnings) {
    if (!warnings || warnings.length === 0) return;
    const details = warnings.map(warning => warning.message || String(warning)).join('\\n');
    showAlert('Diagram may not render correctly due to import warnings.', 'warning', details);
  }

  function updateCommandButtons() {
    document.getElementById('undo').disabled = !commandStack.canUndo();
    document.getElementById('redo').disabled = !commandStack.canRedo();
    document.getElementById('save').disabled = !localDirty || saving || conflict;
  }

  async function request(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function load(force) {
    if (conflict && !force) return;

    const headers = {};
    if (!force && revision >= 0) headers['If-None-Match'] = '"' + revision + '"';

    const response = await request(XML_URL, { headers });
    if (response.status === 304) return;
    if (!response.ok) throw new Error('Unable to load BPMN XML (' + response.status + ')');

    const nextRevision = Number(response.headers.get('x-bpmn-revision'));
    const xml = await response.text();
    if (localDirty && !force && nextRevision !== revision) {
      conflict = true;
      setStatus('Conflict at revision ' + nextRevision + '. Reload required.', true);
      showAlert('The diagram changed in MCP while you had local edits.', 'error', 'Reload to discard the local edits.');
      return;
    }
    if (localDirty && !force) return;

    ignoreChanges = true;
    try {
      const result = await modeler.importXML(xml);
      canvas.zoom('fit-viewport');
      showWarnings(result.warnings);
    } finally {
      ignoreChanges = false;
    }
    revision = nextRevision;
    localDirty = false;
    conflict = false;
    updateCommandButtons();
    setStatus('Saved, revision ' + revision);
  }

  async function save() {
    if (!localDirty || saving || conflict) return;
    saving = true;
    updateCommandButtons();
    setStatus('Saving...');

    try {
      const result = await modeler.saveXML({ format: true });
      const response = await request(XML_URL, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/xml',
          'If-Match': String(revision)
        },
        body: result.xml
      });

      if (response.status === 409) {
        conflict = true;
        const body = await response.json();
        setStatus('Conflict at revision ' + body.revision + '. Reload required.', true);
        showAlert('The diagram changed in MCP while saving.', 'error', 'Reload to discard the local edits.');
        return;
      }
      if (!response.ok) throw new Error('Unable to save BPMN XML (' + response.status + ')');

      const body = await response.json();
      revision = body.revision;
      localDirty = false;
      conflict = false;
      updateCommandButtons();
      setStatus('Saved to MCP, revision ' + revision);
    } catch (error) {
      setStatus(error.message || 'Save failed', true);
    } finally {
      saving = false;
      updateCommandButtons();
    }
  }

  function markDirty() {
    if (ignoreChanges) return;
    localDirty = true;
    conflict = false;
    updateCommandButtons();
    setStatus('Unsaved changes. Click Save to update MCP.');
  }

  async function replaceDiagram(xml, label) {
    ignoreChanges = true;
    try {
      const result = await modeler.importXML(xml);
      canvas.zoom('fit-viewport');
      showWarnings(result.warnings);
    } catch (error) {
      showAlert('Could not import the BPMN diagram.', 'error', error.message || String(error));
      setStatus('Import failed', true);
      return;
    } finally {
      ignoreChanges = false;
    }

    localDirty = true;
    conflict = false;
    updateCommandButtons();
    setStatus(label + '. Click Save to update MCP.');
  }

  function hasDiagramContent() {
    return modeler.get('elementRegistry').filter(element =>
      element.type &&
      element.type !== 'bpmn:Process' &&
      element.type !== 'label' &&
      !element.type.includes('BPMNDiagram')
    ).length > 0;
  }

  function confirmReplace() {
    if (!localDirty && !hasDiagramContent()) return true;
    return window.confirm('Replace the active BPMN diagram and discard its current content?');
  }

  async function createNew() {
    if (!confirmReplace()) return;
    clearAlert();
    await replaceDiagram(EMPTY_XML, 'New diagram loaded');
  }

  async function openFile(file) {
    if (!file || !confirmReplace()) return;
    const reader = new FileReader();
    reader.onload = () => replaceDiagram(String(reader.result), 'Imported diagram');
    reader.onerror = () => showAlert('Could not read the selected file.', 'error');
    reader.readAsText(file);
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function downloadBpmn() {
    try {
      const result = await modeler.saveXML({ format: true });
      downloadFile('diagram.bpmn', result.xml, 'application/bpmn20-xml;charset=UTF-8');
    } catch (error) {
      showAlert('Could not export BPMN XML.', 'error', error.message || String(error));
    }
  }

  async function downloadSvg() {
    try {
      const result = await modeler.saveSVG();
      downloadFile('diagram.svg', result.svg, 'image/svg+xml;charset=UTF-8');
    } catch (error) {
      showAlert('Could not export SVG.', 'error', error.message || String(error));
    }
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  }

  modeler.on('commandStack.changed', () => {
    updateCommandButtons();
    markDirty();
  });
  document.getElementById('new').addEventListener('click', createNew);
  document.getElementById('open').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => openFile(fileInput.files[0]));
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('undo').addEventListener('click', () => commandStack.undo());
  document.getElementById('redo').addEventListener('click', () => commandStack.redo());
  document.getElementById('download-bpmn').addEventListener('click', downloadBpmn);
  document.getElementById('download-svg').addEventListener('click', downloadSvg);
  document.getElementById('reload').addEventListener('click', () => load(true).catch(error => setStatus(error.message, true)));
  document.getElementById('fit').addEventListener('click', () => canvas.zoom('fit-viewport'));
  document.getElementById('zoom-in').addEventListener('click', () => canvas.zoom(Math.min(canvas.zoom() + 0.2, 4)));
  document.getElementById('zoom-out').addEventListener('click', () => canvas.zoom(Math.max(canvas.zoom() - 0.2, 0.2)));
  document.getElementById('fullscreen').addEventListener('click', () => toggleFullscreen().catch(error => setStatus(error.message, true)));
  document.getElementById('shortcuts-toggle').addEventListener('click', () => { shortcuts.hidden = !shortcuts.hidden; });

  canvasElement.addEventListener('dragover', event => {
    event.preventDefault();
    canvasElement.classList.add('dragover');
  });
  canvasElement.addEventListener('dragleave', () => canvasElement.classList.remove('dragover'));
  canvasElement.addEventListener('drop', event => {
    event.preventDefault();
    canvasElement.classList.remove('dragover');
    openFile(event.dataTransfer.files[0]);
  });

  document.addEventListener('fullscreenchange', () => {
    document.getElementById('fullscreen').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  });
  document.addEventListener('keydown', event => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      fileInput.click();
    } else if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      shortcuts.hidden = true;
    }
  });

  setInterval(() => {
    if (saving || conflict) return;
    load(false).catch(error => setStatus(error.message, true));
  }, 1000);

  load(true).catch(error => setStatus(error.message, true));
})();`;
  }

  private openExternal(url: string): void {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }

  private contentType(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    return {
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".eot": "application/vnd.ms-fontobject",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extension] ?? "application/octet-stream";
  }

  private sendHtml(response: http.ServerResponse, body: string): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.writeHead(200);
    response.end(body);
  }

  private sendJavaScript(response: http.ServerResponse, body: string): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.writeHead(200);
    response.end(body);
  }

  private sendXml(response: http.ServerResponse, body: string): void {
    response.setHeader("Content-Type", "application/xml; charset=utf-8");
    response.writeHead(200);
    response.end(body);
  }

  private sendJson(response: http.ServerResponse, status: number, body: unknown): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.writeHead(status);
    response.end(JSON.stringify(body));
  }

  private sendText(response: http.ServerResponse, status: number, body: string): void {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.writeHead(status);
    response.end(body);
  }
}
