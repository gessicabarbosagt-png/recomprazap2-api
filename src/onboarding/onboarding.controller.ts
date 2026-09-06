import {
  Controller, UseGuards, Post, Get,
  Body, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  // GET /api/v1/onboarding/checklist
  @Get('checklist')
  checklist(@UsuarioAtual() usuario: any) {
    return this.onboardingService.checklist(usuario.lojaId);
  }

  // POST /api/v1/onboarding/enviar-teste
  @Post('enviar-teste')
  @HttpCode(HttpStatus.OK)
  enviarTeste(
    @Body() body: { telefone?: string },
    @UsuarioAtual() usuario: any,
  ) {
    if (!body?.telefone?.trim()) {
      throw new BadRequestException('Informe o número de telefone');
    }
    return this.onboardingService.enviarTeste(usuario.lojaId, body.telefone.trim());
  }
}
