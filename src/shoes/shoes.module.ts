// F5 My Shoes: profile, edit, photos, share, rescan, condition feedback. Also
// owns the ShoeValueProvider binding (static placeholder today) and the two
// hooks ScanModule's review transaction calls, so ScanModule imports this
// module and never the other way round (no cycle).
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import type { ScanConfig } from '../config/scan.config';
import { ScanEntity } from '../scan/entities/scan.entity';
import { ScanPhotoEntity } from '../scan/entities/scan-photo.entity';
import { ScanShoeEntity } from '../scan/entities/scan-shoe.entity';
import { ShoeFeedbackEntity } from '../scan/entities/shoe-feedback.entity';
import { StorageModule } from '../storage/storage.module';
import { ShoeEntity } from './entities/shoe.entity';
import { ShoePhotoEntity } from './entities/shoe-photo.entity';
import { ShoeShareEntity } from './entities/shoe-share.entity';
import { ShareController } from './share.controller';
import { ShoesController } from './shoes.controller';
import { ShoesService } from './shoes.service';
import { SHOE_VALUE_PROVIDER } from './value/shoe-value.provider';
import { StaticValueProvider } from './value/static-value.provider';

@Module({
  imports: [
    AuthModule,
    StorageModule,
    CatalogModule,
    TypeOrmModule.forFeature([
      ShoeEntity,
      ShoePhotoEntity,
      ShoeShareEntity,
      ShoeFeedbackEntity,
      ScanEntity,
      ScanShoeEntity,
      ScanPhotoEntity,
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
            files: 1,
            fields: 2,
            fieldSize: 4 * 1024,
            parts: 4,
          },
        };
      },
    }),
  ],
  controllers: [ShoesController, ShareController],
  providers: [
    ShoesService,
    StaticValueProvider,
    { provide: SHOE_VALUE_PROVIDER, useExisting: StaticValueProvider },
  ],
  exports: [ShoesService, SHOE_VALUE_PROVIDER],
})
export class ShoesModule {}
