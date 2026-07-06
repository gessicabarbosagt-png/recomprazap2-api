import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import postgres = require('postgres');

export const DATABASE_CLIENT = 'DATABASE_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const connectionString = config.get<string>('DATABASE_URL');
        const sql = postgres(connectionString, { max: 10, transform: postgres.camel });

        // Migrations de startup — idempotentes, seguras para rodar sempre
        await sql`ALTER TABLE mensagens_whatsapp ADD COLUMN IF NOT EXISTS tipo VARCHAR(20)`.catch(() => {});
        await sql`
          CREATE TABLE IF NOT EXISTS baileys_auth_state (
            id          TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `.catch(() => {});
        await sql`ALTER TABLE ciclos_recompra ADD COLUMN IF NOT EXISTS status_ultimo_envio VARCHAR(20)`.catch(() => {});
        await sql`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS modelo_mensagem TEXT`.catch(() => {});
        await sql`
          CREATE TABLE IF NOT EXISTS whatsapp_lid_map (
            lid        TEXT PRIMARY KEY,
            phone_jid  TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `.catch(() => {});

        return sql;
      },
    },
  ],
  exports: [DATABASE_CLIENT],
})
export class DatabaseModule {}
