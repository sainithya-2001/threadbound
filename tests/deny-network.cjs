const fs = require('node:fs');

const auditFile = process.env.THREADBOUND_TEST_NETWORK_AUDIT;

function record(kind) {
  if (auditFile) fs.appendFileSync(auditFile, `${kind}\n`, { mode: 0o600 });
}

global.fetch = async () => {
  record('fetch');
  throw new Error('Network access is disabled by the demo-mode test guard.');
};

global.WebSocket = class DemoModeNetworkGuard {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    record('websocket');
    throw new Error('WebSocket access is disabled by the demo-mode test guard.');
  }
};
