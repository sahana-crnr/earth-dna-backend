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

/** How the account was created. Drives whether password login is possible. */
export type AuthProvider = 'local' | 'google';

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

  // Nullable since Google Sign-In: those accounts never have a password.
  // Anything comparing this MUST null-check first - bcrypt.compare throws on null.
  @Exclude()
  @Column({ type: 'varchar', length: 255, select: false, nullable: true })
  password: string | null;

  @Exclude()
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  resetPasswordToken: string | null;

  @Exclude()
  @Column({ type: 'timestamptz', nullable: true })
  resetPasswordExpiry: Date | null;

  // Nullable since Google Sign-In: a Google ID token carries no country.
  @ApiProperty({ example: 'USA', nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string | null;

  @ApiProperty({ example: '+1', nullable: true })
  @Column({ type: 'varchar', length: 10, nullable: true })
  countryCode: string | null;

  @ApiProperty({ example: '10001', nullable: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  zipCode: string | null;

  // Internal only. Deliberately @Exclude()d: the auth response shape is a fixed
  // contract with the mobile app, and adding an unrequested field to it is a
  // contract change. Easy to expose later if the app ever wants it.
  @Exclude()
  @Column({ type: 'varchar', length: 20, default: 'local' })
  authProvider: AuthProvider;

  @ApiProperty()
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn()
  updatedAt: Date;
}
