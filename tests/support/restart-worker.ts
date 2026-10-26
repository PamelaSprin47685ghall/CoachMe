// Isolated crash/restart test worker; never imported by the production entry point.
import { createApp } from '../../server/app';
import type { AppDependencies } from '../../server/app';
import type { ServerConfig } from '../../server/config';

const rawConfig = process.env.MARGINTALK_TEST_CONFIG;
const rawEndpoints = process.env.MARGINTALK_TEST_AMAZON_ENDPOINTS;
if (!rawConfig || !rawEndpoints) throw new Error('Restart worker requires its isolated test environment');
const config = JSON.parse(rawConfig) as ServerConfig;
const amazonEndpoints = JSON.parse(rawEndpoints) as NonNullable<AppDependencies['amazonEndpoints']>;
const app = createApp(config, { amazonEndpoints });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
console.info(server.url.origin);
