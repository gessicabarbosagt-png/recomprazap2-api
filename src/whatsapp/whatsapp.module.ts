import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappBaileysService } from './whatsapp-baileys.service';
import { MetaAdsModule } from '../meta-ads/meta-ads.module';

@Module({
  imports: [MetaAdsModule],
  controllers: [WhatsappController],
  providers: [WhatsappBaileysService, WhatsappService],
  exports: [WhatsappService, WhatsappBaileysService],
})
export class WhatsappModule {}
