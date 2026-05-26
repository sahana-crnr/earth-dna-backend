// User service. Handles all database operations for the users table —
// finding by email, finding by id, finding with password for auth, and creating records.
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async findById(id: string): Promise<UserEntity> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { email } });
  }

  // Explicitly selects the password column (select: false by default).
  // Only use this method when you need to verify a password (i.e. login).
  findByEmailWithPassword(email: string): Promise<UserEntity | null> {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email })
      .getOne();
  }

  create(dto: CreateUserDto): Promise<UserEntity> {
    const user = this.userRepo.create(dto);
    return this.userRepo.save(user);
  }
}
