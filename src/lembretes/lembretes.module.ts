import { Module } from '@nestjs/common';
import { LembretesController } from './lembretes.controller';
import { LembretesService } from './lembretes.service';

@Module({
  controllers: [LembretesController],
  providers: [LembretesService],
  exports: [LembretesService],
})
export class LembretesModule {}
