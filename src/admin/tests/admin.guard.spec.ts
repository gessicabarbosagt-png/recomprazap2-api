import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';

describe('AdminGuard', () => {
  let guard: AdminGuard;

  beforeEach(() => {
    guard = new AdminGuard();
  });

  it('passa usuário admin sem erro', () => {
    const admin = { id: 'uuid-1', role: 'admin', lojaId: null, perfil: 'dono' };
    const resultado = guard.handleRequest(null, admin, null, null);
    expect(resultado).toBe(admin);
  });

  it('lança 403 para usuário lojista', () => {
    const lojista = { id: 'uuid-2', role: 'lojista', lojaId: 'loja-1', perfil: 'dono' };
    expect(() => guard.handleRequest(null, lojista, null, null)).toThrow(ForbiddenException);
  });

  it('lança 401 quando o token é inválido (super.handleRequest lança)', () => {
    const err = new UnauthorizedException('Token inválido');
    expect(() => guard.handleRequest(err, null, null, null)).toThrow();
  });

  it('lança 401 quando user é null sem erro (token ausente — Passport lança antes)', () => {
    expect(() => guard.handleRequest(null, null, null, null)).toThrow(UnauthorizedException);
  });
});
