import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AtividadeLogService } from './atividade-log.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('atividade-log')
export class AtividadeLogController {
  constructor(private readonly atividadeLogService: AtividadeLogService) {}

  // GET /api/v1/atividade-log?limite=6
  @Get()
  listar(
    @UsuarioAtual() usuario: any,
    @Query('limite') limite?: string,
  ) {
    const lim = limite ? Math.min(50, parseInt(limite, 10)) : 6;
    return this.atividadeLogService.listarRecentes(usuario.lojaId, lim);
  }
}
