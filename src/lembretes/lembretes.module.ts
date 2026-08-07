import { Module } from '@nestjs/common';
import { LembretesController } from './lembretes.controller';
import { LembretesService } from './lembretes.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [LembretesController],
  providers: [LembretesService],
  exports: [LembretesService],
})
export class LembretesModule {}
