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

  // CORS: permite que o frontend (Next.js) se comunique com esta API.
  // Em produção, troque pelo domínio real do frontend.
  app.enableCors({
    origin: process.env.NODE_ENV === 'production'
      ? 'https://app.recomprazap.com.br'
      : 'http://localhost:3001',
    credentials: true,
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(`🚀 RecompraZap API rodando em http://localhost:${port}/api/v1`);
}

bootstrap();
