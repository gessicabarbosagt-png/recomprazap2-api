import { Module } from '@nestjs/common';
import { ClientesController } from './clientes.controller';
import { ClientesService } from './clientes.service';
import { AtividadeLogModule } from '../atividade-log/atividade-log.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [AtividadeLogModule, WhatsappModule],
  controllers: [ClientesController],
  providers: [ClientesService],
  exports: [ClientesService],
})
export class ClientesModule {}
