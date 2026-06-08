import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LembretesService } from '../lembretes.service';
import { DATABASE_CLIENT } from '../../database/database.module';

const LOJA_ID     = 'loja-uuid-1';
const LEMBRETE_ID = 'lembrete-uuid-1';
const CICLO_ID    = 'ciclo-uuid-1';

describe('LembretesService', () => {
  let service: LembretesService;
  let sql: jest.Mock;

  beforeEach(async () => {
    sql = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LembretesService,
        { provide: DATABASE_CLIENT, useValue: sql },
      ],
    }).compile();

    service = module.get<LembretesService>(LembretesService);
  });

  describe('agendar', () => {
    it('cria lembrete usando proxima_notificacao do ciclo quando data não é informada', async () => {
      const proxima = new Date(Date.now() + 86400000);
      const cicloFake = { id: CICLO_ID, proximaNotificacao: proxima };
      const lembreteCreated = { id: LEMBRETE_ID, status: 'agendado', tentativa: 1 };

      sql
        .mockResolvedValueOnce([cicloFake])
        .mockResolvedValueOnce([lembreteCreated]);

      const resultado = await service.agendar(CICLO_ID, LOJA_ID);
      expect(resultado.status).toBe('agendado');
      expect(resultado.tentativa).toBe(1);
    });

    it('lança NotFoundException quando ciclo não existe ou está inativo', async () => {
      sql.mockResolvedValueOnce([]);
      await expect(service.agendar('ciclo-inexistente', LOJA_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('criarRetry', () => {
    it('cria novo lembrete com tentativa = 2 e lembrete_pai_id', async () => {
      const original = { id: LEMBRETE_ID, cicloId: CICLO_ID, tentativa: 1 };
      const retry = { id: 'retry-uuid', tentativa: 2 };

      sql.mockResolvedValueOnce([original]).mockResolvedValueOnce([retry]);

      const resultado = await service.criarRetry(LEMBRETE_ID, LOJA_ID, 24);
      expect(resultado.tentativa).toBe(2);
    });

    it('lança NotFoundException para lembrete original inexistente', async () => {
      sql.mockResolvedValueOnce([]);
      await expect(service.criarRetry('id-invalido', LOJA_ID, 24)).rejects.toThrow(NotFoundException);
    });
  });

  describe('resumoPorPeriodo', () => {
    it('retorna métricas com taxa de resposta calculada', async () => {
      const resumo = { totalEnviados: 10, totalRespondidos: 7, taxaRespostaPct: 70.0 };
      sql.mockResolvedValueOnce([resumo]);

      const resultado = await service.resumoPorPeriodo(LOJA_ID, 30);
      expect(resultado.taxaRespostaPct).toBe(70.0);
    });
  });

  describe('cancelar', () => {
    it('cancela lembrete com sucesso', async () => {
      sql.mockResolvedValueOnce([{ id: LEMBRETE_ID }]).mockResolvedValueOnce([]);
      await expect(service.cancelar(LEMBRETE_ID, LOJA_ID)).resolves.not.toThrow();
    });

    it('lança NotFoundException para lembrete de outra loja', async () => {
      sql.mockResolvedValueOnce([]);
      await expect(service.cancelar(LEMBRETE_ID, 'outra-loja')).rejects.toThrow(NotFoundException);
    });
  });
});
