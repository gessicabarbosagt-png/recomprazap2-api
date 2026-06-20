import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Prefixo global para todas as rotas: /api/v1/clientes, /api/v1/produtos, etc.
  app.setGlobalPrefix('api/v1');

  // ValidationPipe: valida automaticamente os dados que chegam nas requisições.
  // whitelist: remove campos que não estão no DTO (evita dados inesperados).
  // forbidNonWhitelisted: retorna erro se vier campo desconhecido.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true, // Converte tipos automaticamente (ex: string "123" vira number 123)
    }),
  );

  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://recomprazap2-web.vercel.app',
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
  ];

  app.enableCors({
    origin: (origin, callback) => {
      // Permite requests sem origin (ex: curl, Postman, Railway health checks)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS bloqueado para origin: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(`🚀 RecompraZap API rodando em http://localhost:${port}/api/v1`);
}

bootstrap();
