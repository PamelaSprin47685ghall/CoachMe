import { loadConfig } from '../server/config';
import { resolve } from 'node:path';

const config = await loadConfig();
const selectedConfig = process.env.MARGINTALK_CONFIG;
const privateConfigPath = resolve(selectedConfig || 'margintalk.config.toml');
const environment = {
  ...process.env,
  ...(selectedConfig ? { MARGINTALK_CONFIG: privateConfigPath } : {})
};
const hostname = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
const apiTarget = `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${config.port}`;
const args = Bun.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--');
const api = Bun.spawn([process.execPath, '--watch', 'index.ts'], {
  cwd: import.meta.dir + '/..',
  stdout: 'inherit',
  stderr: 'inherit',
  env: environment
});
const client = Bun.spawn([process.execPath, 'run', '--bun', 'vite', ...args], {
  cwd: import.meta.dir + '/..',
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...environment,
    MARGINTALK_API_TARGET: apiTarget,
    MARGINTALK_PRIVATE_CONFIG_PATH: privateConfigPath,
    MARGINTALK_PRIVATE_DATABASE_PATH: config.databasePath
  }
});

function stop() {
  api.kill('SIGTERM');
  client.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const code = await Promise.race([api.exited, client.exited]);
stop();
await Promise.all([api.exited, client.exited]);
process.exitCode = code;
