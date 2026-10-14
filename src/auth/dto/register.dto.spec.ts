// F7: a role can never be self-assigned at sign-up. RegisterDto has no `role`
// field, and the global ValidationPipe (same options as main.ts) rejects any
// unknown property rather than stripping it.
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RegisterDto } from './register.dto';

describe('RegisterDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const body = {
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    password: 'Str0ngPassw0rd!',
    country: 'USA',
  };
  const run = (value: object) =>
    pipe.transform(value, { type: 'body', metatype: RegisterDto });

  it('accepts a normal registration', async () => {
    await expect(run(body)).resolves.toBeInstanceOf(RegisterDto);
  });

  it('rejects a body that tries to set role', async () => {
    await expect(run({ ...body, role: 'ADMIN' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
