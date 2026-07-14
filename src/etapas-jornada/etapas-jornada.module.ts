import { Module } from '@nestjs/common';
import { EtapasJornadaController } from './etapas-jornada.controller';
import { EtapasJornadaService } from './etapas-jornada.service';

@Module({
  controllers: [EtapasJornadaController],
  providers: [EtapasJornadaService],
  exports: [EtapasJornadaService],
})
export class EtapasJornadaModule {}
