import { Module } from '@nestjs/common';
import { NotificacoesService } from './notificacoes.service';
import { NotificacoesController } from './notificacoes.controller';

@Module({
  controllers: [NotificacoesController],
  providers: [NotificacoesService],
  exports: [NotificacoesService],
})
export class NotificacoesModule {}
