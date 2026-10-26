import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app';
import type { ServerConfig } from '../../server/config';
import type { SessionInfo } from '../../src/lib/contracts';
import { createMockServices } from './mock-services';

export function createTestEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), 'margintalk-test-'));
  const services = createMockServices();
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    publicURL: 'http://127.0.0.1:4010',
    databasePath: join(directory, 'accounts.sqlite'),
    amazon: { clientId: 'test-client', clientSecret: 'test-secret' },
    ai: { baseURL: `${services.origin}/v1`, apiKey: 'test-ai-secret', model: 'test-model', reasoningEffort: 'max' }
  };
  let app = createApp(config, { amazonEndpoints: services.amazonEndpoints });

  class Client {
    readonly cookies = new Map<string, string>();
    csrfToken: string | null = null;
    lastCallback: string | null = null;
    lastOAuthCookies = '';
    get cookieHeader() { return Array.from(this.cookies, ([key, value]) => `${key}=${value}`).join('; '); }
    async request(path: string, method = 'GET', body?: unknown, extraHeaders?: HeadersInit) {
      const headers = new Headers({ Origin: config.publicURL, Cookie: this.cookieHeader });
      if (this.csrfToken) headers.set('X-CSRF-Token', this.csrfToken);
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
      const response = await app.fetch(new Request(new URL(path, config.publicURL), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      }));
      for (const cookie of response.headers.getSetCookie()) {
        const first = cookie.split(';')[0]!;
        const equals = first.indexOf('=');
        const name = first.slice(0, equals);
        const value = first.slice(equals + 1);
        if (/max-age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      return response;
    }
    async login(account: 'alice' | 'bob') {
      const start = await this.request('/auth/amazon');
      const location = start.headers.get('location');
      if (!location) throw new Error(`OAuth start did not redirect: ${start.status}`);
      const authorization = new URL(location);
      authorization.searchParams.set('account', account);
      const grant = await fetch(authorization, { redirect: 'manual' });
      const callback = grant.headers.get('location');
      if (!callback) throw new Error(`Protocol provider rejected authorization: ${grant.status}`);
      this.lastCallback = callback;
      this.lastOAuthCookies = this.cookieHeader;
      const completed = await this.request(callback);
      if (completed.status !== 302 && completed.status !== 303) throw new Error(`OAuth callback failed: ${completed.status} ${await completed.text()}`);
      const response = await this.request('/api/session');
      const session = await response.json() as SessionInfo;
      if (!session.user || !session.csrfToken) throw new Error('OAuth did not establish an authenticated session');
      this.csrfToken = session.csrfToken;
      return session;
    }
  }

  return {
    config, services, directory,
    get app() { return app; },
    client() { return new Client(); },
    restart() {
      app.close();
      app = createApp(config, { amazonEndpoints: services.amazonEndpoints });
    },
    close() {
      services.close();
      app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
