// Development-only mock API: serves the MSW handlers (stateful slice 2 handlers first, then the
// generated contract samples) over plain HTTP, so `next dev` can proxy /api to it:
//   node scripts/mock-api.mjs                      (listens on :4010)
//   API_INTERNAL_URL=http://localhost:4010 pnpm --filter web dev
// Vite loads the TypeScript handlers (no build step, no extra dependency).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getResponse } from 'msw';
import { createServer as createViteServer } from 'vite';

const port = Number(process.env.MOCK_API_PORT ?? 4010);
const vite = await createViteServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  logLevel: 'silent',
  appType: 'custom',
  server: { middlewareMode: true },
});
const { createMockDb } = await vite.ssrLoadModule('/src/mocks/slice2/db.ts');
const { slice2Handlers } = await vite.ssrLoadModule('/src/mocks/slice2/handlers.ts');
const { generatedHandlers } = await vite.ssrLoadModule('/src/mocks/generated/handlers.ts');
const db = createMockDb({
  signedIn: process.env.MOCK_SIGNED_IN === '1',
  consentAccepted: process.env.MOCK_CONSENT === '1',
});
const handlers = [...slice2Handlers(db), ...generatedHandlers];

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(`http://${req.headers.host ?? `localhost:${port}`}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? await readBody(req) : undefined,
  });
  const response = await getResponse(handlers, request);
  if (!response) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"no mock"}');
    return;
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => process.stdout.write(`mock api on http://localhost:${port}\n`));
