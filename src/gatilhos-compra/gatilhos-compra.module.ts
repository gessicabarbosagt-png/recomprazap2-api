import { Module } from '@nestjs/common';
import { GatilhosCompraController } from './gatilhos-compra.controller';
import { GatilhosCompraService } from './gatilhos-compra.service';

@Module({
  controllers: [GatilhosCompraController],
  providers: [GatilhosCompraService],
})
export class GatilhosCompraModule {}
