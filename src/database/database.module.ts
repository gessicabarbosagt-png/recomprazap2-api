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
      useFactory: (config: ConfigService) => {
        const connectionString = config.get<string>('DATABASE_URL');
        const sql = postgres(connectionString, { max: 10, transform: postgres.camel });

        return sql;
      },
    },
  ],
  exports: [DATABASE_CLIENT],
})
export class DatabaseModule {}
