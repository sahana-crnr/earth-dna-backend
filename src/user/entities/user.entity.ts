// Defines the "users" table schema. Maps each property to a database column.
// Password is excluded from query results and API responses for security.
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

@Entity('users')
export class UserEntity {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ example: 'Jane Doe' })
  @Column({ type: 'varchar', length: 255 })
  fullName: string;

  @ApiProperty({ example: 'jane@example.com' })
  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Exclude()
  @Column({ type: 'varchar', length: 255, select: false })
  password: string;

  @ApiProperty({ example: 'USA' })
  @Column({ type: 'varchar', length: 100 })
  country: string;

  @ApiProperty({ example: '10001', nullable: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  zipCode: string | null;

  @ApiProperty()
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn()
  updatedAt: Date;
}
