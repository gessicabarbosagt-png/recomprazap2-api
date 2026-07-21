import { Injectable, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Injectable()
export class AdminGuard extends JwtAuthGuard {
  handleRequest(err: any, user: any, info: any, context: any) {
    const u = super.handleRequest(err, user, info, context);
    if (!u || u.role !== 'admin') {
      throw new ForbiddenException('Acesso restrito ao administrador do sistema');
    }
    return u;
  }
}
