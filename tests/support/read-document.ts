import type { CloudDocument } from '../../src/lib/contracts';
import { parseCloudDocument } from '../../src/lib/api-client';

/** Exercise the same response validation used by the browser, then assert behavior in each scenario. */
export async function readCloudDocument(response: { json(): Promise<unknown> }): Promise<CloudDocument> {
  const body = await response.json();
  if (!body || typeof body !== 'object' || !('document' in body)) throw new Error('Missing document response');
  return parseCloudDocument(body.document);
}
