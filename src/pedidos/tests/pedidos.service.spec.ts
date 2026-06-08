import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PedidosService } from '../pedidos.service';
import { CiclosService } from '../../ciclos/ciclos.service';
import { DATABASE_CLIENT } from '../../database/database.module';

const LOJA_ID    = 'loja-uuid-1';
const PEDIDO_ID  = 'pedido-uuid-1';
const CICLO_ID   = 'ciclo-uuid-1';
const LEMBRETE_ID = 'lembrete-uuid-1';

const pedidoPendente = {
  id: PEDIDO_ID,
  status: 'pendente',
  lojaId: LOJA_ID,
  lembreteId: LEMBRETE_ID,
  clienteId: 'cliente-1',
  produtoId: 'produto-1',
  quantidade: 2,
  precoUnitario: 50,
};

describe('PedidosService', () => {
  let service: PedidosService;
  let sql: jest.Mock;
  let ciclosService: { registrarCompra: jest.Mock };

  beforeEach(async () => {
    sql = jest.fn().mockResolvedValue([]);
    ciclosService = { registrarCompra: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PedidosService,
        { provide: DATABASE_CLIENT, useValue: sql },
        { provide: CiclosService, useValue: ciclosService },
      ],
    }).compile();

    service = module.get<PedidosService>(PedidosService);
  });

  // ----------------------------------------------------------------
  // atualizar — lógica de negócio mais crítica
  // ----------------------------------------------------------------
  describe('atualizar', () => {
    it('confirma um pedido pendente com sucesso', async () => {
      const pedidoConfirmado = { ...pedidoPendente, status: 'confirmado' };

      sql
        .mockResolvedValueOnce([pedidoPendente])     // buscarPorId
        .mockResolvedValueOnce([pedidoConfirmado]);  // UPDATE

      const resultado = await service.atualizar(PEDIDO_ID, { status: 'confirmado' }, LOJA_ID);
      expect(resultado.status).toBe('confirmado');
    });

    it('ao marcar como entregue, chama registrarCompra no ciclo para reiniciar contador', async () => {
      const pedidoEntregue = { ...pedidoPendente, status: 'entregue' };

      sql
        .mockResolvedValueOnce([pedidoPendente])    // buscarPorId
        .mockResolvedValueOnce([pedidoEntregue])    // UPDATE pedido
        .mockResolvedValueOnce([{ cicloId: CICLO_ID }]); // busca lembrete → ciclo_id

      await service.atualizar(PEDIDO_ID, { status: 'entregue' }, LOJA_ID);

      // Esta é a regra de negócio mais importante:
      // entrega → ciclo reinicia → próxima notificação é recalculada
      expect(ciclosService.registrarCompra).toHaveBeenCalledWith(CICLO_ID, LOJA_ID);
    });

    it('NÃO reinicia o ciclo quando pedido é apenas confirmado (não entregue)', async () => {
      const pedidoConfirmado = { ...pedidoPendente, status: 'confirmado' };

      sql
        .mockResolvedValueOnce([pedidoPendente])
        .mockResolvedValueOnce([pedidoConfirmado]);

      await service.atualizar(PEDIDO_ID, { status: 'confirmado' }, LOJA_ID);

      expect(ciclosService.registrarCompra).not.toHaveBeenCalled();
    });

    it('lança BadRequestException ao tentar alterar pedido já entregue', async () => {
      const pedidoJaEntregue = { ...pedidoPendente, status: 'entregue' };
      sql.mockResolvedValueOnce([pedidoJaEntregue]);

      await expect(
        service.atualizar(PEDIDO_ID, { status: 'confirmado' }, LOJA_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança BadRequestException ao tentar alterar pedido já cancelado', async () => {
      const pedidoCancelado = { ...pedidoPendente, status: 'cancelado' };
      sql.mockResolvedValueOnce([pedidoCancelado]);

      await expect(
        service.atualizar(PEDIDO_ID, { status: 'confirmado' }, LOJA_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança NotFoundException para pedido de outra loja', async () => {
      sql.mockResolvedValueOnce([]); // isolamento: query com loja errada retorna vazio

      await expect(
        service.atualizar(PEDIDO_ID, { status: 'confirmado' }, 'outra-loja'),
      ).rejects.toThrow(NotFoundException);
    });

    it('atualiza tipo de entrega e pagamento sem mudar status', async () => {
      const pedidoAtualizado = {
        ...pedidoPendente,
        tipoEntrega: 'retirada',
        tipoPagamento: 'pix',
      };

      sql
        .mockResolvedValueOnce([pedidoPendente])
        .mockResolvedValueOnce([pedidoAtualizado]);

      const resultado = await service.atualizar(
        PEDIDO_ID,
        { tipoEntrega: 'retirada', tipoPagamento: 'pix' },
        LOJA_ID,
      );

      expect(resultado.tipoEntrega).toBe('retirada');
      expect(ciclosService.registrarCompra).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // resumoPorPeriodo — relatório RF-42
  // ----------------------------------------------------------------
  describe('resumoPorPeriodo', () => {
    it('retorna métricas do período solicitado', async () => {
      const resumoFake = {
        totalPedidos: 10,
        totalEntregues: 7,
        totalCancelados: 1,
        totalPendentes: 2,
        receitaEstimada: 350,
      };
      sql.mockResolvedValueOnce([resumoFake]);

      const resultado = await service.resumoPorPeriodo(LOJA_ID, 30);
      expect(resultado).toEqual(resumoFake);
    });
  });
});
