import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { AgendadorService } from '../agendador.service';
import { DATABASE_CLIENT } from '../../database/database.module';
import { FILA_LEMBRETES, FILA_RETRY, JOB_ENVIAR_LEMBRETE, JOB_RETRY_LEMBRETE } from '../worker.constants';

const LOJA_ID  = 'loja-uuid-1';
const CICLO_ID = 'ciclo-uuid-1';
const LEMBRETE_ID = 'lembrete-uuid-1';

// Ciclo base que o banco retorna — representa loja aberta em dias úteis
const cicloBase = {
  cicloId:            CICLO_ID,
  lojaId:             LOJA_ID,
  proximaNotificacao: new Date(Date.now() - 1000), // já venceu
  retryAutomatico:    true,
  horasParaRetry:     24,
  horarioAbertura:    '08:00',
  horarioFechamento:  '18:00',
  diasFuncionamento:  [1, 2, 3, 4, 5], // seg a sex
  clienteNome:        'Maria',
  clienteTelefone:    '+5511999990000',
  consentimentoWhatsapp: true,
  produtoNome:        'Ração',
  produtoUnidade:     'kg',
  quantidade:         5,
};

describe('AgendadorService', () => {
  let service: AgendadorService;
  let sql: jest.Mock;
  let filaLembretes: { add: jest.Mock };
  let filaRetry: { add: jest.Mock };

  beforeEach(async () => {
    sql = jest.fn().mockResolvedValue([]);
    filaLembretes = { add: jest.fn().mockResolvedValue({}) };
    filaRetry = { add: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgendadorService,
        { provide: DATABASE_CLIENT, useValue: sql },
        { provide: getQueueToken(FILA_LEMBRETES), useValue: filaLembretes },
        { provide: getQueueToken(FILA_RETRY), useValue: filaRetry },
      ],
    }).compile();

    service = module.get<AgendadorService>(AgendadorService);
    jest.clearAllMocks();
  });

  // ----------------------------------------------------------------
  // varrerCiclosVencidos
  // ----------------------------------------------------------------
  describe('varrerCiclosVencidos', () => {
    it('enfileira um job para cada ciclo vencido encontrado', async () => {
      // Banco retorna 2 ciclos vencidos
      sql
        .mockResolvedValueOnce([cicloBase, { ...cicloBase, cicloId: 'ciclo-2' }]) // SELECT ciclos
        .mockResolvedValueOnce([{ id: LEMBRETE_ID }])  // INSERT lembrete ciclo 1
        .mockResolvedValueOnce([{ id: 'lem-2' }]);     // INSERT lembrete ciclo 2

      await service.varrerCiclosVencidos();

      // Deve ter criado um job para cada ciclo
      expect(filaLembretes.add).toHaveBeenCalledTimes(2);
      expect(filaLembretes.add).toHaveBeenCalledWith(
        JOB_ENVIAR_LEMBRETE,
        expect.objectContaining({ cicloId: CICLO_ID }),
        expect.any(Object),
      );
    });

    it('não enfileira nada quando não há ciclos vencidos', async () => {
      sql.mockResolvedValueOnce([]); // nenhum ciclo vencido

      await service.varrerCiclosVencidos();

      expect(filaLembretes.add).not.toHaveBeenCalled();
    });

    it('insere lembrete no banco antes de enfileirar o job', async () => {
      sql
        .mockResolvedValueOnce([cicloBase])
        .mockResolvedValueOnce([{ id: LEMBRETE_ID }]);

      await service.varrerCiclosVencidos();

      // Primeira chamada ao sql após SELECT é o INSERT do lembrete
      expect(sql).toHaveBeenCalledTimes(2); // SELECT + INSERT
    });
  });

  // ----------------------------------------------------------------
  // varrerLembretessSemResposta
  // ----------------------------------------------------------------
  describe('varrerLembretessSemResposta', () => {
    const lembreteSemResposta = {
      lembreteId: LEMBRETE_ID,
      cicloId: CICLO_ID,
      lojaId: LOJA_ID,
      tentativa: 1,
      retryAutomatico: true,
      horasParaRetry: 24,
    };

    it('marca lembrete como sem_resposta e enfileira retry', async () => {
      sql.mockResolvedValueOnce([lembreteSemResposta]); // SELECT lembretes sem resposta
      sql.mockResolvedValueOnce([]);                     // UPDATE sem_resposta

      await service.varrerLembretessSemResposta();

      expect(filaRetry.add).toHaveBeenCalledTimes(1);
      expect(filaRetry.add).toHaveBeenCalledWith(
        JOB_RETRY_LEMBRETE,
        expect.objectContaining({ lembreteOriginalId: LEMBRETE_ID }),
        expect.any(Object),
      );
    });

    it('não enfileira retry quando não há lembretes sem resposta', async () => {
      sql.mockResolvedValueOnce([]); // nenhum lembrete pendente

      await service.varrerLembretessSemResposta();

      expect(filaRetry.add).not.toHaveBeenCalled();
    });

    it('processa múltiplos lembretes sem resposta no mesmo ciclo', async () => {
      const lembretes = [
        { ...lembreteSemResposta, lembreteId: 'lem-1' },
        { ...lembreteSemResposta, lembreteId: 'lem-2' },
        { ...lembreteSemResposta, lembreteId: 'lem-3' },
      ];
      sql.mockResolvedValueOnce(lembretes);
      // UPDATE para cada lembrete
      sql.mockResolvedValue([]);

      await service.varrerLembretessSemResposta();

      expect(filaRetry.add).toHaveBeenCalledTimes(3);
    });
  });
});
