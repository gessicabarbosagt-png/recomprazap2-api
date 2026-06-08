import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Este decorator é um atalho para pegar o usuário logado dentro de um Controller.
//
// Sem ele, você precisaria escrever:
//   @Request() req: any  →  req.user.lojaId
//
// Com ele, você escreve:
//   @UsuarioAtual() usuario  →  usuario.lojaId
//
// Exemplo de uso em um Controller:
//   @Get()
//   listar(@UsuarioAtual() usuario: UsuarioLogado) {
//     return this.clientesService.listar(usuario.lojaId);
//   }

export const UsuarioAtual = createParamDecorator(
  (data: keyof UsuarioLogado | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const usuario = request.user as UsuarioLogado;

    // Se passar uma chave específica, retorna só aquele campo
    // Ex: @UsuarioAtual('lojaId') → retorna só o lojaId
    return data ? usuario?.[data] : usuario;
  },
);

// Tipo que representa o usuário logado (vem do JwtStrategy.validate)
export interface UsuarioLogado {
  id: string;
  lojaId: string;
  perfil: string;
}
