import {
  Controller, UseGuards, Get, Post, Patch, Delete,
  Param, Body, Query, ParseUUIDPipe,
} from '@nestjs/common';
import { LembretesService } from './lembretes.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('lembretes')
export class LembretesController {
  constructor(private readonly lembretesService: LembretesService) {}

  // GET /api/v1/lembretes?status=agendado
  // O query param status é opcional — sem ele, retorna todos
  @Get()
  listar(@UsuarioAtual() usuario: any, @Query('status') status?: string) {
    return this.lembretesService.listar(usuario.lojaId, status);
  }

  // GET /api/v1/lembretes/resumo?dias=30  ou  ?desde=2025-07-01&ate=2025-07-31
  @Get('resumo')
  resumo(
    @UsuarioAtual() usuario: any,
    @Query('dias') dias?: string,
    @Query('desde') desde?: string,
    @Query('ate') ate?: string,
  ) {
    return this.lembretesService.resumoPorPeriodo(
      usuario.lojaId,
      dias ? parseInt(dias, 10) : undefined,
      desde,
      ate,
    );
  }

  // GET /api/v1/lembretes/:id
  @Get(':id')
  buscar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lembretesService.buscarPorId(id, usuario.lojaId);
  }

  // POST /api/v1/lembretes/agendar
  // Agenda manualmente um lembrete para um ciclo
  @Post('agendar')
  agendar(
    @Body() body: { cicloId: string; agendadoPara?: string },
    @UsuarioAtual() usuario: any,
  ) {
    const quando = body.agendadoPara ? new Date(body.agendadoPara) : undefined;
    return this.lembretesService.agendar(body.cicloId, usuario.lojaId, quando);
  }

  // PATCH /api/v1/lembretes/:id/cancelar
  @Patch(':id/cancelar')
  cancelar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lembretesService.cancelar(id, usuario.lojaId);
  }
}
