import { resolve, sep } from 'node:path';

/** Serve only the built client and the application's fixed auth/API routes. */
export function createRuntimeFetch(
  apiFetch: (request: Request) => Promise<Response>,
  distDirectory: string,
  publicURL: string
): (request: Request) => Promise<Response> {
  const root = resolve(distDirectory);
  const secure = new URL(publicURL).protocol === 'https:';
  return async (request) => {
    const path = new URL(request.url).pathname;
    let response: Response;
    if (path === '/api' || path.startsWith('/api/') || path === '/auth' || path.startsWith('/auth/')) {
      response = await apiFetch(request);
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      response = new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    } else {
      let decoded: string;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        return new Response('Invalid path', { status: 400 });
      }
      const segments = decoded.split('/');
      const unsafe = decoded.includes('\\') || decoded.includes('\0') || segments.some((part) => part.startsWith('.'));
      const filePath = resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`);
      if (unsafe || !filePath.startsWith(root + sep)) {
        response = new Response('Not found', { status: 404 });
      } else {
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          response = new Response(decoded === '/' ? 'Client build missing. Run bun run build.' : 'Not found', { status: 404 });
        } else {
          response = new Response(request.method === 'HEAD' ? null : file, {
            headers: {
              'Content-Type': file.type,
              'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
            }
          });
        }
      }
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join('; '));
    if (secure) headers.set('Strict-Transport-Security', 'max-age=31536000');
    if (path.startsWith('/api/') || path.startsWith('/auth/')) {
      const cacheControl = headers.get('Cache-Control');
      if (!cacheControl?.includes('no-store')) {
        headers.set('Cache-Control', cacheControl ? `${cacheControl}, no-store` : 'no-store');
      }
      if (headers.get('Content-Type')?.includes('text/event-stream')) headers.set('X-Accel-Buffering', 'no');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
