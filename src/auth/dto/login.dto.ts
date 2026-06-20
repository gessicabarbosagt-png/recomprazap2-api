import { IsEmail, IsString, MinLength } from 'class-validator';

// DTO = Data Transfer Object
// Define exatamente quais campos são esperados na requisição
// e aplica validações automáticas via class-validator.
// O ValidationPipe no main.ts é quem executa essas validações.

export class LoginDto {
  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Senha deve ter pelo menos 6 caracteres' })
  senha: string;
}
