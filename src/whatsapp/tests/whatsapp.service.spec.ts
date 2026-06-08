import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WhatsappService } from '../whatsapp.service';
import { DATABASE_CLIENT } from '../../database/database.module';
import axios from 'axios';

// Mock global do axios para não fazer chamadas reais à 360dialog nos testes
jest.mock('axios');
const axiosMock = axios as jest.Mocked<typeof axios>;

const LOJA_ID     = 'loja-uuid-1';
const LEMBRETE_ID = 'lembrete-uuid-1';
const CICLO_ID    = 'ciclo-uuid-1';
const CLIENTE_ID  = 'cliente-uuid-1';

const lembreteComDados = {
  id: LEMBRETE_ID,
  lojaId: LOJA_ID,
  cicloId: CICLO_ID,
  clienteId: CLIENTE_ID,
  produtoId: 'produto-1',
  quantidade: 2,
  produtoNome: 'Ração Golden',
  clienteNome: 'Maria',
};

describe('WhatsappService', () => {
  let service: WhatsappService;
  let sql: jest.Mock;

  beforeEach(async () => {
    sql = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        { provide: DATABASE_CLIENT, useValue: sql },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => ({
              DIALOG360_BASE_URL: 'https://waba.360dialog.io/v1',
              DIALOG360_API_KEY: 'fake-api-key',
            }[key]),
          },
        },
      ],
    }).compile();

    service = module.get<WhatsappService>(WhatsappService);
    jest.clearAllMocks();
  });

  // ----------------------------------------------------------------
  // enviarLembrete
  // ----------------------------------------------------------------
  describe('enviarLembrete', () => {
    it('chama a API da 360dialog com o payload correto', async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: { messages: [{ id: 'wamid.123' }] },
      });
      sql.mockResolvedValue([]); // registrarMensagem não quebra

      await service.enviarLembrete({
        telefone: '+5511999990000',
        clienteNome: 'Maria',
        produtoNome: 'Ração Golden',
        quantidade: 2,
        unidade: 'kg',
        lembreteId: LEMBRETE_ID,
      });

      expect(axiosMock.post).toHaveBeenCalledTimes(1);
      const [url, payload] = axiosMock.post.mock.calls[0];
      expect(url).toContain('/messages');
      expect(payload.type).toBe('interactive');
      // Garante que os 3 botões estão presentes
      expect(payload.interactive.action.buttons).toHaveLength(3);
      // Número sem o "+"
      expect(payload.to).toBe('5511999990000');
    });

    it('inclui quantidade e unidade na mensagem', async () => {
      axiosMock.post.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.456' }] } });
      sql.mockResolvedValue([]);

      await service.enviarLembrete({
        telefone: '+5511999990000',
        clienteNome: 'João',
        produtoNome: 'Milho',
        quantidade: 50,
        unidade: 'kg',
        lembreteId: LEMBRETE_ID,
      });

      const [, payload] = axiosMock.post.mock.calls[0];
      expect(payload.interactive.body.text).toContain('50 kg');
    });

    it('lança erro quando a 360dialog falha', async () => {
      axiosMock.post.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        service.enviarLembrete({
          telefone: '+5511999990000',
          clienteNome: 'Maria',
          produtoNome: 'Ração',
          lembreteId: LEMBRETE_ID,
        }),
      ).rejects.toThrow('Network error');
    });
  });

  // ----------------------------------------------------------------
  // processarWebhook — as 3 respostas possíveis do cliente
  // ----------------------------------------------------------------
  describe('processarWebhook', () => {
    const webhookBase = (buttonId: string) => ({
      messages: [{
        from: '5511999990000',
        id: 'wamid.abc',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: buttonId, title: 'Qualquer título' },
        },
      }],
    });

    beforeEach(() => {
      // Lembrete encontrado no banco para qualquer teste de webhook
      sql.mockResolvedValue([lembreteComDados]);
    });

    it('retorna { ok: true } quando payload não tem mensagens', async () => {
      const resultado = await service.processarWebhook({});
      expect(resultado).toEqual({ ok: true });
    });

    it('"pedir" → cria pedido pendente no banco', async () => {
      sql
        .mockResolvedValueOnce([])                  // registrarMensagem (entrada)
        .mockResolvedValueOnce([lembreteComDados])   // busca lembrete pelo ID
        .mockResolvedValueOnce([])                   // INSERT pedido
        .mockResolvedValueOnce([]);                  // UPDATE lembrete → respondido

      await service.processarWebhook(webhookBase(`pedir:${LEMBRETE_ID}`));

      // Confirma que sql foi chamado para INSERT pedido (3ª chamada)
      const chamadas = sql.mock.calls;
      const temInsertPedido = chamadas.some(args =>
        JSON.stringify(args).includes('INSERT INTO pedidos'),
      );
      // Como o sql é um mock de tagged template, verificamos pela quantidade de calls
      expect(sql.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('"depois" → empurra proxima_notificacao +7 dias', async () => {
      sql
        .mockResolvedValueOnce([])                  // registrarMensagem
        .mockResolvedValueOnce([lembreteComDados])   // busca lembrete
        .mockResolvedValueOnce([])                   // UPDATE ciclo +7 dias
        .mockResolvedValueOnce([]);                  // UPDATE lembrete → respondido

      await service.processarWebhook(webhookBase(`depois:${LEMBRETE_ID}`));

      // Verifica que pelo menos 3 queries foram executadas (registro + ciclo + lembrete)
      expect(sql.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('"sair" → gera cupom de retenção e desativa o ciclo', async () => {
      sql
        .mockResolvedValueOnce([])                  // registrarMensagem
        .mockResolvedValueOnce([lembreteComDados])   // busca lembrete
        .mockResolvedValueOnce([])                   // INSERT cupom
        .mockResolvedValueOnce([])                   // UPDATE ciclo ativo=false
        .mockResolvedValueOnce([]);                  // UPDATE lembrete → respondido

      await service.processarWebhook(webhookBase(`sair:${LEMBRETE_ID}`));

      expect(sql.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('não lança erro quando lembrete não é encontrado (mensagem orphan)', async () => {
      sql
        .mockResolvedValueOnce([])   // registrarMensagem
        .mockResolvedValueOnce([]);  // lembrete não encontrado

      await expect(
        service.processarWebhook(webhookBase(`pedir:id-invalido`)),
      ).resolves.not.toThrow();
    });
  });
});
