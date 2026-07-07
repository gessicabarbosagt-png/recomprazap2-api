import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { LojasModule } from './lojas/lojas.module';
import { ClientesModule } from './clientes/clientes.module';
import { ProdutosModule } from './produtos/produtos.module';
import { CiclosModule } from './ciclos/ciclos.module';
import { LembretesModule } from './lembretes/lembretes.module';
import { PedidosModule } from './pedidos/pedidos.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { FluxoConversaModule } from './fluxo-conversa/fluxo-conversa.module';
import { WorkerModule } from './worker/worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,

    // Módulos de negócio
    AuthModule,
    LojasModule,
    ClientesModule,
    ProdutosModule,
    CiclosModule,
    LembretesModule,
    PedidosModule,
    WhatsappModule,
    FluxoConversaModule,

    // Worker: Crons + Filas BullMQ + Processors
    // Responsável por toda a automação de envio de lembretes
    WorkerModule,
  ],
})
export class AppModule {}
