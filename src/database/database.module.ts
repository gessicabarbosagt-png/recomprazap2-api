import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import postgres from 'postgres';

// O token que usaremos para injetar o cliente do banco em qualquer Service.
// Ex: constructor(@Inject(DATABASE_CLIENT) private db: PostgresClient)
export const DATABASE_CLIENT = 'DATABASE_CLIENT';

// @Global() significa que este módulo e seus exports ficam disponíveis
// em toda a aplicação sem precisar importar em cada módulo.
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const connectionString = config.get<string>('DATABASE_URL');

        // "postgres" é a biblioteca que usamos para conectar ao PostgreSQL.
        // Ela usa tagged template literals: sql`SELECT * FROM clientes`
        const sql = postgres(connectionString, {
          // Número máximo de conexões simultâneas no pool
          max: 10,

          // Injetar o loja_id no contexto de cada conexão (para o RLS funcionar).
          // Este hook é chamado antes de cada query.
          // O loja_id virá do contexto da requisição (definido no interceptor).
          transform: postgres.camel, // Converte snake_case do banco para camelCase no JS
        });

        return sql;
      },
    },
  ],
  exports: [DATABASE_CLIENT],
})
export class DatabaseModule {}
