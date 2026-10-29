import { resolve } from 'node:path';
import { createApp } from './server/app';
import { loadConfig } from './server/config';
import { createRuntimeFetch } from './runtime';

const config = await loadConfig();
const application = createApp(config);
const server = Bun.serve({
  development: false,
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 4 * 1024 * 1024,
  idleTimeout: 255, // Bun max; SSE replies also send a ping every 15s
  fetch: createRuntimeFetch(application.fetch, resolve(import.meta.dir, 'dist'), config.publicURL),
  error() {
    return Response.json({ error: { code: 'internal_error', message: '服务器暂时无法处理请求。' } }, { status: 500 });
  }
});

console.info(`MarginTalk server listening at ${server.url}`);

async function shutdown() {
  await server.stop();
  application.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
