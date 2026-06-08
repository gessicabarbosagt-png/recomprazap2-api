import { IsString, IsEmail, IsOptional, IsBoolean, Matches, MinLength } from 'class-validator';

export class CriarClienteDto {
  @IsString()
  @MinLength(2, { message: 'Nome deve ter pelo menos 2 caracteres' })
  nome: string;

  // Valida formato E.164: +5511999999999
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'Telefone deve estar no formato internacional: +5511999999999',
  })
  telefone: string;

  @IsEmail({}, { message: 'Email inválido' })
  @IsOptional()
  email?: string;

  @IsBoolean()
  consentimentoWhatsapp: boolean;
}
