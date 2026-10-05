// The success envelope must report the status the client actually receives.
// The regression this guards: statusCode used to be snapshotted BEFORE the
// handler ran, so a route that sets its own status (POST .../result answers 201
// on create, 200 on replace) shipped a body that contradicted the status line.
import { of } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ResponseInterceptor } from './response.interceptor';

function contextWith(res: { statusCode: number }): ExecutionContext {
  return {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('ResponseInterceptor', () => {
  it('wraps the handler result in the standard envelope', async () => {
    const res = { statusCode: 200 };
    const handler = { handle: () => of({ id: 'abc' }) } as CallHandler;
    const out = await firstValueFrom(
      new ResponseInterceptor().intercept(contextWith(res), handler),
    );
    expect(out).toMatchObject({
      statusCode: 200,
      message: 'Success',
      data: { id: 'abc' },
    });
    expect(typeof out.timestamp).toBe('string');
  });

  it('reports a status the handler set while running, not the one before it', async () => {
    const res = { statusCode: 200 };
    const handler = {
      handle: () => {
        res.statusCode = 201; // what @Res({ passthrough: true }) does
        return of({ created: true });
      },
    } as CallHandler;
    const out = await firstValueFrom(
      new ResponseInterceptor().intercept(contextWith(res), handler),
    );
    expect(out.statusCode).toBe(201);
  });

  it('still reports a static @HttpCode, which Nest applies before intercept', async () => {
    const res = { statusCode: 201 };
    const handler = { handle: () => of(null) } as CallHandler;
    const out = await firstValueFrom(
      new ResponseInterceptor().intercept(contextWith(res), handler),
    );
    expect(out.statusCode).toBe(201);
  });
});
