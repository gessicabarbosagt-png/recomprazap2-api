import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FluxoConversaService } from './fluxo-conversa.service';
import { UpsertFluxoDto, TestarFluxoDto } from './dto/upsert-fluxo.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';

@UseGuards(JwtAuthGuard)
@Controller('fluxo-conversa')
export class FluxoConversaController {
  constructor(private readonly fluxoService: FluxoConversaService) {}

  // GET /api/v1/fluxo-conversa
  @Get()
  buscar(@UsuarioAtual() usuario: any) {
    return this.fluxoService.buscar(usuario.lojaId);
  }

  // PUT /api/v1/fluxo-conversa
  @Put()
  @HttpCode(HttpStatus.OK)
  upsert(@UsuarioAtual() usuario: any, @Body() dto: UpsertFluxoDto) {
    return this.fluxoService.upsert(usuario.lojaId, dto);
  }

  // POST /api/v1/fluxo-conversa/testar
  @Post('testar')
  @HttpCode(HttpStatus.OK)
  testar(@UsuarioAtual() usuario: any, @Body() dto: TestarFluxoDto) {
    return this.fluxoService.testar(usuario.lojaId, dto);
  }
}
