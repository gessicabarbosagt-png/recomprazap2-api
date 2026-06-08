import { Controller, UseGuards } from '@nestjs/common';
import { LojasService } from './lojas.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('lojas')
export class LojasController {
  constructor(private readonly lojasService: LojasService) {}
  // TODO: implementar rotas
}
