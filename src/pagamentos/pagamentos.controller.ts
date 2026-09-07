import {
  Controller, UseGuards, Get, Post, Param,
  HttpCode, HttpStatus, Headers, RawBodyRequest, Req,
  UnauthorizedException, BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { PagamentosService } from './pagamentos.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';

@Controller()
export class PagamentosController {
  constructor(private readonly pagamentosService: PagamentosService) {}

  // ── Webhook público (sem JWT) ──────────────────────────────────────

  // POST /api/v1/webhooks/stripe
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('webhooks/stripe')
  @HttpCode(HttpStatus.OK)
  async webhookStripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature) {
      throw new UnauthorizedException('Assinatura do webhook Stripe ausente');
    }
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Raw body não disponível — verifique a configuração do servidor');
    }
    let event: any;
    try {
      event = this.pagamentosService.construirEventoStripe(rawBody, signature);
    } catch (e: any) {
      throw new UnauthorizedException(`Assinatura do webhook Stripe inválida: ${e.message}`);
    }
    await this.pagamentosService.processarWebhookStripe(event);
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

  // POST /api/v1/pagamentos/stripe/checkout
  @UseGuards(JwtAuthGuard)
  @Post('pagamentos/stripe/checkout')
  criarCheckoutSession(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.pagamentosService.criarCheckoutSession(usuario.lojaId);
  }

  // ── Rotas admin ────────────────────────────────────────────────────

  // GET /api/v1/admin/lojas/:lojaId/pagamentos
  @UseGuards(AdminGuard)
  @Get('admin/lojas/:lojaId/pagamentos')
  listarPagamentosAdmin(@Param('lojaId') lojaId: string) {
    return this.pagamentosService.listarPagamentosAdmin(lojaId);
  }
}
