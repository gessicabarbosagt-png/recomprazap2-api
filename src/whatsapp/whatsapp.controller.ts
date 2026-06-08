import {
  Controller, UseGuards, Get, Post,
  Body, Query, Headers, RawBodyRequest, Req,
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // POST /api/v1/whatsapp/webhook
  // Recebe mensagens da 360dialog. NÃO tem JwtAuthGuard — é público (chamado pelo servidor externo)
  // Em produção: validar o header X-Hub-Signature com o DIALOG360_WEBHOOK_SECRET
  @Post('webhook')
  webhook(@Body() payload: any) {
    return this.whatsappService.processarWebhook(payload);
  }

  // GET /api/v1/whatsapp/mensagens — rotas autenticadas abaixo
  // Retorna histórico de mensagens da loja
  @UseGuards(JwtAuthGuard)
  @Get('mensagens')
  mensagens(
    @UsuarioAtual() usuario: any,
    @Query('clienteId') clienteId?: string,
  ) {
    return this.whatsappService.listarMensagens(usuario.lojaId, clienteId);
  }
}
