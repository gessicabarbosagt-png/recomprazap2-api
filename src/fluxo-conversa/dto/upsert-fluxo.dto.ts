import {
  IsString,
  IsNotEmpty,
  IsArray,
  IsEnum,
  IsOptional,
  IsInt,
  Min,
  Max,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { AcaoFluxo } from '../fluxo-conversa.types';

const ACOES_VALIDAS: AcaoFluxo[] = [
  'registrar_pedido',
  'adiar_lembrete',
  'cancelar_ciclo',
  'nenhuma',
];

class AcaoParamsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  dias?: number;
}

export class OpcaoFluxoDto {
  @IsString()
  @IsNotEmpty({ message: 'Gatilho não pode ser vazio' })
  gatilho: string;

  @IsString()
  @IsNotEmpty({ message: 'Rótulo não pode ser vazio' })
  rotulo: string;

  @IsString()
  @IsNotEmpty({ message: 'Mensagem de resposta não pode ser vazia' })
  mensagem_resposta: string;

  @IsEnum(ACOES_VALIDAS, { message: 'Ação inválida' })
  acao: AcaoFluxo;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AcaoParamsDto)
  acao_params?: AcaoParamsDto;
}

export class UpsertFluxoDto {
  @IsString()
  @IsNotEmpty({ message: 'Mensagem do lembrete não pode ser vazia' })
  mensagem_lembrete: string;

  @IsString()
  @IsNotEmpty({ message: 'Mensagem de fallback não pode ser vazia' })
  mensagem_fallback: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Informe pelo menos 1 opção' })
  @ArrayMaxSize(5, { message: 'Máximo de 5 opções' })
  @ValidateNested({ each: true })
  @Type(() => OpcaoFluxoDto)
  opcoes: OpcaoFluxoDto[];
}

export class TestarFluxoDto {
  @IsString()
  @IsNotEmpty({ message: 'Informe seu telefone com DDD (ex: +5511999990000)' })
  telefone: string;
}
