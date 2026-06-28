import {
  Controller, UseGuards, Get, Post,
  Body, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappBaileysService } from './whatsapp-baileys.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';
import { IsString, MinLength } from 'class-validator';

class EnviarMensagemDto {
  @IsString() telefone: string;
  @IsString() @MinLength(1) conteudo: string;
}

@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly baileysService: WhatsappBaileysService,
  ) {}

  // GET /api/v1/whatsapp/status — status público da conexão (sem QR Code)
  @Get('status')
  status() {
    const { status } = this.baileysService.getQrCode();
    return { status };
  }

  // GET /api/v1/whatsapp/diagnostico — logs internos do Baileys para debug
  @Get('diagnostico')
  diagnostico() {
    return this.baileysService.getDiagnostico();
  }

  // GET /api/v1/whatsapp/qrcode — retorna QR Code e status da conexão
  @UseGuards(JwtAuthGuard)
  @Get('qrcode')
  qrcode() {
    return this.baileysService.getQrCode();
  }

  // POST /api/v1/whatsapp/desconectar — encerra a sessão Baileys
  @UseGuards(JwtAuthGuard)
  @Post('desconectar')
  @HttpCode(HttpStatus.OK)
  async desconectar() {
    await this.baileysService.desconectar();
    return { ok: true, mensagem: 'WhatsApp desconectado' };
  }

  // POST /api/v1/whatsapp/reconectar — força novo ciclo de conexão e gera novo QR
  @UseGuards(JwtAuthGuard)
  @Post('reconectar')
  @HttpCode(HttpStatus.OK)
  async reconectar() {
    await this.baileysService.reconectar();
    return { ok: true, mensagem: 'Reconexão iniciada — aguarde o novo QR Code' };
  }

  // GET /api/v1/whatsapp/mensagens — histórico de mensagens da loja
  @UseGuards(JwtAuthGuard)
  @Get('mensagens')
  mensagens(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.whatsappService.listarMensagens(usuario.lojaId);
  }

  // POST /api/v1/whatsapp/mensagens — envia mensagem manual para um cliente
  @UseGuards(JwtAuthGuard)
  @Post('mensagens')
  async enviarMensagem(
    @UsuarioAtual() usuario: UsuarioLogado,
    @Body() dto: EnviarMensagemDto,
  ) {
    await this.whatsappService.enviarMensagem(usuario.lojaId, dto.telefone, dto.conteudo);
    return { ok: true };
  }
}
