import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

test('development runner protects custom config and database filenames, including raw-import paths', async () => {
  const directory = mkdtempSync(join(process.cwd(), 'margintalk-private-test-'));
  const configPath = join(directory, 'settings.private');
  const databasePath = join(directory, 'accounts.private');
  const marker = 'private-dev-security-fixture';
  const seeded = new Database(databasePath, { create: true });
  seeded.run('CREATE TABLE private_fixture (value TEXT)');
  seeded.query('INSERT INTO private_fixture VALUES (?)').run(marker);
  seeded.close();
  const reservations = Array.from({ length: 2 }, () => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 404 }) }));
  const apiPort = reservations[0]!.port;
  const clientPort = reservations[1]!.port;
  for (const reservation of reservations) reservation.stop(true);
  const origin = `http://127.0.0.1:${clientPort}`;
  writeFileSync(configPath, `[server]\nhost = "127.0.0.1"\nport = ${apiPort}\npublicURL = "${origin}"\ndatabasePath = "accounts.private"\n[ai]\napiKey = "${marker}"\n`);
  let worker: Pick<Bun.Subprocess, 'kill' | 'exited'> | null = null;
  try {
    const child = Bun.spawn([process.execPath, 'run', 'dev', '--', '--port', String(clientPort), '--host', '127.0.0.1', '--strictPort'], {
      cwd: process.cwd(),
      env: { ...process.env, MARGINTALK_CONFIG: configPath, NO_COLOR: '1' },
      stdout: 'pipe', stderr: 'pipe'
    });
    worker = child;
    // Safety deadline for real process startup only; stdout readiness, not a sleep, drives the test.
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    try {
      while (!output.includes(`http://127.0.0.1:${apiPort}/`) || !output.includes(origin + '/')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Development runner failed: ${await new Response(child.stderr).text()}`);
        output += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(deadline); reader.releaseLock(); }
    const sessionResponse = await fetch(origin + '/api/session');
    expect(sessionResponse.status).toBe(200);
    const sessionText = await sessionResponse.text();
    expect(sessionText).not.toContain(marker);
    expect(JSON.parse(sessionText)).toMatchObject({ user: null, authConfigured: false });
    const configURL = '/' + relative(process.cwd(), configPath).replaceAll('\\', '/');
    const databaseURL = '/' + relative(process.cwd(), databasePath).replaceAll('\\', '/');
    for (const path of [configURL, configURL + '?raw', '/@fs' + configPath, databaseURL, databaseURL + '?raw', databaseURL + '-wal', '/server/config.ts']) {
      const response = await fetch(origin + path);
      expect([403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(marker);
    }
    expect((await fetch(origin + '/src/main.ts')).status).toBe(200);
  } finally {
    if (worker) { worker.kill('SIGTERM'); await worker.exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
