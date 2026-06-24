import { IsString, IsEmail, IsOptional, IsBoolean, Matches, MinLength } from 'class-validator';

// No update, todos os campos são opcionais — só atualiza o que for enviado
export class AtualizarClienteDto {
  @IsString()
  @MinLength(2)
  @IsOptional()
  nome?: string;

  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'Telefone deve estar no formato internacional: +5511999999999',
  })
  @IsOptional()
  telefone?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsBoolean()
  @IsOptional()
  ativo?: boolean;
}
