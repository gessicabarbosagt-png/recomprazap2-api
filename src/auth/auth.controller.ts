import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

// Todas as rotas deste controller ficam em: POST /api/v1/auth/...
@Controller('auth')
export class AuthController {
  // O NestJS injeta o AuthService automaticamente aqui
  constructor(private readonly authService: AuthService) {}

  // POST /api/v1/auth/login
  // O @HttpCode garante que retorna 200 (não 201 que é o padrão do POST)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() loginDto: LoginDto) {
    // O Controller só repassa para o Service — sem lógica aqui
    return this.authService.login(loginDto);
  }
}
