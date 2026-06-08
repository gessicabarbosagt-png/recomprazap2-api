import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { ClientesService } from '../clientes.service';
import { DATABASE_CLIENT } from '../../database/database.module';

const LOJA_ID    = 'loja-uuid-1';
const CLIENTE_ID = 'cliente-uuid-1';

describe('ClientesService', () => {
  let service: ClientesService;
  let sql: jest.Mock;

  beforeEach(async () => {
    sql = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientesService,
        { provide: DATABASE_CLIENT, useValue: sql },
      ],
    }).compile();

    service = module.get<ClientesService>(ClientesService);
  });

  // ----------------------------------------------------------------
  // criar
  // ----------------------------------------------------------------
  describe('criar', () => {
    const dto = {
      nome: 'Maria Silva',
      telefone: '+5511999990000',
      consentimentoWhatsapp: true,
    };

    it('cria cliente com consentimento e registra data do consentimento', async () => {
      const clienteCriado = { id: CLIENTE_ID, ...dto, consentimentoData: new Date() };

      sql
        .mockResolvedValueOnce([])           // telefone não duplicado
        .mockResolvedValueOnce([clienteCriado]); // INSERT

      const resultado = await service.criar(dto, LOJA_ID);

      expect(resultado.id).toBe(CLIENTE_ID);
      expect(resultado.consentimentoData).toBeDefined(); // LGPD: data registrada
    });

    it('lança ConflictException para telefone duplicado na mesma loja', async () => {
      sql.mockResolvedValueOnce([{ id: 'outro-id' }]); // telefone já existe

      await expect(service.criar(dto, LOJA_ID))
        .rejects.toThrow(ConflictException);
    });

    it('permite mesmo telefone em lojas diferentes (isolamento correto)', async () => {
      // A query de duplicidade já filtra por loja_id — então para outra loja retorna vazio
      const clienteCriado = { id: CLIENTE_ID, ...dto };
      sql
        .mockResolvedValueOnce([])              // sem duplicata nessa loja
        .mockResolvedValueOnce([clienteCriado]);

      const resultado = await service.criar(dto, 'outra-loja-id');
      expect(resultado).toBeDefined();
    });

    it('cria cliente sem email (campo opcional)', async () => {
      const dtoSemEmail = { nome: 'João', telefone: '+5511888880000', consentimentoWhatsapp: false };
      const clienteCriado = { id: CLIENTE_ID, ...dtoSemEmail, email: null };

      sql
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([clienteCriado]);

      const resultado = await service.criar(dtoSemEmail, LOJA_ID);
      expect(resultado.email).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // buscarPorId
  // ----------------------------------------------------------------
  describe('buscarPorId', () => {
    it('retorna o cliente quando pertence à loja', async () => {
      const clienteFake = { id: CLIENTE_ID, nome: 'Maria', lojaId: LOJA_ID };
      sql.mockResolvedValueOnce([clienteFake]);

      const resultado = await service.buscarPorId(CLIENTE_ID, LOJA_ID);
      expect(resultado).toEqual(clienteFake);
    });

    it('lança NotFoundException para cliente de outra loja', async () => {
      sql.mockResolvedValueOnce([]); // query com loja_id errado retorna vazio

      await expect(service.buscarPorId(CLIENTE_ID, 'outra-loja'))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------------
  // atualizar
  // ----------------------------------------------------------------
  describe('atualizar', () => {
    it('atualiza campos permitidos', async () => {
      const clienteAtual = { id: CLIENTE_ID, nome: 'Maria', ativo: true };
      const clienteAtualizado = { ...clienteAtual, nome: 'Maria Silva' };

      sql
        .mockResolvedValueOnce([clienteAtual])       // buscarPorId
        .mockResolvedValueOnce([clienteAtualizado]); // UPDATE

      const resultado = await service.atualizar(CLIENTE_ID, { nome: 'Maria Silva' }, LOJA_ID);
      expect(resultado.nome).toBe('Maria Silva');
    });

    it('lança NotFoundException ao atualizar cliente inexistente', async () => {
      sql.mockResolvedValueOnce([]);
      await expect(service.atualizar('id-errado', { nome: 'x' }, LOJA_ID))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------------
  // remover
  // ----------------------------------------------------------------
  describe('remover', () => {
    it('faz soft delete sem apagar do banco', async () => {
      sql
        .mockResolvedValueOnce([{ id: CLIENTE_ID }])
        .mockResolvedValueOnce([]);

      await expect(service.remover(CLIENTE_ID, LOJA_ID)).resolves.not.toThrow();
      expect(sql).toHaveBeenCalledTimes(2);
    });
  });
});
