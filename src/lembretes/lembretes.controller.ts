import {
  Controller, UseGuards, Get, Post, Patch, Delete,
  Param, Body, Query, ParseUUIDPipe, BadRequestException,
} from '@nestjs/common';
import { LembretesService } from './lembretes.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('lembretes')
export class LembretesController {
  constructor(
    private readonly lembretesService: LembretesService,
    private readonly whatsappService: WhatsappService,
  ) {}

  // GET /api/v1/lembretes?status=agendado
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

  // GET /api/v1/lembretes/represados
  @Get('represados')
  listarRepresados(@UsuarioAtual() usuario: any) {
    return this.lembretesService.listarRepresados(usuario.lojaId);
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
  @Post('agendar')
  agendar(
    @Body() body: { cicloId: string; agendadoPara?: string },
    @UsuarioAtual() usuario: any,
  ) {
    const quando = body.agendadoPara ? new Date(body.agendadoPara) : undefined;
    return this.lembretesService.agendar(body.cicloId, usuario.lojaId, quando);
  }

  // POST /api/v1/lembretes/represados/enviar-todos
  @Post('represados/enviar-todos')
  async enviarTodosRepresados(@UsuarioAtual() usuario: any) {
    if (!this.whatsappService.estaConectado()) {
      throw new BadRequestException('WhatsApp desconectado — conecte antes de enviar');
    }
    const lista = await this.lembretesService.listarRepresados(usuario.lojaId);
    const resultados = { enviados: 0, erros: 0 };
    for (const l of lista) {
      try {
        await this.whatsappService.enviarLembrete({
          telefone:      l.clienteTelefone,
          clienteNome:   l.clienteNome,
          produtoNome:   l.produtoNome,
          quantidade:    l.quantidade,
          unidade:       l.produtoUnidade,
          lembreteId:    l.id,
          lojaId:        usuario.lojaId,
        });
        await this.lembretesService.marcarRepresadoEnviado(l.id);
        resultados.enviados++;
      } catch {
        resultados.erros++;
      }
    }
    return resultados;
  }

  // POST /api/v1/lembretes/:id/enviar-represado
  @Post(':id/enviar-represado')
  async enviarRepresado(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() usuario: any,
  ) {
    if (!this.whatsappService.estaConectado()) {
      throw new BadRequestException('WhatsApp desconectado — conecte antes de enviar');
    }
    const l = await this.lembretesService.buscarRepresadoParaEnvio(id, usuario.lojaId);
    await this.whatsappService.enviarLembrete({
      telefone:    l.clienteTelefone,
      clienteNome: l.clienteNome,
      produtoNome: l.produtoNome,
      quantidade:  l.quantidade,
      unidade:     l.produtoUnidade,
      lembreteId:  l.id,
      lojaId:      usuario.lojaId,
    });
    await this.lembretesService.marcarRepresadoEnviado(id);
    return { enviado: true };
  }

  // PATCH /api/v1/lembretes/:id/cancelar
  @Patch(':id/cancelar')
  cancelar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lembretesService.cancelar(id, usuario.lojaId);
  }

  // DELETE /api/v1/lembretes/:id/descartar
  @Delete(':id/descartar')
  descartar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lembretesService.descartarRepresado(id, usuario.lojaId);
  }
}
