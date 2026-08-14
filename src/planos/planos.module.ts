import { Module } from '@nestjs/common';
import { PlanosService } from './planos.service';
import { PlanosCatalogoController, PlanosLojistaController } from './planos.controller';
import { PagamentosModule } from '../pagamentos/pagamentos.module';

@Module({
  imports: [PagamentosModule],
  controllers: [PlanosCatalogoController, PlanosLojistaController],
  providers: [PlanosService],
  exports: [PlanosService],
})
export class PlanosModule {}
