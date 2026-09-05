import { createServer } from "node:http";

export async function startAuthenticatedTargetFixture({ sentinel, pollDomDrift = false }) {
  if (typeof sentinel !== "string" || sentinel.length < 16) throw new Error("A synthetic auth sentinel is required");
  const requests = [];
  let domDrifted = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const bootstrapAuthenticated = request.headers["x-flow-map-fixture-auth"] === sentinel;
    const sessionAuthenticated = String(request.headers.cookie ?? "").split(/;\s*/).includes("fixture_session=authenticated");
    const authenticated = bootstrapAuthenticated || sessionAuthenticated;
    requests.push({ method: request.method, path: url.pathname, search: url.search, authenticated, bootstrap_header_used: bootstrapAuthenticated });
    if (!authenticated) {
      response.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("authentication required");
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(bootstrapAuthenticated ? { "set-cookie": "fixture_session=authenticated; HttpOnly; SameSite=Strict; Path=/" } : {}) });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head>
<body><main><h1>Authenticated local target</h1><p id="state">fresh</p>
<button type="button" id="toggle" onclick="this.textContent='Preference restored'">Toggle preference</button>
<button type="button" id="complete" onclick="this.textContent='Step completed';fetch('/api/progress',{method:'POST'})">Complete step</button>
<button type="button" id="unknown">Delete everything</button>
<button type="button" id="query-mismatch" onclick="Promise.all([fetch('/api/progress?dangerous=true',{method:'POST'}),fetch('/api/progress/another-record',{method:'POST'})]).catch(()=>{this.textContent='Mismatch blocked'})">Complete query-mismatched step</button>
<a href="/next">Open next state</a>
${pollDomDrift ? "<script>setInterval(async()=>{if(await (await fetch('/drift-state')).text()==='drifted')document.querySelector('#state').textContent='drifted'},50)</script>" : ""}
</main></body></html>`);
      return;
    }
    if (url.pathname === "/drift-state" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end(domDrifted ? "drifted" : "fresh");
      return;
    }
    if (url.pathname === "/next" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><html><body><main><h1>Next authenticated state</h1></main></body></html>");
      return;
    }
    if (url.pathname === "/api/progress" && request.method === "POST") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === "/api/unexpected" && request.method === "POST") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    triggerDomDrift: () => { domDrifted = true; },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}
