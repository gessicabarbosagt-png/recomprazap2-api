import {
  normalizarResposta,
  interpolarVariaveis,
  MENSAGEM_LEMBRETE_PADRAO,
  MENSAGEM_FALLBACK_PADRAO,
  OPCOES_PADRAO,
  type OpcaoFluxo,
} from '../fluxo-conversa.types';

// ----------------------------------------------------------------
// normalizarResposta
// ----------------------------------------------------------------
describe('normalizarResposta', () => {
  it('retorna o dígito de respostas simples', () => {
    expect(normalizarResposta('1')).toBe('1');
    expect(normalizarResposta('2')).toBe('2');
    expect(normalizarResposta('3')).toBe('3');
  });

  it('ignora espaços ao redor', () => {
    expect(normalizarResposta('  2  ')).toBe('2');
  });

  it('aceita texto antes do dígito', () => {
    expect(normalizarResposta('Opção 1')).toBe('1');
    expect(normalizarResposta('quero a opção 3')).toBe('3');
    expect(normalizarResposta('resposta: 2')).toBe('2');
  });

  it('aceita dígito com pontuação', () => {
    expect(normalizarResposta('1.')).toBe('1');
    expect(normalizarResposta('2!')).toBe('2');
    expect(normalizarResposta('(3)')).toBe('3');
  });

  it('retorna o PRIMEIRO dígito quando há múltiplos', () => {
    expect(normalizarResposta('1 ou 2')).toBe('1');
  });

  it('retorna null quando não há dígito', () => {
    expect(normalizarResposta('')).toBeNull();
    expect(normalizarResposta('sim')).toBeNull();
    expect(normalizarResposta('não quero')).toBeNull();
  });
});

// ----------------------------------------------------------------
// interpolarVariaveis
// ----------------------------------------------------------------
describe('interpolarVariaveis', () => {
  it('substitui variáveis simples', () => {
    const resultado = interpolarVariaveis('Oi, {nome}! Produto: {produto}.', {
      nome: 'Maria',
      produto: 'Ração Golden',
    });
    expect(resultado).toBe('Oi, Maria! Produto: Ração Golden.');
  });

  it('substitui múltiplas ocorrências da mesma variável', () => {
    const resultado = interpolarVariaveis('{nome} é {nome}!', { nome: 'João' });
    expect(resultado).toBe('João é João!');
  });

  it('deixa string vazia onde não há valor para a variável', () => {
    const resultado = interpolarVariaveis('Oi {nome}! Loja: {loja}.', { nome: 'Ana' });
    expect(resultado).toBe('Oi Ana! Loja: .');
  });

  it('não altera template sem variáveis', () => {
    const template = 'Mensagem sem variáveis.';
    expect(interpolarVariaveis(template, { nome: 'Ana' })).toBe(template);
  });

  it('interpola o template padrão corretamente', () => {
    const resultado = interpolarVariaveis(MENSAGEM_LEMBRETE_PADRAO, {
      nome: 'Pedro',
      produto: 'Milho',
      quantidade: ' (50 kg)',
      loja: 'AgroLoja',
    });
    expect(resultado).toContain('Pedro');
    expect(resultado).toContain('Milho');
    expect(resultado).toContain('50 kg');
    expect(resultado).not.toContain('{nome}');
    expect(resultado).not.toContain('{produto}');
  });
});

// ----------------------------------------------------------------
// matching de gatilho e limite de fallback (lógica pura)
// ----------------------------------------------------------------
describe('matching de gatilho', () => {
  const opcoes: OpcaoFluxo[] = OPCOES_PADRAO;

  it('encontra a opção pelo gatilho normalizado', () => {
    expect(normalizarResposta('1')).toBe('1');
    const match = opcoes.find((o) => o.gatilho === normalizarResposta('1'));
    expect(match?.acao).toBe('registrar_pedido');
  });

  it('encontra opção mesmo com texto extra', () => {
    const gatilho = normalizarResposta('quero a opção 2 por favor');
    const match = opcoes.find((o) => o.gatilho === gatilho);
    expect(match?.acao).toBe('adiar_lembrete');
    expect(match?.acao_params?.dias).toBe(7);
  });

  it('retorna undefined quando não há match', () => {
    const gatilho = normalizarResposta('não sei');
    const match = gatilho ? opcoes.find((o) => o.gatilho === gatilho) : undefined;
    expect(match).toBeUndefined();
  });

  it('retorna undefined para texto sem dígito', () => {
    const gatilho = normalizarResposta('sim, quero');
    expect(gatilho).toBeNull();
    const match = gatilho ? opcoes.find((o) => o.gatilho === gatilho) : undefined;
    expect(match).toBeUndefined();
  });
});

describe('limite de fallback', () => {
  it('deve responder nos fallbacks 1 e 2 e silenciar no 3', () => {
    const MAX_FALLBACKS = 2;
    const devResponder = (fallbacks: number) => fallbacks <= MAX_FALLBACKS;

    expect(devResponder(1)).toBe(true);
    expect(devResponder(2)).toBe(true);
    expect(devResponder(3)).toBe(false);
    expect(devResponder(99)).toBe(false);
  });
});

// ----------------------------------------------------------------
// fallback para comportamento hardcoded quando não há fluxo
// ----------------------------------------------------------------
describe('fallback para comportamento hardcoded', () => {
  it('comportamento legado ativado quando sessão é null', () => {
    const sessao = null;
    const fluxo = null;
    const texto = '1';

    const deveUsarEngine = sessao !== null && fluxo !== null;
    const deveUsarLegado = !deveUsarEngine && /^[123]$/.test(texto.trim());

    expect(deveUsarEngine).toBe(false);
    expect(deveUsarLegado).toBe(true);
  });

  it('comportamento legado ativado quando fluxo é null (sem sessão)', () => {
    const sessao = { id: 'uuid', lembreteId: 'lid' };
    const fluxo = null;
    const texto = '2';

    const deveUsarEngine = sessao !== null && fluxo !== null;
    const deveUsarLegado = !deveUsarEngine && /^[123]$/.test(texto.trim());

    expect(deveUsarEngine).toBe(false);
    expect(deveUsarLegado).toBe(true);
  });

  it('engine ativo quando ambos existem', () => {
    const sessao = { id: 'uuid', lembreteId: 'lid', fallbacks: 0 };
    const fluxo = { mensagemFallback: MENSAGEM_FALLBACK_PADRAO, opcoes: OPCOES_PADRAO };

    const deveUsarEngine = sessao !== null && fluxo !== null;
    expect(deveUsarEngine).toBe(true);
  });

  it('legado NÃO é ativado quando texto não é 1/2/3', () => {
    const sessao = null;
    const fluxo = null;
    const texto = 'oi tudo bem';

    const deveUsarLegado = (sessao === null || fluxo === null) && /^[123]$/.test(texto.trim());
    expect(deveUsarLegado).toBe(false);
  });
});

// ----------------------------------------------------------------
// constantes padrão
// ----------------------------------------------------------------
describe('constantes padrão', () => {
  it('OPCOES_PADRAO tem exatamente 3 opções com gatilhos únicos', () => {
    expect(OPCOES_PADRAO).toHaveLength(3);
    const gatilhos = OPCOES_PADRAO.map((o) => o.gatilho);
    expect(new Set(gatilhos).size).toBe(3);
  });

  it('OPCOES_PADRAO cobre registrar_pedido, adiar_lembrete, cancelar_ciclo', () => {
    const acoes = OPCOES_PADRAO.map((o) => o.acao);
    expect(acoes).toContain('registrar_pedido');
    expect(acoes).toContain('adiar_lembrete');
    expect(acoes).toContain('cancelar_ciclo');
  });

  it('MENSAGEM_LEMBRETE_PADRAO contém variáveis {nome} e {produto}', () => {
    expect(MENSAGEM_LEMBRETE_PADRAO).toContain('{nome}');
    expect(MENSAGEM_LEMBRETE_PADRAO).toContain('{produto}');
  });

  it('MENSAGEM_FALLBACK_PADRAO não é vazia', () => {
    expect(MENSAGEM_FALLBACK_PADRAO.trim().length).toBeGreaterThan(10);
  });
});
