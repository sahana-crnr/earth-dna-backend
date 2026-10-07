// "scan_shoe_results" table: the ShoeDNA identification of one scan shoe (F2).
//
// Exactly one row per shoe (UNIQUE scanShoeId) — the upsert contract made
// structural, so a retried submit can never leave two results behind. The
// condition LABEL is derived in result-rules.ts and deliberately not stored:
// the label scale is still provisional (plan §8, open point 7).
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import {
  CONDITION_CODES,
  IDENTIFICATION_OUTCOMES,
  IDENTIFICATION_SOURCES,
  type ConditionCode,
  type IdentificationOutcome,
  type IdentificationSource,
} from '../scan.types';
import { ScanShoeEntity } from './scan-shoe.entity';

@Entity('scan_shoe_results')
@Unique('UQ_scan_shoe_results_shoe', ['scanShoeId'])
@Check(
  'CHK_scan_shoe_results_confidence',
  '"confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)',
)
@Check(
  'CHK_scan_shoe_results_identified',
  `"outcome" <> 'identified' OR ("brand" IS NOT NULL AND "confidence" IS NOT NULL)`,
)
export class ScanShoeResultEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  scanShoeId: string;

  @OneToOne(() => ScanShoeEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'scanShoeId',
    foreignKeyConstraintName: 'FK_scan_shoe_results_shoe',
  })
  shoe?: ScanShoeEntity;

  /** Set server-side, never from the request body: a client cannot claim 'server'. */
  @Column({
    type: 'enum',
    enum: IDENTIFICATION_SOURCES,
    enumName: 'identification_source',
  })
  source: IdentificationSource;

  @Column({
    type: 'enum',
    enum: IDENTIFICATION_OUTCOMES,
    enumName: 'identification_outcome',
    default: 'identified',
  })
  outcome: IdentificationOutcome;

  /** Which ShoeDNA build produced this. Persisted so results stay comparable
   *  after a model upgrade (plan §5, item 4). */
  @Column({ type: 'varchar', length: 64 })
  modelVersion: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  brand: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  subBrand: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  model: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  colorway: string | null;

  /** 0..1. numeric, not float: the app renders a percent and must not see drift. */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 4,
    nullable: true,
    transformer: {
      to: (v: number | null) => v,
      // pg returns numeric as a string to preserve precision.
      from: (v: string | null) => (v === null ? null : Number(v)),
    },
  })
  confidence: number | null;

  @Column({
    type: 'enum',
    enum: CONDITION_CODES,
    enumName: 'shoe_condition_code',
    nullable: true,
  })
  conditionCode: ConditionCode | null;

  /** Ranked top-N, normalised by result-rules.normalizeCandidates. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  candidates: { brand: string; model: string | null; confidence: number }[];

  /** Anything else ShoeDNA sent, stored verbatim while the contract is open. */
  @Column({ type: 'jsonb', nullable: true })
  raw: Record<string, unknown> | null;

  /** When the server accepted this submit (server clock; the client cannot set
   *  it). Rewritten on every replace, unlike createdAt. The default
   *  mirrors the DEFAULT now() in the migration — without it TypeORM sees the
   *  SQL default as drift and migration:generate emits a spurious ALTER. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  submittedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
