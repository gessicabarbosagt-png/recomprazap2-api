import {
  Controller, Post, Get, Body, HttpCode, HttpStatus, Req, Res, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';

const COOKIE_NAME = 'recomprazap_token';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieOptions(maxAge: number): Record<string, unknown> {
  return {
    httpOnly: true,
    // Em desenvolvimento local não há HTTPS, então Secure só vai em produção.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    // COOKIE_DOMAIN deve ser ".recomprazap.com.br" no Railway para compartilhar entre subdomínios.
    // Omitido em dev (defaults para o host que definiu o cookie — localhost).
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    maxAge,
    path: '/',
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /api/v1/auth/login
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(loginDto, req.ip ?? 'desconhecido');

    res.cookie(COOKIE_NAME, result.accessToken, cookieOptions(COOKIE_MAX_AGE_MS));

    // Token fica exclusivamente no cookie HttpOnly — não retornado no corpo.
    return { usuario: result.usuario };
  }

  // GET /api/v1/auth/me — fonte de verdade do frontend para saber quem está logado
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.authService.getMe(usuario);
  }

  // POST /api/v1/auth/logout
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(COOKIE_NAME, cookieOptions(0));
  }
}
