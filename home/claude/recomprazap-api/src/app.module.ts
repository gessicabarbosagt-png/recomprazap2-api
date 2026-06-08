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

@Module({
  imports: [
    // ConfigModule: carrega o arquivo .env e disponibiliza as variáveis
    // em toda a aplicação via process.env ou via ConfigService.
    // isGlobal: true significa que não precisa importar em cada módulo.
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // Módulo do banco de dados (PostgreSQL)
    DatabaseModule,

    // Módulos de negócio — cada um cuida de um domínio do sistema
    AuthModule,
    LojasModule,
    ClientesModule,
    ProdutosModule,
    CiclosModule,
    LembretesModule,
    PedidosModule,
    WhatsappModule,
  ],
})
export class AppModule {}
