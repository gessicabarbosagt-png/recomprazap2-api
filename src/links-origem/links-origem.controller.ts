import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, HttpCode, HttpStatus,
  Res, NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { LinksOrigemService } from './links-origem.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsuarioAtual, UsuarioLogado } from '../common/decorators/usuario-atual.decorator';
import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

class CriarLinkDto {
  @IsString() @MinLength(1) @MaxLength(100) rotulo: string;
  @IsOptional() @IsString() mensagemPrefixo?: string;
  @IsOptional() @IsString() codigoParaEmbutir?: string;
}

class AtualizarLinkDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) rotulo?: string;
  @IsOptional() @IsString() mensagemPrefixo?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('links-origem')
export class LinksOrigemController {
  constructor(private readonly service: LinksOrigemService) {}

  @Get()
  listar(@UsuarioAtual() usuario: UsuarioLogado) {
    return this.service.listar(usuario.lojaId);
  }

  @Post()
  criar(@Body() dto: CriarLinkDto, @UsuarioAtual() usuario: UsuarioLogado) {
    return this.service.criar(usuario.lojaId, dto);
  }

  @Patch(':id')
  atualizar(
    @Param('id') id: string,
    @Body() dto: AtualizarLinkDto,
    @UsuarioAtual() usuario: UsuarioLogado,
  ) {
    return this.service.atualizar(id, usuario.lojaId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remover(@Param('id') id: string, @UsuarioAtual() usuario: UsuarioLogado) {
    return this.service.remover(id, usuario.lojaId);
  }
}

// Rota pública — sem JWT guard
@Controller('links-origem')
export class LinksOrigemPublicController {
  constructor(private readonly service: LinksOrigemService) {}

  @Get('r/:slug')
  async redirectSlug(
    @Param('slug') slug: string,
    @Res() res: Response,
  ) {
    const result = await this.service.resolverSlug(slug);
    if (!result) {
      return res.status(404).json({ message: 'Link não encontrado' });
    }
    return res.redirect(302, result.redirectUrl);
  }
}
