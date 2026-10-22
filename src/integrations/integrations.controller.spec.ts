// HTTP-level access test for /admin/integrations (F7). RolesGuard has its own
// unit test, but only a request through the real controller proves the routes
// are actually guarded: dropping @UseGuards or @Roles('ADMIN') must fail here.
//
// Real JwtAuthGuard (real JwtService, real signatures), real RolesGuard, and
// the same ValidationPipe / filter as main.ts. Only the DB-facing services are
// faked, so no database is needed.
import {
  INestApplication,
  Logger,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AllExceptionsFilter } from '../common/filters/http-exception.filter';
import { UserService } from '../user/user.service';
import type { UserRole } from '../user/user-roles';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

const SECRET = 'integrations-controller-spec-secret';
const ROLES: Record<string, UserRole> = {
  'admin-id': 'ADMIN',
  'user-id': 'USER',
};

describe('IntegrationsController access (F7)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const integrations = {
    list: jest.fn().mockResolvedValue({ items: [] }),
    update: jest.fn().mockResolvedValue({ name: 'shoedna' }),
  };

  beforeAll(async () => {
    // AllExceptionsFilter logs every 4xx; the statuses are asserted instead.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      controllers: [IntegrationsController],
      providers: [
        JwtAuthGuard,
        RolesGuard,
        { provide: IntegrationsService, useValue: integrations },
        {
          provide: UserService,
          useValue: {
            findById: (id: string) =>
              ROLES[id]
                ? Promise.resolve({ id, role: ROLES[id] })
                : Promise.reject(new NotFoundException()),
            // JwtAuthGuard: no password resets in these tests.
            getPasswordChangedAt: () => Promise.resolve(null),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  beforeEach(() => jest.clearAllMocks());

  // The token claims USER for the admin and ADMIN for the user on purpose:
  // RolesGuard must decide from the DB row, never from the claim.
  const bearer = (sub: string, claimedRole: UserRole) =>
    `Bearer ${jwt.sign({ sub, email: `${sub}@earthdna.test`, role: claimedRole })}`;
  const asAdmin = () => bearer('admin-id', 'USER');
  const asUser = () => bearer('user-id', 'ADMIN');

  const routes = [
    ['GET', () => request(app.getHttpServer()).get('/admin/integrations')],
    [
      'PUT',
      () =>
        request(app.getHttpServer())
          .put('/admin/integrations/shoedna')
          .send({ version: '2.3.0' }),
    ],
  ] as const;

  describe.each(routes)('%s /admin/integrations', (_, send) => {
    it('401 without a token', async () => {
      await send().expect(401);
      expect(integrations.list).not.toHaveBeenCalled();
      expect(integrations.update).not.toHaveBeenCalled();
    });

    it('401 with a token signed by another secret', async () => {
      const forged = new JwtService({ secret: 'not-the-secret' }).sign({
        sub: 'admin-id',
        role: 'ADMIN',
      });
      await send().set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('403 FORBIDDEN_ROLE for a USER, even one whose token claims ADMIN', async () => {
      const res = await send().set('Authorization', asUser()).expect(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN_ROLE' });
      expect(integrations.list).not.toHaveBeenCalled();
      expect(integrations.update).not.toHaveBeenCalled();
    });

    it('403 for a token whose account no longer exists', async () => {
      await send().set('Authorization', bearer('gone-id', 'ADMIN')).expect(403);
    });

    it('200 for the ADMIN', async () => {
      await send().set('Authorization', asAdmin()).expect(200);
    });
  });

  it('PUT passes the admin id and body through to the service', async () => {
    await request(app.getHttpServer())
      .put('/admin/integrations/shoedna')
      .set('Authorization', asAdmin())
      .send({ authRef: 'earthdna/be/shoedna-api-key-dev2' })
      .expect(200);
    expect(integrations.update).toHaveBeenCalledWith(
      'shoedna',
      { authRef: 'earthdna/be/shoedna-api-key-dev2' },
      'admin-id',
    );
  });

  // Both fields are echoed back by GET, so a credential must never get in.
  describe('PUT body rejects values that would store a credential', () => {
    const put = (body: object) =>
      request(app.getHttpServer())
        .put('/admin/integrations/shoedna')
        .set('Authorization', asAdmin())
        .send(body);

    it.each([
      'https://user:key@shoedna.example.com/v2',
      'https://key@shoedna.example.com/v2',
      'https://shoedna.example.com/v2?api_key=abc',
      'https://shoedna.example.com/v2#key=abc',
      'http://shoedna.example.com/v2',
    ])('baseUrl %s → 400', async (baseUrl) => {
      await put({ baseUrl }).expect(400);
      expect(integrations.update).not.toHaveBeenCalled();
    });

    it.each([
      'https://shoedna.example.com',
      'https://shoedna.example.com:8443/v2/identify',
    ])('baseUrl %s → 200', async (baseUrl) => {
      await put({ baseUrl }).expect(200);
    });

    it.each([
      'sk-live-51HxAbCdEf',
      'be/shoedna-api-key',
      'earthdna/',
      'earthdna/key with spaces',
      'arn:aws:secretsmanager:eu-west-1:123:secret:earthdna/x',
    ])('authRef %s → 400', async (authRef) => {
      await put({ authRef }).expect(400);
      expect(integrations.update).not.toHaveBeenCalled();
    });

    it.each(['earthdna/be/shoedna-api-key-dev2', 'earthdna/valuelens_v2+prod'])(
      'authRef %s → 200',
      async (authRef) => {
        await put({ authRef }).expect(200);
      },
    );

    it('null still clears both fields', async () => {
      await put({ baseUrl: null, authRef: null }).expect(200);
    });
  });
});
