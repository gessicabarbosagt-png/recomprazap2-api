import {
  Controller, UseGuards, Get, Patch, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { LojasService } from './lojas.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';
import { IsString } from 'class-validator';

class AtualizarModeloDto {
  @IsString() modeloMensagem: string;
}

@UseGuards(JwtAuthGuard)
@Controller('lojas')
export class LojasController {
  constructor(private readonly lojasService: LojasService) {}

  // GET /api/v1/lojas/minha — dados da loja do usuário logado
  @Get('minha')
  minha(@UsuarioAtual() usuario: any) {
    return this.lojasService.buscarMinha(usuario.lojaId);
  }

  // PATCH /api/v1/lojas/minha/modelo-mensagem — atualiza template de lembrete
  @Patch('minha/modelo-mensagem')
  @HttpCode(HttpStatus.OK)
  atualizarModelo(
    @Body() dto: AtualizarModeloDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lojasService.atualizarModeloMensagem(usuario.lojaId, dto.modeloMensagem);
  }
}
