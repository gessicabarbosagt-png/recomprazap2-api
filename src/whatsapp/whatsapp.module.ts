import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappBaileysService } from './whatsapp-baileys.service';

@Module({
  controllers: [WhatsappController],
  providers: [WhatsappBaileysService, WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
