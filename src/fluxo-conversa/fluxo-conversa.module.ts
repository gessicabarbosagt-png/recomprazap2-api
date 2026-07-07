import { Module } from '@nestjs/common';
import { FluxoConversaController } from './fluxo-conversa.controller';
import { FluxoConversaService } from './fluxo-conversa.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [FluxoConversaController],
  providers: [FluxoConversaService],
  exports: [FluxoConversaService],
})
export class FluxoConversaModule {}
