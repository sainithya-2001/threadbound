import { Readable } from 'node:stream';
import { parentPort, workerData } from 'node:worker_threads';

// Prevent accidental external HTTP calls in this isolated test worker.
let externalRequestAttempts = 0;
globalThis.fetch = async () => {
  externalRequestAttempts++;
  throw new Error('External network access is disabled in the HTTP test harness.');
};

const { handleRequest, SERVER_HOST } = await import('../server.mjs');
parentPort.postMessage({ type: 'ready', serverHost: SERVER_HOST });

parentPort.on('message', async ({ id, request }) => {
  const headers = {};
  let status = 200;
  let responseBody = '';
  let completed = false;
  const response = {
    setHeader(name, value) { headers[name.toLowerCase()] = String(value); return this; },
    writeHead(code, values = {}) {
      status = code;
      for (const [name, value] of Object.entries(values)) headers[name.toLowerCase()] = String(value);
      return this;
    },
    end(chunk = '') {
      if (completed) return this;
      completed = true;
      responseBody = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      parentPort.postMessage({ id, status, headers, body: responseBody, externalRequestAttempts });
      return this;
    }
  };
  const req = Readable.from(request.body ? [Buffer.from(request.body)] : []);
  req.method = request.method;
  req.url = request.url;
  req.headers = request.headers;
  try {
    await handleRequest(req, response, { assetRoot: workerData.assetRoot });
    if (!completed) response.end();
  } catch (error) {
    parentPort.postMessage({ id, harnessError: error?.message || 'Request handler failed.' });
  }
});
