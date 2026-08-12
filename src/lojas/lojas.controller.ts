import {
  Controller, UseGuards, Get, Patch, Delete, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { LojasService } from './lojas.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';
import { IsString, IsBoolean, IsOptional, IsEmail } from 'class-validator';

class AtualizarModeloDto {
  @IsString() modeloMensagem: string;
}

class AtualizarConfiguracaoInboxDto {
  @IsBoolean() confirmarLeituraWa: boolean;
}

class AtualizarPerfilDto {
  @IsOptional() @IsString() nomeUsuario?: string;
  @IsOptional() @IsString() nomeLoja?: string;
}

class AlterarEmailDto {
  @IsEmail() novoEmail: string;
  @IsString() senhaAtual: string;
}

class AlterarSenhaDto {
  @IsString() senhaAtual: string;
  @IsString() novaSenha: string;
}

class ExcluirContaDto {
  @IsString() nomeLoja: string;
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

  // PATCH /api/v1/lojas/minha/configuracao — atualiza configurações de comportamento
  @Patch('minha/configuracao')
  @HttpCode(HttpStatus.OK)
  atualizarConfiguracaoInbox(
    @Body() dto: AtualizarConfiguracaoInboxDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lojasService.atualizarConfiguracaoInbox(usuario.lojaId, dto.confirmarLeituraWa);
  }

  // PATCH /api/v1/lojas/minha/perfil — atualiza nome do lojista e/ou nome da loja
  @Patch('minha/perfil')
  @HttpCode(HttpStatus.OK)
  atualizarPerfil(
    @Body() dto: AtualizarPerfilDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lojasService.atualizarPerfil(usuario.id, usuario.lojaId, dto);
  }

  // PATCH /api/v1/lojas/minha/alterar-email — altera e-mail de login
  @Patch('minha/alterar-email')
  @HttpCode(HttpStatus.OK)
  alterarEmail(
    @Body() dto: AlterarEmailDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lojasService.alterarEmail(usuario.id, dto.novoEmail, dto.senhaAtual);
  }

  // PATCH /api/v1/lojas/minha/alterar-senha — altera senha
  @Patch('minha/alterar-senha')
  @HttpCode(HttpStatus.OK)
  alterarSenha(
    @Body() dto: AlterarSenhaDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lojasService.alterarSenha(usuario.id, dto.senhaAtual, dto.novaSenha);
  }

  // DELETE /api/v1/lojas/minha — soft-delete: desativa loja e usuários
  @Delete('minha')
  @HttpCode(HttpStatus.OK)
  excluirConta(
    @Body() dto: ExcluirContaDto,
    @UsuarioAtual() usuario: any,
  ) {
    return this.lojasService.excluirConta(usuario.id, usuario.lojaId, dto.nomeLoja);
  }
}
