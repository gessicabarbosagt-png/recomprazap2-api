import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';
import { GatilhosCompraService } from './gatilhos-compra.service';

@UseGuards(JwtAuthGuard)
@Controller('gatilhos-compra')
export class GatilhosCompraController {
  constructor(private readonly service: GatilhosCompraService) {}

  @Get()
  listar(@UsuarioAtual() u: any) {
    return this.service.listar(u.lojaId);
  }

  @Post()
  criar(@UsuarioAtual() u: any, @Body() dto: { frase: string }) {
    return this.service.criar(u.lojaId, dto);
  }

  @Patch(':id')
  atualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioAtual() u: any,
    @Body() dto: { frase?: string; ativo?: boolean },
  ) {
    return this.service.atualizar(id, u.lojaId, dto);
  }

  @Delete(':id')
  remover(@Param('id', ParseUUIDPipe) id: string, @UsuarioAtual() u: any) {
    return this.service.remover(id, u.lojaId);
  }
}
