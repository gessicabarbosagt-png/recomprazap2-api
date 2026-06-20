import { Test, TestingModule } from '@nestjs/testing';
import { LembretesProcessor } from '../lembretes.processor';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { DATABASE_CLIENT } from '../../database/database.module';
import { JOB_ENVIAR_LEMBRETE } from '../worker.constants';

// Helpers para simular diferentes horários nos testes
const setHora = (hora: number, minuto = 0) => {
  jest.useFakeTimers();
  const agora = new Date();
  agora.setHours(hora, minuto, 0, 0);
  jest.setSystemTime(agora);
};

const LEMBRETE_ID = 'lembrete-uuid-1';

// Dados base de um job
const jobBase = {
  data: {
    lembreteId: LEMBRETE_ID,
    lojaId: 'loja-1',
    cicloId: 'ciclo-1',
    clienteNome: 'Maria',
    clienteTelefone: '+5511999990000',
    produtoNome: 'Ração',
    produtoUnidade: 'kg',
    quantidade: 5,
    horarioAbertura: '08:00',
    horarioFechamento: '18:00',
    diasFuncionamento: [0, 1, 2, 3, 4, 5, 6], // todos os dias (facilita teste)
    horasParaRetry: 24,
  },
  queue: { add: jest.fn() },
};

describe('LembretesProcessor', () => {
  let processor: LembretesProcessor;
  let sql: jest.Mock;
  let whatsappService: { enviarLembrete: jest.Mock };

  beforeEach(async () => {
    sql = jest.fn().mockResolvedValue([]);
    whatsappService = { enviarLembrete: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LembretesProcessor,
        { provide: DATABASE_CLIENT, useValue: sql },
        { provide: WhatsappService, useValue: whatsappService },
      ],
    }).compile();

    processor = module.get<LembretesProcessor>(LembretesProcessor);
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ----------------------------------------------------------------
  // Envio dentro do horário de funcionamento
  // ----------------------------------------------------------------
  describe('dentro do horário', () => {
    it('envia a mensagem e marca lembrete como enviado', async () => {
      setHora(10); // 10h — dentro do horário 08:00-18:00

      await processor.processarEnvioLembrete(jobBase as any);

      expect(whatsappService.enviarLembrete).toHaveBeenCalledTimes(1);
      expect(whatsappService.enviarLembrete).toHaveBeenCalledWith(
        expect.objectContaining({
          telefone: '+5511999990000',
          clienteNome: 'Maria',
          lembreteId: LEMBRETE_ID,
        }),
      );
      // Verifica que o UPDATE para 'enviado' foi chamado
      expect(sql).toHaveBeenCalledTimes(1);
    });

    it('retorna { enviado: true } no sucesso', async () => {
      setHora(14);
      const resultado = await processor.processarEnvioLembrete(jobBase as any);
      expect(resultado).toEqual({ enviado: true });
    });
  });

  // ----------------------------------------------------------------
  // Fora do horário — reagendamento
  // ----------------------------------------------------------------
  describe('fora do horário', () => {
    it('não envia mensagem quando a loja está fechada', async () => {
      setHora(3); // 3h da manhã — fechado

      await processor.processarEnvioLembrete(jobBase as any);

      expect(whatsappService.enviarLembrete).not.toHaveBeenCalled();
    });

    it('reagenda o job para a próxima abertura', async () => {
      setHora(3); // 3h — fechado

      const resultado = await processor.processarEnvioLembrete(jobBase as any);

      expect(resultado).toEqual(
        expect.objectContaining({ reagendado: true }),
      );
      // Verifica que um novo job foi adicionado à fila com delay
      expect(jobBase.queue.add).toHaveBeenCalledWith(
        JOB_ENVIAR_LEMBRETE,
        jobBase.data,
        expect.objectContaining({ delay: expect.any(Number) }),
      );
      // O delay deve ser positivo (horário no futuro)
      const [, , opts] = (jobBase.queue.add as jest.Mock).mock.calls[0];
      expect(opts.delay).toBeGreaterThan(0);
    });

    it('atualiza agendado_para no banco ao reagendar', async () => {
      setHora(23); // 23h — fechado

      await processor.processarEnvioLembrete(jobBase as any);

      // Deve ter chamado UPDATE lembretes SET agendado_para
      expect(sql).toHaveBeenCalledTimes(1);
    });

    it('retorna { reagendado: true } com a data futura', async () => {
      setHora(22); // 22h — após fechamento (18h)

      const resultado = await processor.processarEnvioLembrete(jobBase as any);

      expect(resultado.reagendado).toBe(true);
      expect(resultado.para).toBeInstanceOf(Date);
      expect(resultado.para.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ----------------------------------------------------------------
  // Sem restrição de horário configurada
  // ----------------------------------------------------------------
  describe('sem restrição de horário', () => {
    it('envia em qualquer horário quando horario_abertura é null', async () => {
      setHora(3); // 3h — mas sem restrição configurada

      const jobSemHorario = {
        ...jobBase,
        data: { ...jobBase.data, horarioAbertura: null, horarioFechamento: null },
      };

      await processor.processarEnvioLembrete(jobSemHorario as any);

      // Com null, não há verificação → envia direto
      expect(whatsappService.enviarLembrete).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------------
  // Falha no envio — re-throw para BullMQ retentar
  // ----------------------------------------------------------------
  describe('falha no envio', () => {
    it('lança o erro para o BullMQ registrar e retentar', async () => {
      setHora(10);
      whatsappService.enviarLembrete.mockRejectedValueOnce(new Error('360dialog timeout'));

      await expect(
        processor.processarEnvioLembrete(jobBase as any),
      ).rejects.toThrow('360dialog timeout');

      // Não atualiza para 'enviado' quando falha
      expect(sql).not.toHaveBeenCalled();
    });
  });
});
