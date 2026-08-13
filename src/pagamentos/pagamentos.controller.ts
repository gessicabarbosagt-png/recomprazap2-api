import {
  Controller, UseGuards, Get, Post, Delete, Body, Param,
  HttpCode, HttpStatus, Headers, RawBodyRequest, Req,
  UnauthorizedException, BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { PagamentosService } from './pagamentos.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';
import { IsString, IsEmail, IsOptional, MinLength } from 'class-validator';

class CriarAssinaturaCartaoDto {
  @IsString() @MinLength(10) cardToken: string;
  @IsEmail() payerEmail: string;
  @IsOptional() @IsString() lastFour?: string;
}

@Controller()
export class PagamentosController {
  constructor(private readonly pagamentosService: PagamentosService) {}

  // ── Webhook público (sem JWT) ──────────────────────────────────────

  // POST /api/v1/webhooks/mercadopago
  @Post('webhooks/mercadopago')
  @HttpCode(HttpStatus.OK)
  async webhookMercadoPago(
    @Body() body: any,
    @Headers('x-signature') xSignature: string,
    @Headers('x-request-id') xRequestId: string,
  ) {
    const dataId = String(body?.data?.id ?? '');

    if (xSignature) {
      const tsMatch = xSignature.match(/ts=(\d+)/);
      const ts = tsMatch?.[1] ?? '';
      const valido = this.pagamentosService.validarAssinaturaWebhook(
        xSignature, xRequestId ?? '', dataId, ts,
      );
      if (!valido) {
        throw new UnauthorizedException('Assinatura do webhook inválida');
      }
    }

    await this.pagamentosService.processarWebhook(body);
    return { ok: true };
  }

  // ── Rotas autenticadas (lojista) ───────────────────────────────────

  // GET /api/v1/pagamentos/plano
  @UseGuards(JwtAuthGuard)
  @Get('pagamentos/plano')
  buscarStatusPlano(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.pagamentosService.buscarStatusPlano(usuario.lojaId);
  }

  // GET /api/v1/pagamentos
  @UseGuards(JwtAuthGuard)
  @Get('pagamentos')
  listarPagamentos(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.pagamentosService.listarPagamentos(usuario.lojaId);
  }

  // POST /api/v1/pagamentos/assinatura/cartao
  @UseGuards(JwtAuthGuard)
  @Post('pagamentos/assinatura/cartao')
  criarAssinaturaCartao(
    @UsuarioAtual() usuario: UsuarioLogado,
    @Body() dto: CriarAssinaturaCartaoDto,
  ) {
    return this.pagamentosService.criarAssinaturaCartao(usuario.lojaId, dto);
  }

  // POST /api/v1/pagamentos/assinatura/cartao/trocar
  @UseGuards(JwtAuthGuard)
  @Post('pagamentos/assinatura/cartao/trocar')
  trocarCartao(
    @UsuarioAtual() usuario: UsuarioLogado,
    @Body() dto: CriarAssinaturaCartaoDto,
  ) {
    return this.pagamentosService.trocarCartao(usuario.lojaId, dto);
  }

  // DELETE /api/v1/pagamentos/assinatura
  @UseGuards(JwtAuthGuard)
  @Delete('pagamentos/assinatura')
  @HttpCode(HttpStatus.OK)
  cancelarAssinatura(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.pagamentosService.cancelarAssinatura(usuario.lojaId);
  }

  // POST /api/v1/pagamentos/pix
  @UseGuards(JwtAuthGuard)
  @Post('pagamentos/pix')
  gerarPix(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.pagamentosService.gerarPixCiclo(usuario.lojaId);
  }

  // ── Rotas admin ────────────────────────────────────────────────────

  // GET /api/v1/admin/lojas/:lojaId/pagamentos
  @UseGuards(AdminGuard)
  @Get('admin/lojas/:lojaId/pagamentos')
  listarPagamentosAdmin(@Param('lojaId') lojaId: string) {
    return this.pagamentosService.listarPagamentosAdmin(lojaId);
  }
}
