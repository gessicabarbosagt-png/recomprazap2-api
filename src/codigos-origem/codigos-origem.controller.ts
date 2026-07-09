import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { CodigosOrigemService } from './codigos-origem.service';
import { CriarCodigoDto } from './dto/criar-codigo.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('codigos-origem')
export class CodigosOrigemController {
  constructor(private readonly service: CodigosOrigemService) {}

  @Get()
  listar(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.service.listar(usuario.lojaId);
  }

  @Post()
  criar(
    @Body() dto: CriarCodigoDto,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    return this.service.criar(dto, usuario.lojaId);
  }

  @Patch(':id')
  atualizar(
    @Param('id') id: string,
    @Body() dto: Partial<CriarCodigoDto>,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    return this.service.atualizar(id, dto, usuario.lojaId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remover(
    @Param('id') id: string,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    return this.service.remover(id, usuario.lojaId);
  }
}
