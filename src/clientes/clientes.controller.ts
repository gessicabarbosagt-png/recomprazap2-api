import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ClientesService } from './clientes.service';
import { CriarClienteDto } from './dto/criar-cliente.dto';
import { AtualizarClienteDto } from './dto/atualizar-cliente.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('clientes')
export class ClientesController {
  constructor(private readonly clientesService: ClientesService) {}

  // GET /api/v1/clientes
  @Get()
  listar(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.clientesService.listar(usuario.lojaId);
  }

  // GET /api/v1/clientes/origens?dias=30
  // IMPORTANTE: deve vir antes de :id para não ser capturado como ID
  @Get('origens')
  origensResumo(
    @UsuarioAtual() usuario: UsuarioLogado,
    @Query('dias') dias?: string,
  ) {
    return this.clientesService.origensResumo(usuario.lojaId, Number(dias ?? 30));
  }

  // GET /api/v1/clientes/:id
  @Get(':id')
  buscarPorId(
    @Param('id') id: string,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    return this.clientesService.buscarPorId(id, usuario.lojaId);
  }

  // POST /api/v1/clientes
  @Post()
  criar(
    @Body() dto: CriarClienteDto,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    return this.clientesService.criar(dto, usuario.lojaId);
  }

  // PATCH /api/v1/clientes/:id
  @Patch(':id')
  atualizar(
    @Param('id') id: string,
    @Body() dto: AtualizarClienteDto,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    return this.clientesService.atualizar(id, dto, usuario.lojaId);
  }

  // DELETE /api/v1/clientes/:id
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remover(
    @Param('id') id: string,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    return this.clientesService.remover(id, usuario.lojaId);
  }
}
