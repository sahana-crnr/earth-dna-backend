// E26 — the public share page. No login: the token is the whole secret.
// Answers a static HTML page (OpenGraph tags, no script) unless the client
// explicitly prefers application/json, so a pasted link previews as the pair.
import { Controller, Get, HttpStatus, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { renderShareHtml } from './share.view';
import { shareUrl } from './share-rules';
import { apiBaseOf } from './shoes.controller';
import { ShoesService } from './shoes.service';

const PUBLIC_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
};
const HTML_CSP =
  "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

@ApiTags('My Shoes (F5)')
@Throttle({ default: { limit: 60, ttl: 60000 } })
@Controller('s')
export class ShareController {
  constructor(private readonly shoes: ShoesService) {}

  @Get(':token')
  @ApiOperation({
    summary: 'E26 — public shoe profile by share token (no auth)',
    description:
      'JSON (default) or HTML when Accept prefers text/html. brand, model, shoe type, colour, condition grade + label, resale range, recommended action, primary photo. No user data. 404 when the link is unknown, revoked or the shoe was removed.',
  })
  @ApiResponse({ status: 200, description: 'Public view (JSON or HTML)' })
  @ApiResponse({ status: 404, description: 'SHARE_NOT_FOUND' })
  async view(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const view = await this.shoes.publicView(token);
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) res.setHeader(k, v);
    // HTML unless the client explicitly prefers JSON: `Accept: */*` (or none)
    // is what link unfurlers send, and they need the OpenGraph page (PR 15).
    const wantsHtml = req.accepts(['html', 'json']) !== 'json';
    if (!view) {
      res.status(HttpStatus.NOT_FOUND);
      if (wantsHtml) {
        res.setHeader('Content-Security-Policy', HTML_CSP);
        res
          .type('html')
          .send(
            '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;padding:24px">This shoe profile is no longer shared.</p>',
          );
      } else {
        res.json({
          statusCode: HttpStatus.NOT_FOUND,
          code: 'SHARE_NOT_FOUND',
          message: 'This shoe profile is no longer shared',
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
        });
      }
      return;
    }
    if (wantsHtml) {
      const pageUrl = shareUrl(
        this.shoes.shareBase(apiBaseOf(req, '/s/')),
        token,
      );
      res.setHeader('Content-Security-Policy', HTML_CSP);
      res
        .status(HttpStatus.OK)
        .type('html')
        .send(renderShareHtml(view, pageUrl));
      return;
    }
    // Same envelope as every other JSON response (the global interceptor is
    // bypassed when @Res() is used).
    res.status(HttpStatus.OK).json({
      statusCode: HttpStatus.OK,
      message: 'Success',
      data: view,
      timestamp: new Date().toISOString(),
    });
  }
}
