// "condition_mappings": the one row per ShoeDNA code C1–C5 that every screen
// scale (Review label, Shoe Profile grade letter, Filters group) reads from.
// Seeded by the F3 migration with the provisional D7 labels so a design change
// is a data edit, not a release (tracker T18). Shares the shoe_condition_code
// enum created by F2.
import { Column, Entity, PrimaryColumn } from 'typeorm';
import { CONDITION_CODES, type ConditionCode } from '../../scan/scan.types';

@Entity('condition_mappings')
export class ConditionMappingEntity {
  @PrimaryColumn({
    type: 'enum',
    enum: CONDITION_CODES,
    enumName: 'shoe_condition_code',
  })
  code: ConditionCode;

  @Column({ type: 'varchar', length: 40 })
  label: string;

  @Column({ type: 'char', length: 1 })
  gradeLetter: string;

  @Column({ type: 'varchar', length: 120 })
  description: string;

  @Column({ type: 'varchar', length: 20 })
  filterGroup: string;

  @Column({ type: 'smallint', default: 0 })
  sortOrder: number;
}
