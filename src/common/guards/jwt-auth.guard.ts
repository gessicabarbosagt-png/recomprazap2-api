import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Em vez de escrever @UseGuards(AuthGuard('jwt')) em todo lugar,
// criamos este guard com nome próprio.
//
// Uso:
//   @UseGuards(JwtAuthGuard)
//   @Get()
//   listar() { ... }

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
