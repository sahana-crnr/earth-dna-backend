// DTO for the POST /auth/register endpoint. Inherits all fields and validation
// rules from CreateUserDto. Kept separate so auth-specific fields (e.g. confirmPassword)
// can be added later without touching the user DTO.
import { CreateUserDto } from '../../user/dto/create-user.dto';

export class RegisterDto extends CreateUserDto {}
