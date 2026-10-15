// Unit tests for the public share route (E26): content negotiation, the 404
// branches, the hardening headers and the HTML rendering (escaping, OpenGraph).
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import { ShareController } from './share.controller';
import { renderShareHtml, shareDescription, shareTitle } from './share.view';
import type { PublicShareView } from './share.view';
import { ShoesService } from './shoes.service';

const VIEW: PublicShareView = {
  brand: 'On Running',
  model: 'Cloudmonster 2 <script>',
  shoeType: 'Athletic Shoes',
  color: 'Black & "Tan"',
  condition: { grade: 'A', label: 'Lightly Worn' },
  value: { min: 65, max: 90, currency: 'USD' },
  recommendedAction: 'resell',
  photoUrl: 'https://s3.test/p.jpg?x=1&y=2',
  sharedAt: '2026-10-12T00:00:00.000Z',
};

interface FakeRes {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
  contentType: string | undefined;
  setHeader(k: string, v: string): void;
  status(code: number): FakeRes;
  type(t: string): FakeRes;
  send(b: unknown): void;
  json(b: unknown): void;
}

function fakeRes(): FakeRes & Response {
  const fake: FakeRes = {
    headers: {},
    statusCode: 200,
    body: undefined,
    contentType: undefined,
    setHeader: (k, v) => {
      fake.headers[k] = v;
    },
    status: (code) => {
      fake.statusCode = code;
      return fake;
    },
    type: (t) => {
      fake.contentType = t;
      return fake;
    },
    send: (b) => {
      fake.body = b;
    },
    json: (b) => {
      fake.body = b;
    },
  };
  return fake as unknown as FakeRes & Response;
}

function fakeReq(preferred: 'json' | 'html' | false) {
  return {
    originalUrl: '/api/v1/s/cloudmonster-2-abc123',
    url: '/api/v1/s/cloudmonster-2-abc123',
    protocol: 'http',
    get: (h: string) => (h.toLowerCase() === 'host' ? 'api.test' : undefined),
    accepts: () => preferred,
  } as unknown as Request;
}

function ctrlWith(view: PublicShareView | null) {
  const svc = {
    shareBase: (b: string) => b,
    publicView: jest.fn().mockResolvedValue(view),
  } as unknown as ShoesService;
  return new ShareController(svc);
}

describe('ShareController', () => {
  it('has no auth guard (public route)', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ShareController),
    ).toBeUndefined();
  });

  it('answers JSON when the client prefers application/json, with no-store and nosniff', async () => {
    const res = fakeRes();
    await ctrlWith(VIEW).view('cloudmonster-2-abc123', fakeReq('json'), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: unknown }).data).toEqual(VIEW);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Security-Policy']).toBeUndefined();
  });

  it('answers HTML (OpenGraph) for text/html and for */* or no Accept header', async () => {
    const any = fakeRes();
    // express answers 'html' for */* because html is first in our list
    await ctrlWith(VIEW).view('cloudmonster-2-abc123', fakeReq('html'), any);
    expect(any.contentType).toBe('html');
    const none = fakeRes();
    await ctrlWith(VIEW).view('cloudmonster-2-abc123', fakeReq(false), none);
    expect(none.contentType).toBe('html');
  });

  it('answers HTML with a CSP when the client prefers text/html', async () => {
    const res = fakeRes();
    await ctrlWith(VIEW).view('cloudmonster-2-abc123', fakeReq('html'), res);
    expect(res.statusCode).toBe(200);
    expect(res.contentType).toBe('html');
    expect(res.headers['Content-Security-Policy']).toContain(
      "default-src 'none'",
    );
    const html = String(res.body);
    expect(html).toContain(
      '<meta property="og:title" content="On Running Cloudmonster 2 &lt;script&gt;">',
    );
    expect(html).toContain(
      'og:url" content="http://api.test/api/v1/s/cloudmonster-2-abc123"',
    );
    expect(html).toContain(
      'og:image" content="https://s3.test/p.jpg?x=1&amp;y=2"',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('Black &amp; &quot;Tan&quot;');
    expect(html).toContain('$65–$90');
    expect(html).toContain('Resell this pair');
  });

  it('404s as JSON and as HTML when the link is unknown or revoked', async () => {
    const j = fakeRes();
    await ctrlWith(null).view('nope', fakeReq('json'), j);
    expect(j.statusCode).toBe(404);
    expect((j.body as { code: string }).code).toBe('SHARE_NOT_FOUND');
    const h = fakeRes();
    await ctrlWith(null).view('nope', fakeReq('html'), h);
    expect(h.statusCode).toBe(404);
    expect(String(h.body)).toContain('no longer shared');
  });
});

describe('share.view helpers', () => {
  it('title and description read like the card', () => {
    expect(shareTitle(VIEW)).toBe('On Running Cloudmonster 2 <script>');
    expect(shareDescription(VIEW)).toBe(
      'A · Lightly Worn — Est. resale value $65–$90',
    );
    expect(
      shareDescription({
        ...VIEW,
        condition: { grade: null, label: null },
        value: { min: null, max: null, currency: 'USD' },
      }),
    ).toBe('Shared from S.H.O.E.S. by EarthDNA');
  });

  it('renders without a photo', () => {
    const html = renderShareHtml({ ...VIEW, photoUrl: null }, 'http://x/s/t');
    expect(html).not.toContain('og:image');
    expect(html).toContain('aria-label="No photo"');
  });
});
