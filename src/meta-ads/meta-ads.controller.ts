import {
  Controller, UseGuards, Get, Patch, Delete, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { MetaAdsService } from './meta-ads.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';
import {
  IsBoolean, IsOptional, IsString, IsArray, ArrayUnique,
} from 'class-validator';

class SalvarMetaAdsDto {
  @IsOptional() @IsString() pixelId?: string | null;
  @IsOptional() @IsString() accessToken?: string;
  @IsOptional() @IsBoolean() ativa?: boolean;
  @IsOptional() @IsArray() @ArrayUnique() eventosAtivos?: string[];
}

@UseGuards(JwtAuthGuard)
@Controller('lojas/minha/meta-ads')
export class MetaAdsController {
  constructor(private readonly service: MetaAdsService) {}

  @Get()
  buscarConfig(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.service.buscarConfig(usuario.lojaId);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  salvarConfig(@Body() dto: SalvarMetaAdsDto, @UsuarioAtual() usuario: UsuarioLogado) {
    return this.service.salvarConfig(usuario.lojaId, dto);
  }

  @Delete('token')
  @HttpCode(HttpStatus.OK)
  limparToken(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.service.limparToken(usuario.lojaId);
  }
}
