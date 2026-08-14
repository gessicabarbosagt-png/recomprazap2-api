import {
  Controller, UseGuards, Get, Post, Delete, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { PlanosService } from './planos.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

// Catálogo público — sem autenticação
@Controller('planos')
export class PlanosCatalogoController {
  constructor(private readonly planosService: PlanosService) {}

  // GET /api/v1/planos/catalogo
  @Get('catalogo')
  listarCatalogo() {
    return this.planosService.listarCatalogo();
  }
}

// Endpoints do lojista — requerem JWT
@UseGuards(JwtAuthGuard)
@Controller('lojas/minha/plano')
export class PlanosLojistaController {
  constructor(private readonly planosService: PlanosService) {}

  // GET /api/v1/lojas/minha/plano
  @Get()
  buscarPlano(@UsuarioAtual() usuario: any) {
    return this.planosService.buscarPlanoLoja(usuario.lojaId);
  }

  // POST /api/v1/lojas/minha/plano/upgrade
  @Post('upgrade')
  @HttpCode(HttpStatus.OK)
  fazerUpgrade(@Body('planoSlug') planoSlug: string, @UsuarioAtual() usuario: any) {
    return this.planosService.fazerUpgrade(usuario.lojaId, planoSlug);
  }

  // POST /api/v1/lojas/minha/plano/downgrade
  @Post('downgrade')
  @HttpCode(HttpStatus.OK)
  agendarDowngrade(@Body('planoSlug') planoSlug: string, @UsuarioAtual() usuario: any) {
    return this.planosService.agendarDowngrade(usuario.lojaId, planoSlug);
  }

  // DELETE /api/v1/lojas/minha/plano/downgrade-pendente
  @Delete('downgrade-pendente')
  @HttpCode(HttpStatus.OK)
  cancelarDowngrade(@UsuarioAtual() usuario: any) {
    return this.planosService.cancelarDowngradePendente(usuario.lojaId);
  }
}
