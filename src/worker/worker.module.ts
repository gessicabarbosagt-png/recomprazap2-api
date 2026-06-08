import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AgendadorService } from './agendador.service';
import { LembretesProcessor } from './lembretes.processor';
import { RetryProcessor } from './retry.processor';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

import { FILA_LEMBRETES, FILA_RETRY } from './worker.constants';

// WorkerModule agrupa tudo relacionado ao processamento em background:
//   - ScheduleModule: habilita os @Cron() do AgendadorService
//   - BullModule: registra as filas no Redis
//   - Processors: consomem os jobs das filas
//   - WhatsappModule: importado para o processor poder chamar WhatsappService

@Module({
  imports: [
    // Habilita os decorators @Cron(), @Interval(), @Timeout() no NestJS
    ScheduleModule.forRoot(),

    // Configura a conexão Redis para o BullMQ usando as variáveis do .env
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host:     config.get<string>('REDIS_HOST', 'localhost'),
          port:     config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),

    // Registra as filas — cada uma vira uma lista no Redis
    BullModule.registerQueue(
      { name: FILA_LEMBRETES },
      { name: FILA_RETRY },
    ),

    // WhatsappModule exporta WhatsappService, que os processors precisam
    WhatsappModule,
  ],
  providers: [
    AgendadorService,    // Crons que alimentam as filas
    LembretesProcessor,  // Consome FILA_LEMBRETES e envia via 360dialog
    RetryProcessor,      // Consome FILA_RETRY para segundas tentativas
  ],
  exports: [
    AgendadorService,
    // Exporta as filas para outros módulos poderem enfileirar jobs diretamente se precisar
    BullModule,
  ],
})
export class WorkerModule {}
