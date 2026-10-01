// F1 scan sessions: entities, service, controller, abandon job. Multer limits
// come from scan config so uploads are capped before bytes pile up in memory.
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import type { ScanConfig } from '../config/scan.config';
import { StorageModule } from '../storage/storage.module';
import { ScanEntity } from './entities/scan.entity';
import { ScanPhotoEntity } from './entities/scan-photo.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanAbandonJob } from './scan-abandon.job';
import { ScanController } from './scan.controller';
import { ScanService } from './scan.service';

@Module({
  imports: [
    AuthModule,
    StorageModule,
    TypeOrmModule.forFeature([ScanEntity, ScanShoeEntity, ScanPhotoEntity]),
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const scan = config.get<ScanConfig>('scan')!;
        return {
          storage: memoryStorage(),
          limits: {
            fileSize: scan.photoMaxBytes,
            files: scan.albumMaxPhotos,
            fields: 5,
            fieldSize: 16 * 1024,
            parts: scan.albumMaxPhotos + 5,
          },
        };
      },
    }),
  ],
  controllers: [ScanController],
  providers: [ScanService, ScanAbandonJob],
})
export class ScanModule {}
