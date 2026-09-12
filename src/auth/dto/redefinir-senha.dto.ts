import { IsString, MinLength } from 'class-validator';

export class RedefinirSenhaDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(6, { message: 'A senha deve ter pelo menos 6 caracteres' })
  novaSenha: string;
}
