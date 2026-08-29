import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // GET /api/v1/dashboard/serie-temporal?dias=30 | ?desde=YYYY-MM-DD&ate=YYYY-MM-DD
  @Get('serie-temporal')
  serieTemporal(
    @UsuarioAtual() usuario: any,
    @Query('dias') dias?: string,
    @Query('desde') desde?: string,
    @Query('ate') ate?: string,
  ) {
    const diasAtras = dias ? parseInt(dias, 10) : undefined;
    return this.dashboardService.serieTemporal(
      usuario.lojaId,
      diasAtras,
      desde,
      ate,
    );
  }

  // GET /api/v1/dashboard/etapas-resumo?dias=30 | ?desde=YYYY-MM-DD&ate=YYYY-MM-DD
  @Get('etapas-resumo')
  resumoEtapas(
    @UsuarioAtual() usuario: any,
    @Query('dias') dias?: string,
    @Query('desde') desde?: string,
    @Query('ate') ate?: string,
  ) {
    const diasAtras = dias ? parseInt(dias, 10) : undefined;
    return this.dashboardService.resumoEtapas(
      usuario.lojaId,
      diasAtras,
      desde,
      ate,
    );
  }
}
