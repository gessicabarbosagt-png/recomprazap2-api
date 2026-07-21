import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth.service';
import { DATABASE_CLIENT } from '../../database/database.module';

const usuarioLojista = {
  id: 'user-uuid-1',
  nome: 'Maria',
  email: 'maria@loja.com',
  senhaHash: '$2b$12$fakeHash',
  perfil: 'dono',
  role: 'lojista',
  lojaId: 'loja-uuid-1',
  lojaNome: 'Loja Maria',
};

const usuarioAdmin = {
  id: 'admin-uuid-1',
  nome: 'Admin',
  email: 'admin@system.com',
  senhaHash: '$2b$12$fakeHash',
  perfil: 'dono',
  role: 'admin',
  lojaId: null,
  lojaNome: null,
};

describe('AuthService', () => {
  let service: AuthService;
  let sql: jest.Mock;
  let jwtService: { sign: jest.Mock };

  beforeEach(async () => {
    sql = jest.fn().mockResolvedValue([]);
    jwtService = { sign: jest.fn().mockReturnValue('fake-jwt-token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DATABASE_CLIENT, useValue: sql },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('retorna token quando lojista e loja estão ativos', async () => {
    sql.mockResolvedValueOnce([usuarioLojista]);
    jest.spyOn(bcrypt, 'compare').mockResolvedValueOnce(true as never);

    const resultado = await service.login({ email: 'maria@loja.com', senha: '123456' });

    expect(resultado.accessToken).toBe('fake-jwt-token');
    expect(resultado.usuario.role).toBe('lojista');
    expect(resultado.usuario.loja).not.toBeNull();
  });

  it('lança 401 quando a loja está desativada (SQL não retorna usuário)', async () => {
    // A query aplica: l.ativa = TRUE AND l.status_assinatura != 'cancelada'
    // Loja desativada é excluída pelo banco antes mesmo de checar a senha.
    sql.mockResolvedValueOnce([]);

    await expect(service.login({ email: 'maria@loja.com', senha: '123456' }))
      .rejects.toThrow(UnauthorizedException);
  });

  it('lança 401 quando a assinatura está cancelada (SQL não retorna usuário)', async () => {
    // status_assinatura = 'cancelada' é tratado igual à loja desativada: sem acesso.
    sql.mockResolvedValueOnce([]);

    await expect(service.login({ email: 'maria@loja.com', senha: '123456' }))
      .rejects.toThrow(UnauthorizedException);
  });

  it('admin loga independente de loja (loja_id = NULL, sem restrição de status)', async () => {
    sql.mockResolvedValueOnce([usuarioAdmin]);
    jest.spyOn(bcrypt, 'compare').mockResolvedValueOnce(true as never);

    const resultado = await service.login({ email: 'admin@system.com', senha: 'adminpass' });

    expect(resultado.usuario.role).toBe('admin');
    expect(resultado.usuario.loja).toBeNull();
  });

  it('lança 401 quando a senha está incorreta', async () => {
    sql.mockResolvedValueOnce([usuarioLojista]);
    jest.spyOn(bcrypt, 'compare').mockResolvedValueOnce(false as never);

    await expect(service.login({ email: 'maria@loja.com', senha: 'errada' }))
      .rejects.toThrow(UnauthorizedException);
  });
});
