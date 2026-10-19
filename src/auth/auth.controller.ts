// Auth controller. Handles all authentication-related HTTP routes.
// Exposes: POST /auth/register, POST /auth/login, GET /auth/profile,
//          POST /auth/google, POST /auth/facebook, POST /auth/apple,
//          POST /auth/forgot-password, GET /auth/reset-password, POST /auth/reset-password
import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Res,
  Headers,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { FacebookLoginDto } from './dto/facebook-login.dto';
import { AppleLoginDto } from './dto/apple-login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserEntity } from '../user/entities/user.entity';

// Builds the self-contained HTML reset-password form.
// Using @Res() on the GET route bypasses ResponseInterceptor so raw HTML is returned.
function buildResetPasswordHtml(token: string): string {
  const safeToken = (token ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset Your Password — Earth DNA</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: Arial, sans-serif;
      background: #f4f4f7;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background: #fff;
      border-radius: 10px;
      padding: 40px 48px;
      box-shadow: 0 4px 20px rgba(0,0,0,.1);
      width: 100%;
      max-width: 440px;
    }
    .logo {
      text-align: center;
      font-size: 13px;
      font-weight: bold;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #1a1a2e;
      margin-bottom: 28px;
    }
    h1 { margin: 0 0 8px; font-size: 22px; color: #1a1a2e; }
    p  { color: #666; font-size: 14px; margin: 0 0 24px; }
    label {
      display: block;
      font-size: 13px;
      font-weight: bold;
      color: #333;
      margin-bottom: 6px;
    }
    input[type="password"] {
      width: 100%;
      padding: 11px 14px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 15px;
      margin-bottom: 18px;
      transition: border-color .2s;
    }
    input[type="password"]:focus { outline: none; border-color: #0f3460; }
    button {
      width: 100%;
      padding: 13px;
      background: #0f3460;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 15px;
      font-weight: bold;
      cursor: pointer;
      transition: background .2s;
    }
    button:hover { background: #1a1a2e; }
    button:disabled { background: #999; cursor: not-allowed; }
    .msg {
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 6px;
      font-size: 14px;
      display: none;
    }
    .msg.success { background: #e6f4ea; color: #2e7d32; }
    .msg.error   { background: #fdecea; color: #c62828; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Earth DNA</div>
    <h1>Reset Your Password</h1>
    <p>Enter and confirm your new password below.</p>

    <form id="resetForm">
      <input type="hidden" id="token" value="${safeToken}" />

      <label for="newPassword">New Password</label>
      <input
        type="password"
        id="newPassword"
        placeholder="Min. 8 characters"
        required
        minlength="8"
        maxlength="72"
      />

      <label for="confirmPassword">Confirm Password</label>
      <input
        type="password"
        id="confirmPassword"
        placeholder="Repeat your new password"
        required
        minlength="8"
        maxlength="72"
      />

      <button type="submit" id="submitBtn">Set New Password</button>
      <div class="msg" id="msg"></div>
    </form>
  </div>

  <script>
    document.getElementById('resetForm').addEventListener('submit', async function (e) {
      e.preventDefault();

      const token       = document.getElementById('token').value;
      const newPassword = document.getElementById('newPassword').value;
      const confirmPwd  = document.getElementById('confirmPassword').value;
      const msg         = document.getElementById('msg');
      const btn         = document.getElementById('submitBtn');

      msg.style.display = 'none';

      if (newPassword !== confirmPwd) {
        msg.className = 'msg error';
        msg.textContent = 'Passwords do not match. Please try again.';
        msg.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Processing…';

      try {
        // POST to the same pathname (GET and POST share /auth/reset-password)
        const res  = await fetch(window.location.origin + window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, newPassword, confirmPassword: confirmPwd }),
        });

        const data = await res.json();

        if (res.ok) {
          msg.className = 'msg success';
          msg.textContent =
            data.data?.message ||
            'Password reset successfully! You can now log in with your new password.';
          msg.style.display = 'block';
          btn.textContent = 'Done ✓';
        } else {
          msg.className = 'msg error';
          msg.textContent = data.message || 'Something went wrong. Please try again.';
          msg.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Set New Password';
        }
      } catch {
        msg.className = 'msg error';
        msg.textContent = 'Network error. Please check your connection and try again.';
        msg.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Set New Password';
      }
    });
  </script>
</body>
</html>`;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({
    status: 201,
    description: 'User registered successfully',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  register(
    @Body() dto: RegisterDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthResponseDto> {
    return this.authService.register(dto, userAgent);
  }

  @Post('login')
  // Brute-force protection (SECURITY-12). Until ThrottlerGuard was registered in
  // app.module.ts this route had no limit at all, and neither did any other.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  login(
    @Body() dto: LoginDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthResponseDto> {
    return this.authService.login(dto, userAgent);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for new tokens' })
  @ApiResponse({
    status: 200,
    description: 'New access and refresh tokens issued',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired, or reused refresh token',
  })
  refresh(
    @Body() dto: RefreshTokenDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refreshToken, userAgent);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a single session (refresh token)' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  logout(@Body() dto: RefreshTokenDto): Promise<{ message: string }> {
    return this.authService.logout(dto.refreshToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke all sessions for the current user' })
  @ApiResponse({
    status: 200,
    description: 'Logged out of all sessions successfully',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  logoutAll(@CurrentUser('sub') userId: string): Promise<{ message: string }> {
    return this.authService.logoutAll(userId);
  }

  @Post('google')
  // Looser than /login: no secret is being guessed here, and mobile clients
  // legitimately retry on flaky networks.
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with a Google ID token' })
  @ApiResponse({
    status: 200,
    description:
      'Sign-in successful. Identical response shape to POST /auth/login.',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'idToken missing or malformed body',
  })
  @ApiResponse({
    status: 401,
    description:
      'Invalid, expired, or wrong-audience token; or the Google email is unverified',
  })
  @ApiResponse({
    status: 403,
    description:
      'ADMIN_PASSWORD_LOGIN_ONLY — the matching account is the admin, which signs in with POST /auth/login only',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  googleLogin(
    @Body() dto: GoogleLoginDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthResponseDto> {
    return this.authService.googleLogin(dto, userAgent);
  }

  @Post('facebook')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sign in with a Facebook token (Limited Login JWT on iOS, classic access token on Android)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Sign-in successful. Identical response shape to POST /auth/login.',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'accessToken missing or malformed body',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired, or wrong-app token',
  })
  @ApiResponse({
    status: 422,
    description: 'Token is valid but the Facebook account has no email address',
  })
  @ApiResponse({
    status: 403,
    description:
      'ADMIN_PASSWORD_LOGIN_ONLY — the matching account is the admin, which signs in with POST /auth/login only',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  facebookLogin(
    @Body() dto: FacebookLoginDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthResponseDto> {
    return this.authService.facebookLogin(dto, userAgent);
  }

  @Post('apple')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with an Apple identity token' })
  @ApiResponse({
    status: 200,
    description:
      'Sign-in successful. Identical response shape to POST /auth/login.',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'identityToken missing or malformed body',
  })
  @ApiResponse({
    status: 401,
    description:
      'Invalid, expired, or wrong-audience token; or the Apple email is unverified',
  })
  @ApiResponse({
    status: 403,
    description:
      'ADMIN_PASSWORD_LOGIN_ONLY — the matching account is the admin, which signs in with POST /auth/login only',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  appleLogin(
    @Body() dto: AppleLoginDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthResponseDto> {
    return this.authService.appleLogin(dto, userAgent);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token') // ← matches the name in DocumentBuilder
  @ApiOperation({ summary: 'Get the logged-in user profile' })
  @ApiResponse({
    status: 200,
    description: 'Profile returned successfully',
    type: UserEntity,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  getProfile(@CurrentUser('sub') userId: string): Promise<UserEntity> {
    return this.authService.getProfile(userId);
  }

  // ─── Password Reset ────────────────────────────────────────────────────────

  @Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset email' })
  @ApiResponse({
    status: 200,
    description: 'If the email is registered, a reset link has been sent',
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({
    status: 429,
    description: 'Too many requests — max 3 requests per minute',
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    await this.authService.forgotPassword(dto.email);
    // Always return the same message — never reveal whether the email exists
    return {
      message:
        'If an account with that email exists, a password reset link has been sent.',
    };
  }

  // Serves the HTML reset-password form in the browser.
  // Uses @Res() to return raw HTML — this intentionally bypasses ResponseInterceptor.
  @Get('reset-password')
  @ApiOperation({ summary: 'Render the HTML password reset form' })
  @ApiResponse({ status: 200, description: 'HTML form page' })
  resetPasswordForm(@Query('token') token: string, @Res() res: Response): void {
    res.type('html').send(buildResetPasswordHtml(token));
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using a valid token' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({
    status: 400,
    description: 'Passwords do not match / Invalid or expired token',
  })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    await this.authService.resetPassword(
      dto.token,
      dto.newPassword,
      dto.confirmPassword,
    );
    return {
      message:
        'Your password has been reset successfully. You may now log in with your new password.',
    };
  }
}
