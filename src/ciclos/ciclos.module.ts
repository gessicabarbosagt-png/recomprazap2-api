import { Module } from '@nestjs/common';
import { CiclosController } from './ciclos.controller';
import { CiclosService } from './ciclos.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AtividadeLogModule } from '../atividade-log/atividade-log.module';

@Module({
  imports: [WhatsappModule, AtividadeLogModule],
  controllers: [CiclosController],
  providers: [CiclosService],
  exports: [CiclosService],
})
export class CiclosModule {}
