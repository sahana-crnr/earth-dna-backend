// F7 model integration settings. Exports IntegrationsService so the
// server-side ShoeDNA (F2 analyze) and later ValueLens (F5) callers read their
// endpoint via getActive() instead of from env, and SecretResolver so they turn
// the stored authRef into the credential the same way.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AwsSecretResolver } from './aws-secret-resolver';
import { IntegrationEntity } from './entities/integration.entity';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { SecretResolver } from './secret-resolver';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([IntegrationEntity])],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    { provide: SecretResolver, useClass: AwsSecretResolver },
  ],
  exports: [IntegrationsService, SecretResolver],
})
export class IntegrationsModule {}
