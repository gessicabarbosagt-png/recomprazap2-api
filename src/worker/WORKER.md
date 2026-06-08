# Worker — Como funciona o coração automático do RecompraZap

## Visão geral

O worker é o que faz o sistema ser "automático". Sem ele, os lembretes nunca saem.
Ele roda em background junto com a API, no mesmo processo NestJS.

## Arquivos

```
src/worker/
├── worker.constants.ts     # Nomes das filas e jobs (evita strings mágicas)
├── worker.module.ts        # Módulo que registra tudo no NestJS
├── agendador.service.ts    # Os dois Crons que alimentam as filas
├── lembretes.processor.ts  # Consome a fila e envia via 360dialog
└── retry.processor.ts      # Consome a fila de retry
```

## Fluxo completo

```
A cada 5 min
AgendadorService.varrerCiclosVencidos()
    │
    ├── Query: ciclos com proxima_notificacao <= NOW() sem lembrete em aberto
    │
    ├── INSERT lembretes (status: 'agendado')
    │
    └── filaLembretes.add(JOB_ENVIAR_LEMBRETE, dados...)
              │
              ▼ (BullMQ pega o job do Redis)
        LembretesProcessor.processarEnvioLembrete()
              │
              ├── Verifica horário de funcionamento da loja
              │     └── Se fora do horário → reagenda com delay calculado
              │
              ├── WhatsappService.enviarLembrete() → 360dialog API
              │
              └── UPDATE lembretes SET status = 'enviado'


A cada 10 min
AgendadorService.varrerLembretessSemResposta()
    │
    ├── Query: lembretes 'enviado' há mais de X horas sem retry
    │
    ├── UPDATE lembretes SET status = 'sem_resposta' (lembrete original)
    │
    └── filaRetry.add(JOB_RETRY_LEMBRETE, dados...)
              │
              ▼
        RetryProcessor.processarRetry()
              │
              ├── INSERT novo lembrete (tentativa: 2, lembrete_pai_id: original)
              │
              └── WhatsappService.enviarLembrete() → 360dialog API
```

## Quando o cliente responde

O webhook `/api/v1/whatsapp/webhook` recebe a resposta e o `WhatsappService`
interpreta o botão clicado:

| Botão | Ação |
|-------|------|
| ✅ Quero pedir | Cria pedido pendente no banco |
| ⏰ Deixa pra depois | Empurra proxima_notificacao +7 dias |
| ❌ Não preciso mais | Gera cupom de retenção + desativa ciclo |

## Garantias de segurança

- **Sem duplicação**: a query do Cron 1 verifica se já existe lembrete em aberto antes de criar outro
- **LGPD**: só envia para clientes com `consentimento_whatsapp = TRUE`
- **Retry limitado**: só faz retry uma vez (`tentativa = 1`)
- **Resiliência**: BullMQ retenta jobs com falha 3x com backoff exponencial

## Como rodar localmente

1. Suba o Redis: `docker run -p 6379:6379 redis`
2. Configure o `.env` com `REDIS_HOST`, `REDIS_PORT`
3. `npm run start:dev`

O NestJS vai iniciar a API e o worker no mesmo processo.
