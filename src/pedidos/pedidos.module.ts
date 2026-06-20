import { Module } from '@nestjs/common';
import { PedidosController } from './pedidos.controller';
import { PedidosService } from './pedidos.service';
import { CiclosModule } from '../ciclos/ciclos.module';

@Module({
  imports: [CiclosModule], // PedidosService precisa do CiclosService para registrarCompra
  controllers: [PedidosController],
  providers: [PedidosService],
  exports: [PedidosService],
})
export class PedidosModule {}
