// F4 + F6 My Shoes reads. Exports ShoeViewMapper so ScanModule's F3 review
// response renders the entry exactly as the list does. ShoeEntity is also in
// ScanModule's forFeature because F3 is what writes it.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { ShoeEntity } from './entities/shoe.entity';
import { ShoeViewMapper } from './shoe-view.mapper';
import { ShoesController } from './shoes.controller';
import { ShoesService } from './shoes.service';

@Module({
  imports: [AuthModule, StorageModule, TypeOrmModule.forFeature([ShoeEntity])],
  controllers: [ShoesController],
  providers: [ShoesService, ShoeViewMapper],
  exports: [ShoeViewMapper],
})
export class ShoesModule {}
