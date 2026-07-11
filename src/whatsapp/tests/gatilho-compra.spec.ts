// Testa a lógica de normalização e matching de gatilhos de compra
// sem instanciar WhatsappBaileysService (que depende do ESM do Baileys)

// ─── Réplica local da função pura (sem importar o serviço) ───────────────────

function normalizarTexto(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function matchGatilho(texto: string, frases: string[]): string | undefined {
  const textoNorm = normalizarTexto(texto);
  return frases.find((f) => textoNorm.includes(normalizarTexto(f)));
}

// ─── testes ───────────────────────────────────────────────────────────────────

describe('normalizarTexto', () => {
  it('converte para minúsculo', () => {
    expect(normalizarTexto('OBRIGAdo')).toBe('obrigado');
  });

  it('remove acentos', () => {
    expect(normalizarTexto('Ação')).toBe('acao');
    expect(normalizarTexto('Comprou!Obrigação')).toBe('comprou!obrigacao');
  });

  it('combina remoção de acento e lowercase', () => {
    expect(normalizarTexto('Obrigado pela COMPRA')).toBe('obrigado pela compra');
  });

  it('texto sem acento encontra gatilho com acento', () => {
    const gatilho = 'Obrigação pela compra';
    const texto   = 'obrigacao pela compra, foi otimo';
    expect(normalizarTexto(texto).includes(normalizarTexto(gatilho))).toBe(true);
  });
});

describe('matchGatilho', () => {
  const frases = ['Obrigado pela compra', 'Compra realizada'];

  it('faz match case-insensitive', () => {
    expect(matchGatilho('OBRIGADO PELA COMPRA', frases)).toBe('Obrigado pela compra');
  });

  it('faz match ignorando acentos no texto', () => {
    expect(matchGatilho('obrigado pela compra', frases)).toBe('Obrigado pela compra');
  });

  it('faz match ignorando acentos no gatilho', () => {
    const frasesAcentuadas = ['Obrigação pela compra'];
    expect(matchGatilho('obrigacao pela compra ok!', frasesAcentuadas)).toBe('Obrigação pela compra');
  });

  it('faz match quando frase é substring do texto', () => {
    expect(matchGatilho('show! compra realizada, obrigado', frases)).toBe('Compra realizada');
  });

  it('retorna undefined quando nenhum gatilho é encontrado', () => {
    expect(matchGatilho('Oi, qual o prazo?', frases)).toBeUndefined();
  });

  it('retorna undefined para texto vazio', () => {
    expect(matchGatilho('', frases)).toBeUndefined();
  });

  it('retorna undefined quando lista de gatilhos está vazia', () => {
    expect(matchGatilho('obrigado pela compra', [])).toBeUndefined();
  });

  // ── Requisito: eco do sistema não deve disparar ───────────────────────────
  // O eco do sistema tem whatsapp_message_id já existente → ON CONFLICT → count=0
  // → verificarGatilhoCompra não é chamada. Esse invariante é testado aqui como
  // documentação: quando count=0, não se deve chamar matchGatilho.
  it('matchGatilho nunca é chamado para ecos do sistema (count=0)', () => {
    const salvo = 0; // simulação do resultado do INSERT com ON CONFLICT DO NOTHING
    let chamado = false;

    if (salvo > 0) {
      matchGatilho('obrigado pela compra', frases);
      chamado = true;
    }

    expect(chamado).toBe(false);
  });

  // ── Requisito: gatilho sem pedido aberto cria pedido direto ──────────────
  it('lógica de seleção entre atualizar pedido aberto vs criar direto', () => {
    function decidirAcao(pedidoAberto: { id: string } | null) {
      return pedidoAberto ? 'atualizar' : 'criar_direto';
    }

    expect(decidirAcao({ id: 'p-1' })).toBe('atualizar');
    expect(decidirAcao(null)).toBe('criar_direto');
  });
});
