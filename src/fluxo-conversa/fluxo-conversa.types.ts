export type AcaoFluxo =
  | 'registrar_pedido'
  | 'adiar_lembrete'
  | 'cancelar_ciclo'
  | 'nenhuma';

export interface OpcaoFluxo {
  gatilho: string;
  rotulo: string;
  mensagem_resposta: string;
  acao: AcaoFluxo;
  acao_params?: { dias?: number };
}

export const MENSAGEM_LEMBRETE_PADRAO =
  `Oi, {nome}! 👋\n\nJá está na hora de repor *{produto}*{quantidade}. Posso te ajudar?\n\nResponda:\n1️⃣ *1* — Quero pedir\n2️⃣ *2* — Me avise depois\n3️⃣ *3* — Não quero mais`;

export const MENSAGEM_FALLBACK_PADRAO =
  `Não entendi sua resposta. Por favor, responda com *1*, *2* ou *3* conforme as opções enviadas anteriormente.`;

export const OPCOES_PADRAO: OpcaoFluxo[] = [
  {
    gatilho: '1',
    rotulo: 'Quero pedir',
    mensagem_resposta: 'Ótimo! Seu pedido foi registrado. Em breve entraremos em contato. 😊',
    acao: 'registrar_pedido',
  },
  {
    gatilho: '2',
    rotulo: 'Me avise depois',
    mensagem_resposta: 'Tudo bem! Vou te avisar de novo em 7 dias. 📅',
    acao: 'adiar_lembrete',
    acao_params: { dias: 7 },
  },
  {
    gatilho: '3',
    rotulo: 'Não quero mais',
    mensagem_resposta: 'Entendido! Pausei os lembretes desse produto. Se precisar de algo, estamos aqui. 😊',
    acao: 'cancelar_ciclo',
  },
];

/**
 * Extrai o primeiro dígito da resposta do cliente.
 * Aceita "1", "1.", "Opção 1", " 2 ", "quero a 3a opção", etc.
 * Retorna null se nenhum dígito for encontrado.
 */
export function normalizarResposta(texto: string): string | null {
  const match = texto.trim().match(/\d/);
  return match ? match[0] : null;
}

/**
 * Substitui variáveis {chave} no template pelos valores fornecidos.
 * Chaves sem correspondência são substituídas por string vazia.
 * Quando {nome} é vazio, remove vírgulas adjacentes para evitar "Oi, !".
 */
export function interpolarVariaveis(
  template: string,
  vars: Record<string, string>,
): string {
  let tpl = template;
  if (!vars['nome']) {
    tpl = tpl.replace(/,\s*\{nome\}/g, '').replace(/\{nome\}\s*,\s*/g, '');
  }
  return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}
