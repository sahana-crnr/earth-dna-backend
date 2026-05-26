// Auth service. Contains authentication logic — register, login, and profile.
// Register: checks duplicate email, hashes password, saves user, returns JWT.
// Login: verifies email + password, returns JWT on success.
// getProfile: fetches fresh user data from DB using the id from the JWT payload.
import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserService } from '../user/user.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserEntity } from '../user/entities/user.entity';
import { AuthResponse } from './interfaces/auth-response.interface';

const BCRYPT_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const existing = await this.userService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);
    const user = await this.userService.create({
      ...dto,
      password: hashedPassword,
    });

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });

    return { accessToken, user };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    // Fetch user with password (select: false means it's excluded by default)
    const user = await this.userService.findByEmailWithPassword(dto.email);

    // Use a generic message for both cases to prevent user enumeration
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });

    // Remove password from the returned user object
    delete (user as Partial<typeof user>).password;

    return { accessToken, user };
  }

  getProfile(userId: string): Promise<UserEntity> {
    return this.userService.findById(userId);
  }
}
