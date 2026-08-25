import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerExceptionFilter } from './common/filters/throttler-exception.filter';
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
import { CodigosOrigemModule } from './codigos-origem/codigos-origem.module';
import { GatilhosCompraModule } from './gatilhos-compra/gatilhos-compra.module';
import { EtapasJornadaModule } from './etapas-jornada/etapas-jornada.module';
import { AdminModule } from './admin/admin.module';
import { NotificacoesModule } from './notificacoes/notificacoes.module';
import { PagamentosModule } from './pagamentos/pagamentos.module';
import { MetaAdsModule } from './meta-ads/meta-ads.module';
import { LinksOrigemModule } from './links-origem/links-origem.module';
import { PlanosModule } from './planos/planos.module';
import { EmailModule } from './email/email.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),
    EmailModule,
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
    CodigosOrigemModule,
    GatilhosCompraModule,
    EtapasJornadaModule,

    // Painel admin do sistema
    AdminModule,
    NotificacoesModule,
    PagamentosModule,

    // Integrações e rastreamento
    MetaAdsModule,
    LinksOrigemModule,
    PlanosModule,

    // Worker: Crons + Filas BullMQ + Processors
    // Responsável por toda a automação de envio de lembretes
    WorkerModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ThrottlerExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
