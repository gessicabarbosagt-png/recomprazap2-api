import { Module } from '@nestjs/common';
import { LojasController } from './lojas.controller';
import { LojasService } from './lojas.service';

@Module({
  controllers: [LojasController],
  providers: [LojasService],
  exports: [LojasService],
})
export class LojasModule {}
