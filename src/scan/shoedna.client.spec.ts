// Transport tests for ShoeDnaClient with a mocked global fetch: the request it
// builds (path, auth, version header, no redirects), the response size cap,
// and how each failure maps to the two error types the service turns into
// 502 / 504.
import { ConfigService } from '@nestjs/config';
import type { ActiveIntegration } from '../integrations/integration.view';
import {
  SecretResolver,
  SecretUnavailableError,
} from '../integrations/secret-resolver';
import {
  InferenceFailedError,
  InferenceTimeoutError,
  MAX_RESPONSE_BYTES,
  ShoeDnaClient,
} from './shoedna.client';

const ACTIVE: ActiveIntegration = {
  name: 'shoedna',
  baseUrl: 'https://shoedna.example.com/v2/',
  version: 'v2.1',
  authRef: 'earthdna/be/shoedna-api-key-dev2',
};
const REQUEST = {
  scanId: 's1',
  shoeId: 'h1',
  photos: [
    { view: 'top' as const, url: 'https://signed', contentType: 'image/jpeg' },
  ],
};

describe('ShoeDnaClient', () => {
  const fetchMock = jest.fn();
  const resolve = jest.fn();
  let client: ShoeDnaClient;

  beforeEach(() => {
    fetchMock.mockReset();
    resolve.mockReset().mockResolvedValue('sk-secret');
    global.fetch = fetchMock;
    const secrets = { resolve } as unknown as SecretResolver;
    const config = {
      get: () => ({ inferenceTimeoutMs: 1000 }),
    } as unknown as ConfigService;
    client = new ShoeDnaClient(secrets, config);
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it('POSTs the request to {baseUrl}/identify with auth and version headers', async () => {
    fetchMock.mockResolvedValue(json({ brand: 'Nike' }));
    await expect(client.identify(ACTIVE, REQUEST)).resolves.toEqual({
      brand: 'Nike',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://shoedna.example.com/v2/identify');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-secret',
      'X-Model-Version': 'v2.1',
    });
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
    expect(resolve).toHaveBeenCalledWith('earthdna/be/shoedna-api-key-dev2');
  });

  it('sends no Authorization header when the integration has no authRef', async () => {
    fetchMock.mockResolvedValue(json({}));
    await client.identify({ ...ACTIVE, authRef: null, version: null }, REQUEST);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.headers).not.toHaveProperty('X-Model-Version');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a non-2xx answer is InferenceFailedError', async () => {
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));
    await expect(client.identify(ACTIVE, REQUEST)).rejects.toBeInstanceOf(
      InferenceFailedError,
    );
  });

  it('a network error is InferenceFailedError', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(client.identify(ACTIVE, REQUEST)).rejects.toBeInstanceOf(
      InferenceFailedError,
    );
  });

  it('a body that is not JSON is InferenceFailedError', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(client.identify(ACTIVE, REQUEST)).rejects.toBeInstanceOf(
      InferenceFailedError,
    );
  });

  it('a body over the cap by content-length is InferenceFailedError', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
      }),
    );
    await expect(client.identify(ACTIVE, REQUEST)).rejects.toThrow(
      'response too large',
    );
  });

  it('a streamed body over the cap (no content-length) is InferenceFailedError', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Never-ending stream: the cap, not EOF, must stop the read.
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));
    await expect(client.identify(ACTIVE, REQUEST)).rejects.toThrow(
      'response too large',
    );
    expect(sent).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 2 * chunk.byteLength);
  });

  it('an aborted (timed-out) call is InferenceTimeoutError', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    await expect(client.identify(ACTIVE, REQUEST)).rejects.toBeInstanceOf(
      InferenceTimeoutError,
    );
  });

  it('a credential failure surfaces before any HTTP call', async () => {
    resolve.mockRejectedValue(new SecretUnavailableError('x'));
    await expect(client.identify(ACTIVE, REQUEST)).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
