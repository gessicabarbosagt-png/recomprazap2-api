import { Module } from '@nestjs/common';
import { AtividadeLogService } from './atividade-log.service';
import { AtividadeLogController } from './atividade-log.controller';

@Module({
  controllers: [AtividadeLogController],
  providers: [AtividadeLogService],
  exports: [AtividadeLogService],
})
export class AtividadeLogModule {}
