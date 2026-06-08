import { Module } from '@nestjs/common';
import { ClientesController } from './clientes.controller';
import { ClientesService } from './clientes.service';

@Module({
  controllers: [ClientesController],
  providers: [ClientesService],
  exports: [ClientesService], // Exporta para outros módulos usarem (ex: ciclos)
})
export class ClientesModule {}
