import {
  Controller, UseGuards, Get, Post, Patch, Param, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';
import {
  IsString, IsEmail, IsOptional, IsBoolean, IsNumber, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

class EnviarNotificacaoDto {
  @IsString() mensagem: string;
}

class CriarLojaDto {
  @IsString() lojaNome: string;
  @IsEmail()  lojaEmail: string;
  @IsString() usuarioNome: string;
  @IsEmail()  usuarioEmail: string;
}

class AtualizarLojaDto {
  @IsOptional() @IsString() plano?: string;
  @IsOptional() @IsString() planoSlug?: string | null;
  @IsOptional() @IsIn(['ativa', 'inadimplente', 'cancelada']) statusAssinatura?: string;
  @IsOptional() @IsNumber() @Type(() => Number) valorMensalidade?: number | null;
  @IsOptional() @IsString() proximoVencimento?: string | null;
}

class AtivarDesativarDto {
  @IsBoolean() ativa: boolean;
}

@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly notificacoesService: NotificacoesService,
  ) {}

  // GET /api/v1/admin/saude — cards da home do admin
  @Get('saude')
  saude() {
    return this.adminService.resumoSaude();
  }

  // GET /api/v1/admin/lojas — lista todas as lojas
  @Get('lojas')
  listarLojas() {
    return this.adminService.listarLojas();
  }

  // POST /api/v1/admin/lojas — cria loja + usuário + seeds
  @Post('lojas')
  criarLoja(@Body() dto: CriarLojaDto, @UsuarioAtual() admin: UsuarioLogado) {
    return this.adminService.criarLoja(dto, admin.id);
  }

  // GET /api/v1/admin/lojas/:id — detalhe da loja
  @Get('lojas/:id')
  detalharLoja(@Param('id') id: string) {
    return this.adminService.detalharLoja(id);
  }

  // PATCH /api/v1/admin/lojas/:id — atualiza assinatura
  @Patch('lojas/:id')
  @HttpCode(HttpStatus.OK)
  atualizarLoja(
    @Param('id') id: string,
    @Body() dto: AtualizarLojaDto,
    @UsuarioAtual() admin: UsuarioLogado,
  ) {
    return this.adminService.atualizarLoja(id, dto, admin.id);
  }

  // PATCH /api/v1/admin/lojas/:id/ativar — ativa ou desativa
  @Patch('lojas/:id/ativar')
  @HttpCode(HttpStatus.OK)
  ativarDesativar(
    @Param('id') id: string,
    @Body() dto: AtivarDesativarDto,
    @UsuarioAtual() admin: UsuarioLogado,
  ) {
    return this.adminService.ativarDesativar(id, dto.ativa, admin.id);
  }

  // POST /api/v1/admin/lojas/:lojaId/usuarios/:userId/resetar-senha
  @Post('lojas/:lojaId/usuarios/:userId/resetar-senha')
  @HttpCode(HttpStatus.OK)
  resetarSenha(
    @Param('lojaId') lojaId: string,
    @Param('userId') userId: string,
    @UsuarioAtual() admin: UsuarioLogado,
  ) {
    return this.adminService.resetarSenha(lojaId, userId, admin.id);
  }

  // POST /api/v1/admin/notificacoes/loja/:lojaId — notifica uma loja específica
  @Post('notificacoes/loja/:lojaId')
  @HttpCode(HttpStatus.OK)
  notificarLoja(
    @Param('lojaId') lojaId: string,
    @Body() dto: EnviarNotificacaoDto,
  ) {
    return this.notificacoesService.criarParaLoja(lojaId, dto.mensagem);
  }

  // POST /api/v1/admin/notificacoes/desconectadas — notifica todas as lojas desconectadas
  @Post('notificacoes/desconectadas')
  @HttpCode(HttpStatus.OK)
  notificarDesconectadas(@Body() dto: EnviarNotificacaoDto) {
    return this.notificacoesService.criarParaDesconectadas(dto.mensagem);
  }
}
