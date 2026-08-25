import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import helmet from 'helmet';

const REQUIRED_ENV_VARS = ['ENCRYPTION_KEY', 'MP_WEBHOOK_SECRET', 'JWT_SECRET'];

async function bootstrap() {
  for (const name of REQUIRED_ENV_VARS) {
    if (!process.env[name]) {
      throw new Error(`Variável de ambiente obrigatória não configurada: ${name}. Aplicação não pode iniciar.`);
    }
  }

  const app = await NestFactory.create(AppModule);

  // Railway (e outros reverse-proxies) encaminha o IP real do cliente via X-Forwarded-For.
  // Sem isso, req.ip retorna o IP interno do proxy — o throttler nunca acumula hits por usuário.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(
    helmet({
      // API consumida por frontend em domínio diferente (Vercel → Railway).
      // same-origin (padrão do helmet) bloquearia o navegador de ler respostas cross-origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

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
