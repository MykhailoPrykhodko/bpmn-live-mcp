const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

const { PreviewConflictError, PreviewServer } = require("./dist/preview-server.js");

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      target,
      {
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("modeler preview serves XML and rejects stale autosaves", async () => {
  let xml = "<definitions />";
  let revision = 3;

  const previewServer = new PreviewServer((diagramId) => {
    if (diagramId !== "diagram-1") return undefined;

    return {
      getXml: async () => ({ xml, revision }),
      saveXml: async (nextXml, expectedRevision) => {
        if (expectedRevision !== revision) throw new PreviewConflictError(revision);
        xml = nextXml;
        revision += 1;
        return { xml, revision };
      },
    };
  });

  const opened = await previewServer.open("diagram-1");

  try {
    const page = await request(opened.url);
    assert.equal(page.status, 200);
    assert.match(page.body, /bpmn-modeler\.development\.js/);
    assert.match(page.body, /Download BPMN/);
    assert.match(page.body, /Download SVG/);
    assert.match(page.body, />Save<\/button>/);
    assert.match(page.body, />New<\/button>/);
    assert.match(page.body, />Open<\/button>/);

    const client = await request(`${opened.url}/client.js`);
    assert.equal(client.status, 200);
    assert.match(client.body, /saveXML/);
    assert.match(client.body, /saveSVG/);
    assert.match(client.body, /EMPTY_XML/);
    assert.doesNotThrow(() => new Function(client.body));

    const diagramCss = await request(new URL("/assets/diagram-js.css", opened.url));
    const bpmnCss = await request(new URL("/assets/bpmn-js.css", opened.url));
    const bpmnFontCss = await request(new URL("/assets/bpmn-font/css/bpmn.css", opened.url));
    const bpmnFont = await request(new URL("/assets/bpmn-font/font/bpmn.woff2", opened.url));
    assert.equal(diagramCss.status, 200);
    assert.equal(bpmnCss.status, 200);
    assert.equal(bpmnFontCss.status, 200);
    assert.equal(bpmnFont.status, 200);
    assert.match(diagramCss.headers["content-type"], /text\/css/);
    assert.match(bpmnCss.headers["content-type"], /text\/css/);

    const xmlUrl = `${opened.url}/xml`;
    const initial = await request(xmlUrl);
    assert.equal(initial.status, 200);
    assert.equal(initial.body, xml);
    assert.equal(initial.headers["x-bpmn-revision"], "3");
    assert.equal(initial.headers.etag, '"3"');

    const unchanged = await request(xmlUrl, {
      headers: { "If-None-Match": '"3"' },
    });
    assert.equal(unchanged.status, 304);

    const saved = await request(xmlUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/xml",
        "If-Match": '"3"',
      },
      body: "<definitions><process /></definitions>",
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(saved.body).revision, 4);

    const stale = await request(xmlUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/xml",
        "If-Match": '"3"',
      },
      body: "<definitions><process id=\"stale\" /></definitions>",
    });
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(stale.body).revision, 4);

    assert.equal(previewServer.close(opened.token), true);
    const closed = await request(opened.url);
    assert.equal(closed.status, 404);
  } finally {
    await previewServer.stop();
  }
});
