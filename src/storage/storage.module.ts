// Provides PhotoStorage (S3-backed) to feature modules.
import { Module } from '@nestjs/common';
import { PhotoStorage } from './photo-storage';
import { S3PhotoStorage } from './s3-photo-storage';

@Module({
  providers: [{ provide: PhotoStorage, useClass: S3PhotoStorage }],
  exports: [PhotoStorage],
})
export class StorageModule {}
