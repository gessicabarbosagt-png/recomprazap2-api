import { Module } from '@nestjs/common';
import { PedidosController } from './pedidos.controller';
import { PedidosService } from './pedidos.service';
import { CiclosModule } from '../ciclos/ciclos.module';
import { MetaAdsModule } from '../meta-ads/meta-ads.module';
import { AtividadeLogModule } from '../atividade-log/atividade-log.module';

@Module({
  imports: [CiclosModule, MetaAdsModule, AtividadeLogModule],
  controllers: [PedidosController],
  providers: [PedidosService],
  exports: [PedidosService],
})
export class PedidosModule {}
