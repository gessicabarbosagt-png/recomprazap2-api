import {
  Controller, UseGuards, Get, Post, Patch, Delete,
  Param, Body, ParseUUIDPipe,
} from '@nestjs/common';
import { ProdutosService, CriarProdutoDto, AtualizarProdutoDto } from './produtos.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('produtos')
export class ProdutosController {
  constructor(private readonly produtosService: ProdutosService) {}

  @Get()
  listar(@UsuarioAtual() usuario: any) {
    return this.produtosService.listar(usuario.lojaId);
  }

  @Get(':id')
  buscar(@Param('id', ParseUUIDPipe) id: string, @UsuarioAtual() usuario: any) {
    return this.produtosService.buscarPorId(id, usuario.lojaId);
  }

  @Post()
  criar(@Body() dto: CriarProdutoDto, @UsuarioAtual() usuario: any) {
    return this.produtosService.criar(dto, usuario.lojaId);
  }

  @Patch(':id')
  atualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarProdutoDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.produtosService.atualizar(id, dto, usuario.lojaId);
  }

  @Delete(':id')
  remover(@Param('id', ParseUUIDPipe) id: string, @UsuarioAtual() usuario: any) {
    return this.produtosService.remover(id, usuario.lojaId);
  }
}
