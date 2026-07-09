import { IsString, MinLength, MaxLength } from 'class-validator';

export class CriarCodigoDto {
  // Código sem # — ex: "google", "insta", "site"
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  codigo: string;

  // Rótulo exibido no painel — ex: "Google Ads", "Instagram"
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  rotulo: string;
}
