import {
  Controller, Get, Patch, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { NotificacoesService } from './notificacoes.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('notificacoes')
export class NotificacoesController {
  constructor(private readonly notificacoesService: NotificacoesService) {}

  // GET /api/v1/notificacoes — lista notificações não lidas da loja logada
  @Get()
  listar(@UsuarioAtual() usuario: any) {
    return this.notificacoesService.listarNaoLidas(usuario.lojaId);
  }

  // PATCH /api/v1/notificacoes/:id/lida — marca notificação como lida
  @Patch(':id/lida')
  @HttpCode(HttpStatus.OK)
  marcarLida(@Param('id') id: string, @UsuarioAtual() usuario: any) {
    return this.notificacoesService.marcarComoLida(id, usuario.lojaId);
  }
}
