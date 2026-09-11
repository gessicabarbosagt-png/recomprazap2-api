import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { NotificacoesModule } from '../notificacoes/notificacoes.module';
import { SeedBeeupController } from './seed-beeup.controller';

@Module({
  imports: [NotificacoesModule],
  controllers: [AdminController, SeedBeeupController],
  providers: [AdminService],
})
export class AdminModule {}
