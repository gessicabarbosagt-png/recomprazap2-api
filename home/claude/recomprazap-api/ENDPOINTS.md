# RecompraZap API — Mapa de Endpoints
Base URL: `http://localhost:3000/api/v1`

Todas as rotas (exceto `/auth/login` e `/whatsapp/webhook`) exigem o header:
```
Authorization: Bearer <token>
```

---

## Auth
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/auth/login` | Login. Retorna `accessToken` e dados do usuário |

---

## Clientes
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/clientes` | Lista todos os clientes da loja |
| GET | `/clientes/:id` | Busca um cliente |
| POST | `/clientes` | Cria um cliente |
| PATCH | `/clientes/:id` | Atualiza nome, email, ativo |
| DELETE | `/clientes/:id` | Soft delete |

---

## Produtos
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/produtos` | Lista produtos da loja |
| GET | `/produtos/:id` | Busca um produto |
| POST | `/produtos` | Cria produto |
| PATCH | `/produtos/:id` | Atualiza produto |
| DELETE | `/produtos/:id` | Soft delete |

---

## Ciclos de Recompra ⭐ (coração do sistema)
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/ciclos` | Lista ciclos ativos com dados de cliente e produto |
| GET | `/ciclos/:id` | Busca um ciclo |
| POST | `/ciclos` | Cria ciclo. Calcula `proxima_notificacao` automaticamente |
| PATCH | `/ciclos/:id` | Atualiza intervalo/quantidade. Recalcula notificação se intervalo mudar |
| DELETE | `/ciclos/:id` | Desativa e faz soft delete |

**Body para POST `/ciclos`:**
```json
{
  "clienteId": "uuid",
  "produtoId": "uuid",
  "intervaloDias": 30,
  "quantidade": 5
}
```

---

## Lembretes
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/lembretes` | Lista lembretes. Filtro: `?status=agendado` |
| GET | `/lembretes/resumo` | Métricas do período. Parâmetro: `?dias=30` |
| GET | `/lembretes/:id` | Busca um lembrete |
| POST | `/lembretes/agendar` | Agenda manualmente um lembrete para um ciclo |
| PATCH | `/lembretes/:id/cancelar` | Cancela um lembrete agendado |

**Body para POST `/lembretes/agendar`:**
```json
{
  "cicloId": "uuid",
  "agendadoPara": "2026-06-15T10:00:00Z"
}
```

---

## Pedidos
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/pedidos` | Lista pedidos. Filtro: `?status=pendente` |
| GET | `/pedidos/resumo` | Métricas. Parâmetro: `?dias=30` |
| GET | `/pedidos/:id` | Busca um pedido |
| PATCH | `/pedidos/:id` | Confirma, entrega ou cancela pedido |

**Body para PATCH `/pedidos/:id`:**
```json
{
  "status": "confirmado",
  "tipoEntrega": "retirada",
  "tipoPagamento": "pix"
}
```

> Quando `status = "entregue"`, o sistema automaticamente atualiza o ciclo 
> e recalcula a `proxima_notificacao` (reinicia o contador).

---

## WhatsApp
| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| POST | `/whatsapp/webhook` | ❌ Público | Recebe mensagens da 360dialog |
| GET | `/whatsapp/mensagens` | ✅ JWT | Histórico de mensagens. Filtro: `?clienteId=uuid` |

---

## Fluxo completo de uma recompra

```
1. Lojista cria Ciclo (POST /ciclos)
2. Worker monitora ciclos com proxima_notificacao vencida
3. Worker chama WhatsappService.enviarLembrete()
4. Cliente recebe mensagem com 3 botões
5. Cliente responde "Quero pedir" → webhook recebe → Pedido criado automaticamente
6. Lojista vê pedido pendente no painel (GET /pedidos?status=pendente)
7. Lojista confirma (PATCH /pedidos/:id → status: confirmado)
8. Lojista marca como entregue (PATCH /pedidos/:id → status: entregue)
9. Sistema atualiza ciclo → proxima_notificacao = hoje + intervalo_dias
10. Ciclo reinicia ♻️
```
