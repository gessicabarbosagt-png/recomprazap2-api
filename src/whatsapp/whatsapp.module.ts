import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService], // Exportado para o WorkerModule usar nos processors
})
export class WhatsappModule {}
