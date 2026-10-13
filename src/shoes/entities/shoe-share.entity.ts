// "shoe_shares": one public link per My Shoes entry (F5-D11). `token` is the
// whole secret; GET /s/{token} needs no login. Revoking sets revokedAt — the
// row is kept so viewCount and history survive. Links never expire (Q16-B);
// expiresAt stays nullable for a later policy change without a migration.
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ShoeEntity } from './shoe.entity';

@Entity('shoe_shares')
@Index('UQ_shoe_shares_token', ['token'], { unique: true })
@Index('UQ_shoe_shares_active', ['shoeId'], {
  unique: true,
  where: '"revokedAt" IS NULL',
})
export class ShoeShareEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  shoeId: string;

  @ManyToOne(() => ShoeEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'shoeId',
    foreignKeyConstraintName: 'FK_shoe_shares_shoe',
  })
  shoe?: ShoeEntity;

  @Column({ type: 'varchar', length: 64 })
  token: string;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  viewCount: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
