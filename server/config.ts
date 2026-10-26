import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface ServerConfig {
  host: string;
  port: number;
  publicURL: string;
  databasePath: string;
  amazon: {
    clientId: string;
    clientSecret: string;
  };
  ai: {
    baseURL: string;
    apiKey: string;
    model: string;
    reasoningEffort: string;
  };
}

export const DEFAULT_CONFIG: ServerConfig = {
  host: '127.0.0.1',
  port: 3000,
  publicURL: 'http://127.0.0.1:3000',
  databasePath: resolve(process.cwd(), 'data/margintalk.sqlite'),
  amazon: {
    clientId: '',
    clientSecret: ''
  },
  ai: {
    baseURL: '',
    apiKey: '',
    model: '',
    reasoningEffort: ''
  }
};

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function validatePublicURL(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('server.publicURL must be a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('server.publicURL protocol must be http or https');
  }

  if (parsed.username || parsed.password) {
    throw new Error('server.publicURL must not contain credentials');
  }

  if (parsed.search || parsed.hash) {
    throw new Error('server.publicURL must not contain query parameters or fragments');
  }

  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new Error('server.publicURL must be an origin without a path');
  }

  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new Error('server.publicURL must use HTTPS for non-loopback hosts');
  }

  return parsed.origin;
}

function validateAiBaseURL(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('ai.baseURL must be a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ai.baseURL protocol must be http or https');
  }

  if (parsed.username || parsed.password) {
    throw new Error('ai.baseURL must not contain credentials');
  }

  if (parsed.search || parsed.hash) {
    throw new Error('ai.baseURL must not contain query parameters or fragments');
  }

  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new Error('ai.baseURL must use HTTPS for non-loopback hosts');
  }

  const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

export function buildServerConfig(
  parsed: Record<string, unknown>,
  configDir: string
): ServerConfig {
  const server = (typeof parsed['server'] === 'object' && parsed['server'] !== null)
    ? (parsed['server'] as Record<string, unknown>)
    : {};
  const amazon = (typeof parsed['amazon'] === 'object' && parsed['amazon'] !== null)
    ? (parsed['amazon'] as Record<string, unknown>)
    : {};
  const ai = (typeof parsed['ai'] === 'object' && parsed['ai'] !== null)
    ? (parsed['ai'] as Record<string, unknown>)
    : {};

  const host = typeof server['host'] === 'string' && server['host'].trim()
    ? server['host'].trim()
    : DEFAULT_CONFIG.host;

  let port = DEFAULT_CONFIG.port;
  if (server['port'] !== undefined) {
    const rawPort = Number(server['port']);
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new Error(`Invalid server.port: ${rawPort}`);
    }
    port = rawPort;
  }

  const rawPublicURL = typeof server['publicURL'] === 'string' && server['publicURL'].trim()
    ? server['publicURL'].trim()
    : DEFAULT_CONFIG.publicURL;
  const publicURL = validatePublicURL(rawPublicURL);

  const rawDbPath = typeof server['databasePath'] === 'string' && server['databasePath'].trim()
    ? server['databasePath'].trim()
    : 'data/margintalk.sqlite';
  const databasePath = resolve(configDir, rawDbPath);

  const clientId = typeof amazon['clientId'] === 'string' ? amazon['clientId'].trim() : '';
  const clientSecret = typeof amazon['clientSecret'] === 'string' ? amazon['clientSecret'].trim() : '';

  const rawAiBaseUrl = typeof ai['baseURL'] === 'string' ? ai['baseURL'].trim() : '';
  const baseURL = rawAiBaseUrl ? validateAiBaseURL(rawAiBaseUrl) : '';

  const apiKey = typeof ai['apiKey'] === 'string' ? ai['apiKey'].trim() : '';
  const model = typeof ai['model'] === 'string' ? ai['model'].trim() : '';
  const reasoningEffort = typeof ai['reasoningEffort'] === 'string' ? ai['reasoningEffort'].trim() : '';

  return {
    host,
    port,
    publicURL,
    databasePath,
    amazon: {
      clientId,
      clientSecret
    },
    ai: {
      baseURL,
      apiKey,
      model,
      reasoningEffort
    }
  };
}

/**
 * Loads server configuration from the specified path, MARGINTALK_CONFIG env var,
 * or ./margintalk.config.toml. Falls back to safe defaults only if the default file does not exist.
 * Explicitly provided paths that do not exist will throw an error to prevent silently running
 * with unauthenticated/unconfigured settings.
 */
export async function loadConfig(explicitPath?: string): Promise<ServerConfig> {
  const isExplicit = Boolean(explicitPath || process.env.MARGINTALK_CONFIG);
  const candidatePath = explicitPath || process.env.MARGINTALK_CONFIG || resolve(process.cwd(), 'margintalk.config.toml');
  const resolvedPath = resolve(process.cwd(), candidatePath);

  if (!existsSync(resolvedPath)) {
    if (isExplicit) {
      throw new Error(`Explicit configuration file not found at ${resolvedPath}`);
    }
    return { ...DEFAULT_CONFIG };
  }

  const content = readFileSync(resolvedPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(content);
  } catch {
    throw new Error('Failed to parse TOML configuration: Invalid TOML syntax');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Configuration must be a valid TOML document table');
  }

  return buildServerConfig(parsed as Record<string, unknown>, dirname(resolvedPath));
}
