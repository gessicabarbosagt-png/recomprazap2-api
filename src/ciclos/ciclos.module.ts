import { Module } from '@nestjs/common';
import { CiclosController } from './ciclos.controller';
import { CiclosService } from './ciclos.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [CiclosController],
  providers: [CiclosService],
  exports: [CiclosService],
})
export class CiclosModule {}
