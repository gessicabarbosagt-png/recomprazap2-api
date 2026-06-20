import { IsString, IsEmail, IsOptional, IsBoolean, MinLength } from 'class-validator';

// No update, todos os campos são opcionais — só atualiza o que for enviado
export class AtualizarClienteDto {
  @IsString()
  @MinLength(2)
  @IsOptional()
  nome?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsBoolean()
  @IsOptional()
  ativo?: boolean;
}
