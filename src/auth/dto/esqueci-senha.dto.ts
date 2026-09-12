import { IsEmail } from 'class-validator';

export class EsqueciSenhaDto {
  @IsEmail({}, { message: 'E-mail inválido' })
  email: string;
}
