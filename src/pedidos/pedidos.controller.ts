import {
  Controller, UseGuards, Get, Patch,
  Param, Body, Query, ParseUUIDPipe,
} from '@nestjs/common';
import { PedidosService, AtualizarPedidoDto } from './pedidos.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('pedidos')
export class PedidosController {
  constructor(private readonly pedidosService: PedidosService) {}

  // GET /api/v1/pedidos?status=pendente
  @Get()
  listar(@UsuarioAtual() usuario: any, @Query('status') status?: string) {
    return this.pedidosService.listar(usuario.lojaId, status);
  }

  // GET /api/v1/pedidos/resumo?dias=30
  @Get('resumo')
  resumo(@UsuarioAtual() usuario: any, @Query('dias') dias = '30') {
    return this.pedidosService.resumoPorPeriodo(usuario.lojaId, parseInt(dias, 10));
  }

  // GET /api/v1/pedidos/:id
  @Get(':id')
  buscar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() usuario: any,
  ) {
    return this.pedidosService.buscarPorId(id, usuario.lojaId);
  }

  // PATCH /api/v1/pedidos/:id
  // Lojista confirma, marca como entregue, define forma de pagamento etc.
  @Patch(':id')
  atualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarPedidoDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.pedidosService.atualizar(id, dto, usuario.lojaId);
  }
}
