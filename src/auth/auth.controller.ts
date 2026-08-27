import { Controller, Post, Body, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /api/v1/auth/login
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() loginDto: LoginDto, @Req() req: Request) {
    return this.authService.login(loginDto, req.ip ?? 'desconhecido');
  }
}
