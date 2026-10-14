// F7 model integration settings. Exports IntegrationsService so the later
// server-side ShoeDNA (F2) and ValueLens (F5) callers read their endpoint via
// getActive() instead of from env.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { IntegrationEntity } from './entities/integration.entity';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([IntegrationEntity])],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
