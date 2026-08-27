import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
  UseInterceptors, UploadedFile, Res, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as multer from 'multer';
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
  @Get('origens')
  origensResumo(
    @UsuarioAtual() usuario: UsuarioLogado,
    @Query('dias') dias?: string,
    @Query('desde') desde?: string,
    @Query('ate') ate?: string,
  ) {
    return this.clientesService.origensResumo(
      usuario.lojaId,
      dias ? Number(dias) : undefined,
      desde,
      ate,
    );
  }

  // GET /api/v1/clientes/exportar-csv
  @Get('exportar-csv')
  async exportarCsv(
    @UsuarioAtual() usuario: UsuarioLogado,
    @Res() res: Response,
  ) {
    const csv = await this.clientesService.exportarCsv(usuario.lojaId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
    res.send(csv);
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

  // POST /api/v1/clientes/importar-csv
  @Post('importar-csv')
  @UseInterceptors(
    FileInterceptor('arquivo', {
      storage: multer.memoryStorage(),
      limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
    }),
  )
  async importarCsv(
    @UploadedFile() arquivo: Express.Multer.File,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    if (!arquivo) throw new BadRequestException('Nenhum arquivo enviado');
    return this.clientesService.importarCsv(arquivo, usuario.lojaId);
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
