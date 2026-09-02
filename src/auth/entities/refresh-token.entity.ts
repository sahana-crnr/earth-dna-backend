// Defines the "refresh_tokens" table schema — one row per active session/device.
// Stores only the SHA-256 hash of the raw refresh token (never the raw value),
// mirroring the resetPasswordToken pattern on UserEntity. Rotation is tracked via
// revokedAt + replacedByTokenId so a reused (already-rotated) token can be detected.
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { UserEntity } from '../../user/entities/user.entity';

@Entity('refresh_tokens')
export class RefreshTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  // SHA-256 hex digest of the raw token (64 chars). Never expose the raw token.
  @Exclude()
  @Column({ type: 'varchar', length: 64, select: false })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  // Set when the token is rotated (on refresh) or explicitly revoked (on logout).
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  // Points to the token that superseded this one during rotation. Used to trace
  // the rotation chain when reuse of an already-rotated token is detected.
  @Column({ type: 'uuid', nullable: true })
  replacedByTokenId: string | null;

  // Optional session metadata to help identify the device.
  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
