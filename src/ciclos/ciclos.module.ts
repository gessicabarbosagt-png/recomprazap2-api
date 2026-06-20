import { Module } from '@nestjs/common';
import { CiclosController } from './ciclos.controller';
import { CiclosService } from './ciclos.service';

@Module({
  controllers: [CiclosController],
  providers: [CiclosService],
  exports: [CiclosService], // Exportado para PedidosModule usar
})
export class CiclosModule {}
