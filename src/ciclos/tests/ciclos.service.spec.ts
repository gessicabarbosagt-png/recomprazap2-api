import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { CiclosService } from '../ciclos.service';
import { DATABASE_CLIENT } from '../../database/database.module';

// ----------------------------------------------------------------
// Fábrica de mocks reutilizáveis — evita repetição nos testes
// ----------------------------------------------------------------
const makeSql = (overrides: Record<string, jest.Mock> = {}) => {
  // O cliente "postgres" usa tagged template literals (sql`...`).
  // Simulamos como uma função que retorna um array por padrão.
  const sql = jest.fn().mockResolvedValue([]) as any;
  Object.assign(sql, overrides);
  return sql;
};

const LOJA_ID    = 'loja-uuid-1';
const CLIENTE_ID = 'cliente-uuid-1';
const PRODUTO_ID = 'produto-uuid-1';
const CICLO_ID   = 'ciclo-uuid-1';

describe('CiclosService', () => {
  let service: CiclosService;
  let sql: any;

  beforeEach(async () => {
    sql = makeSql();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CiclosService,
        { provide: DATABASE_CLIENT, useValue: sql },
      ],
    }).compile();

    service = module.get<CiclosService>(CiclosService);
  });

  // ----------------------------------------------------------------
  // listar
  // ----------------------------------------------------------------
  describe('listar', () => {
    it('retorna a lista de ciclos da loja', async () => {
      const ciclosFake = [
        { id: CICLO_ID, intervaloDias: 30, clienteNome: 'João' },
      ];
      sql.mockResolvedValueOnce(ciclosFake);

      const resultado = await service.listar(LOJA_ID);

      expect(resultado).toEqual(ciclosFake);
      expect(sql).toHaveBeenCalledTimes(1);
    });

    it('retorna array vazio quando não há ciclos', async () => {
      sql.mockResolvedValueOnce([]);
      const resultado = await service.listar(LOJA_ID);
      expect(resultado).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // buscarPorId
  // ----------------------------------------------------------------
  describe('buscarPorId', () => {
    it('retorna o ciclo quando encontrado', async () => {
      const cicloFake = { id: CICLO_ID, intervaloDias: 30 };
      sql.mockResolvedValueOnce([cicloFake]);

      const resultado = await service.buscarPorId(CICLO_ID, LOJA_ID);
      expect(resultado).toEqual(cicloFake);
    });

    it('lança NotFoundException quando ciclo não existe', async () => {
      sql.mockResolvedValueOnce([]); // banco retorna vazio

      await expect(service.buscarPorId('id-invalido', LOJA_ID))
        .rejects.toThrow(NotFoundException);
    });

    it('não retorna ciclo de outra loja (isolamento multi-tenant)', async () => {
      // A query filtra por loja_id — banco retorna vazio para loja errada
      sql.mockResolvedValueOnce([]);

      await expect(service.buscarPorId(CICLO_ID, 'outra-loja'))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------------
  // criar
  // ----------------------------------------------------------------
  describe('criar', () => {
    const dto = {
      clienteId: CLIENTE_ID,
      produtoId: PRODUTO_ID,
      intervaloDias: 30,
      quantidade: 5,
    };

    it('cria o ciclo com sucesso quando cliente, produto existem e não há duplicata', async () => {
      const novoCiclo = { id: CICLO_ID, ...dto, lojaId: LOJA_ID };

      sql
        .mockResolvedValueOnce([{ id: CLIENTE_ID }]) // cliente existe
        .mockResolvedValueOnce([{ id: PRODUTO_ID }]) // produto existe
        .mockResolvedValueOnce([])                   // sem ciclo duplicado
        .mockResolvedValueOnce([novoCiclo]);          // INSERT retorna o novo ciclo

      const resultado = await service.criar(dto, LOJA_ID);
      expect(resultado).toEqual(novoCiclo);
    });

    it('lança NotFoundException quando cliente não existe na loja', async () => {
      sql.mockResolvedValueOnce([]); // cliente não encontrado

      await expect(service.criar(dto, LOJA_ID))
        .rejects.toThrow(NotFoundException);
    });

    it('lança NotFoundException quando produto não existe na loja', async () => {
      sql
        .mockResolvedValueOnce([{ id: CLIENTE_ID }]) // cliente ok
        .mockResolvedValueOnce([]);                   // produto não encontrado

      await expect(service.criar(dto, LOJA_ID))
        .rejects.toThrow(NotFoundException);
    });

    it('lança ConflictException quando já existe ciclo para esse cliente+produto', async () => {
      sql
        .mockResolvedValueOnce([{ id: CLIENTE_ID }])  // cliente ok
        .mockResolvedValueOnce([{ id: PRODUTO_ID }])  // produto ok
        .mockResolvedValueOnce([{ id: CICLO_ID }]);   // ciclo duplicado encontrado

      await expect(service.criar(dto, LOJA_ID))
        .rejects.toThrow(ConflictException);
    });

    it('cria ciclo sem quantidade (campo opcional)', async () => {
      const dtoSemQtd = { clienteId: CLIENTE_ID, produtoId: PRODUTO_ID, intervaloDias: 15 };
      const novoCiclo = { id: CICLO_ID, ...dtoSemQtd, quantidade: null };

      sql
        .mockResolvedValueOnce([{ id: CLIENTE_ID }])
        .mockResolvedValueOnce([{ id: PRODUTO_ID }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([novoCiclo]);

      const resultado = await service.criar(dtoSemQtd, LOJA_ID);
      expect(resultado.quantidade).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // atualizar
  // ----------------------------------------------------------------
  describe('atualizar', () => {
    it('atualiza o intervalo e recalcula proxima_notificacao', async () => {
      const cicloAtual = { id: CICLO_ID, intervaloDias: 30, proximaNotificacao: new Date() };
      const cicloAtualizado = { ...cicloAtual, intervaloDias: 15 };

      sql
        .mockResolvedValueOnce([cicloAtual])       // buscarPorId
        .mockResolvedValueOnce([cicloAtualizado]); // UPDATE

      const resultado = await service.atualizar(CICLO_ID, { intervaloDias: 15 }, LOJA_ID);
      expect(resultado.intervaloDias).toBe(15);
    });

    it('lança NotFoundException ao tentar atualizar ciclo inexistente', async () => {
      sql.mockResolvedValueOnce([]); // buscarPorId retorna vazio

      await expect(service.atualizar('id-errado', { intervaloDias: 10 }, LOJA_ID))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------------
  // registrarCompra — lógica crítica: reinicia o contador
  // ----------------------------------------------------------------
  describe('registrarCompra', () => {
    it('atualiza ultima_compra e avança proxima_notificacao', async () => {
      const cicloAtualizado = {
        id: CICLO_ID,
        ultimaCompra: new Date().toISOString().split('T')[0],
      };
      sql.mockResolvedValueOnce([cicloAtualizado]);

      const resultado = await service.registrarCompra(CICLO_ID, LOJA_ID);
      expect(resultado).toEqual(cicloAtualizado);
      // Garante que o UPDATE foi chamado (o SQL que avança a data)
      expect(sql).toHaveBeenCalledTimes(1);
    });

    it('lança NotFoundException se ciclo não encontrado', async () => {
      sql.mockResolvedValueOnce([]); // UPDATE RETURNING vazio

      await expect(service.registrarCompra('id-errado', LOJA_ID))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------------
  // remover
  // ----------------------------------------------------------------
  describe('remover', () => {
    it('faz soft delete com sucesso', async () => {
      sql
        .mockResolvedValueOnce([{ id: CICLO_ID }]) // buscarPorId
        .mockResolvedValueOnce([]);                 // UPDATE deleted_at

      await expect(service.remover(CICLO_ID, LOJA_ID)).resolves.not.toThrow();
      expect(sql).toHaveBeenCalledTimes(2);
    });

    it('lança NotFoundException ao remover ciclo inexistente', async () => {
      sql.mockResolvedValueOnce([]);

      await expect(service.remover('id-errado', LOJA_ID))
        .rejects.toThrow(NotFoundException);
    });
  });
});
