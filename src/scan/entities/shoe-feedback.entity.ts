// "shoe_feedback": the training signal from one review (F3-D14). Append-only:
// never updated, never deleted. `original` is the F2 result as stored at the
// moment of review, `answer` the resolved final fields. userId goes null when
// the account is deleted (F3-D15, tracker T26); scanShoeId goes null when the
// scan is purged, so the row outlives both.
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FEEDBACK_TYPES, type FeedbackType } from '../scan.types';
import { ScanShoeEntity } from './scan-shoe.entity';
import { UserEntity } from '../../user/entities/user.entity';

@Entity('shoe_feedback')
@Index('IDX_shoe_feedback_scan_shoe', ['scanShoeId'])
@Index('IDX_shoe_feedback_user', ['userId'])
export class ShoeFeedbackEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  scanShoeId: string | null;

  @ManyToOne(() => ScanShoeEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'scanShoeId',
    foreignKeyConstraintName: 'FK_shoe_feedback_scan_shoe',
  })
  scanShoe?: ScanShoeEntity;

  /** The My Shoes entry the review created; kept as a plain id (no FK) so a
   *  removed entry never touches the training row. */
  @Column({ type: 'uuid', nullable: true })
  shoeId: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'FK_shoe_feedback_user',
  })
  user?: UserEntity;

  @Column({ type: 'enum', enum: FEEDBACK_TYPES, enumName: 'feedback_type' })
  type: FeedbackType;

  @Column({ type: 'varchar', length: 64, nullable: true })
  modelVersion: string | null;

  @Column({ type: 'jsonb' })
  original: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  answer: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
