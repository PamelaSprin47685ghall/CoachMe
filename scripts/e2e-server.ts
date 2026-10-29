// Test-only protocol providers. Production index.ts never imports this entry point.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import { createRuntimeFetch } from '../runtime';
import { createMockServices } from '../tests/support/mock-services';

const directory = mkdtempSync(join(tmpdir(), 'margintalk-e2e-'));
const services = createMockServices(3102);
services.setAIBehavior('hold-after-reasoning');
const config: ServerConfig = {
  host: '127.0.0.1', port: 5174,
  publicURL: 'http://127.0.0.1:5174',
  databasePath: join(directory, 'cloud.sqlite'),
  amazon: { clientId: 'test-client', clientSecret: 'test-secret' },
  ai: { baseURL: `${services.origin}/v1`, apiKey: 'test-ai-secret', model: 'test-model', reasoningEffort: 'max', temperature: 1 }
};
const application = createApp(config, { amazonEndpoints: services.amazonEndpoints });
const server = Bun.serve({
  development: false,
  hostname: config.host, port: config.port,
  fetch: createRuntimeFetch(application.fetch, resolve(import.meta.dir, '../dist'), config.publicURL),
  maxRequestBodySize: 4 * 1024 * 1024,
  idleTimeout: 120
});
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  server.stop(true);
  services.close();
  application.close();
  rmSync(directory, { recursive: true, force: true });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
console.info('MarginTalk isolated protocol fixture: production client/API 5174, OAuth/AI provider 3102');
