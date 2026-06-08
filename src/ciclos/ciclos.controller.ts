import {
  Controller, UseGuards, Get, Post, Patch, Delete,
  Param, Body, ParseUUIDPipe,
} from '@nestjs/common';
import { CiclosService, CriarCicloDto, AtualizarCicloDto } from './ciclos.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

// Todas as rotas deste controller ficam em: /api/v1/ciclos
// Todas exigem JWT — @UseGuards aplicado na classe inteira
@UseGuards(JwtAuthGuard)
@Controller('ciclos')
export class CiclosController {
  constructor(private readonly ciclosService: CiclosService) {}

  // GET /api/v1/ciclos
  // Lista todos os ciclos da loja do usuário logado
  @Get()
  listar(@UsuarioAtual() usuario: any) {
    return this.ciclosService.listar(usuario.lojaId);
  }

  // GET /api/v1/ciclos/:id
  @Get(':id')
  buscar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() usuario: any,
  ) {
    return this.ciclosService.buscarPorId(id, usuario.lojaId);
  }

  // POST /api/v1/ciclos
  @Post()
  criar(@Body() dto: CriarCicloDto, @UsuarioAtual() usuario: any) {
    return this.ciclosService.criar(dto, usuario.lojaId);
  }

  // PATCH /api/v1/ciclos/:id
  @Patch(':id')
  atualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarCicloDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.ciclosService.atualizar(id, dto, usuario.lojaId);
  }

  // DELETE /api/v1/ciclos/:id
  @Delete(':id')
  remover(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() usuario: any,
  ) {
    return this.ciclosService.remover(id, usuario.lojaId);
  }
}
