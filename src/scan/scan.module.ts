// F1 scan sessions + F2 identification results: entities, services, controllers,
// abandon job. Multer limits come from scan config so uploads are capped before
// bytes pile up in memory. F2 adds no Multer or storage dependency — results are
// plain JSON and must keep working when SHOE_PHOTOS_BUCKET is unset.
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
import { ScanShoeResultEntity } from './entities/scan-shoe-result.entity';
import { ScanAbandonJob } from './scan-abandon.job';
import { ScanController } from './scan.controller';
import { ScanResultController } from './scan-result.controller';
import { ScanService } from './scan.service';
import { ScanResultService } from './scan-result.service';

@Module({
  imports: [
    AuthModule,
    StorageModule,
    TypeOrmModule.forFeature([
      ScanEntity,
      ScanShoeEntity,
      ScanPhotoEntity,
      ScanShoeResultEntity,
    ]),
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
  controllers: [ScanController, ScanResultController],
  providers: [ScanService, ScanResultService, ScanAbandonJob],
})
export class ScanModule {}
