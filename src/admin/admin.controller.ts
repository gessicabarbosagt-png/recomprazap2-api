import {
  Controller, UseGuards, Get, Post, Patch, Param, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import {
  IsString, IsEmail, IsOptional, IsBoolean, IsNumber, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

class CriarLojaDto {
  @IsString() lojaNome: string;
  @IsEmail()  lojaEmail: string;
  @IsString() usuarioNome: string;
  @IsEmail()  usuarioEmail: string;
}

class AtualizarLojaDto {
  @IsOptional() @IsString() plano?: string;
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
  constructor(private readonly adminService: AdminService) {}

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
  criarLoja(@Body() dto: CriarLojaDto) {
    return this.adminService.criarLoja(dto);
  }

  // GET /api/v1/admin/lojas/:id — detalhe da loja
  @Get('lojas/:id')
  detalharLoja(@Param('id') id: string) {
    return this.adminService.detalharLoja(id);
  }

  // PATCH /api/v1/admin/lojas/:id — atualiza assinatura
  @Patch('lojas/:id')
  @HttpCode(HttpStatus.OK)
  atualizarLoja(@Param('id') id: string, @Body() dto: AtualizarLojaDto) {
    return this.adminService.atualizarLoja(id, dto);
  }

  // PATCH /api/v1/admin/lojas/:id/ativar — ativa ou desativa
  @Patch('lojas/:id/ativar')
  @HttpCode(HttpStatus.OK)
  ativarDesativar(@Param('id') id: string, @Body() dto: AtivarDesativarDto) {
    return this.adminService.ativarDesativar(id, dto.ativa);
  }

  // POST /api/v1/admin/lojas/:lojaId/usuarios/:userId/resetar-senha
  @Post('lojas/:lojaId/usuarios/:userId/resetar-senha')
  @HttpCode(HttpStatus.OK)
  resetarSenha(
    @Param('lojaId') lojaId: string,
    @Param('userId') userId: string,
  ) {
    return this.adminService.resetarSenha(lojaId, userId);
  }
}
