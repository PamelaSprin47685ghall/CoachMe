import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config';

test('server configuration reads native TOML secrets and resolves database paths beside the config file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'margintalk-config-'));
  const path = join(directory, 'server.toml');
  try {
    writeFileSync(path, `[server]\nport = 3100\npublicURL = "https://reader.example.com/"\ndatabasePath = "private/cloud.sqlite"\n[amazon]\nclientId = "configured-client"\nclientSecret = 'secret#literal'\n[ai]\nbaseURL = "https://model.example.com/v1/"\napiKey = 'key#literal'\nmodel = "configured-model"\nreasoningEffort = "max"\n`);
    const config = await loadConfig(path);
    expect(config.publicURL).toBe('https://reader.example.com');
    expect(config.databasePath).toBe(join(directory, 'private/cloud.sqlite'));
    expect(config.amazon.clientSecret).toBe('secret#literal');
    expect(config.ai.apiKey).toBe('key#literal');
    expect(config.ai.baseURL).toBe('https://model.example.com/v1');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([
  'http://reader.example.com',
  'https://reader.example.com/path',
  'https://user:secret@reader.example.com',
  'https://reader.example.com?redirect=elsewhere',
  'https://reader.example.com#fragment'
])('rejects unsafe configured public origin %s', async (origin) => {
  const directory = mkdtempSync(join(tmpdir(), 'margintalk-config-'));
  const path = join(directory, 'server.toml');
  try {
    writeFileSync(path, `[server]\npublicURL = ${JSON.stringify(origin)}\n`);
    await expect(loadConfig(path)).rejects.toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('explicit missing configuration does not silently disable authentication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'margintalk-config-'));
  try {
    await expect(loadConfig(join(directory, 'absent.toml'))).rejects.toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
