// Testa detectarIntencaoAdiamento sem instanciar WhatsappBaileysService
// (que depende do ESM do Baileys). Réplica local das funções puras.

function normalizarTexto(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function detectarIntencaoAdiamento(
  texto: string,
): { dias: number; precisaRevisao: boolean } | null {
  const norm = normalizarTexto(texto);

  const numMatch = norm.match(/(\d+)\s+dias?/);
  if (numMatch) return { dias: parseInt(numMatch[1], 10), precisaRevisao: false };

  if (/amanha/.test(norm)) return { dias: 1, precisaRevisao: false };
  if (/semana\s+que\s+vem|proxima\s+semana/.test(norm)) return { dias: 7, precisaRevisao: false };
  if (/mes\s+que\s+vem|proximo\s+mes/.test(norm)) return { dias: 30, precisaRevisao: false };

  if (/agora\s+nao|nao\s+agora|mais\s+tarde/.test(norm)) {
    return { dias: 7, precisaRevisao: true };
  }

  return null;
}

// Template de lembrete real (MENSAGEM_LEMBRETE_PADRAO interpolado)
const TEXTO_LEMBRETE_INTERPOLADO =
  'Oi, André! 👋\n\nJá está na hora de repor *2 unidades de Caldo de Peixe*. Posso te ajudar?\n\nResponda:\n1️⃣ *1* — Quero pedir\n2️⃣ *2* — Me avise depois\n3️⃣ *3* — Não quero mais';

describe('detectarIntencaoAdiamento', () => {
  // ── Falsos positivos que devem retornar null ──────────────────────────────

  it('NÃO dispara para "vou decidir depois, obrigada" (caso real Pistolão)', () => {
    expect(detectarIntencaoAdiamento('vou decidir depois, obrigada')).toBeNull();
  });

  it('NÃO dispara para mensagem contendo só "depois" em contexto de conversa', () => {
    expect(detectarIntencaoAdiamento('depois eu confirmo')).toBeNull();
    expect(detectarIntencaoAdiamento('fala comigo depois')).toBeNull();
    expect(detectarIntencaoAdiamento('Oi, te ligo depois!')).toBeNull();
  });

  it('NÃO dispara para o próprio template de lembrete (bug original)', () => {
    expect(detectarIntencaoAdiamento(TEXTO_LEMBRETE_INTERPOLADO)).toBeNull();
  });

  it('NÃO dispara para mensagem vazia', () => {
    expect(detectarIntencaoAdiamento('')).toBeNull();
  });

  it('NÃO dispara para mensagem genérica sem intenção de adiamento', () => {
    expect(detectarIntencaoAdiamento('Oi, tudo bem?')).toBeNull();
    expect(detectarIntencaoAdiamento('Quero pedir')).toBeNull();
    expect(detectarIntencaoAdiamento('Obrigada!')).toBeNull();
  });

  // ── "amanhã" e períodos nomeados não contêm "depois" — continuam funcionando ─

  it('detecta "amanhã" → 1 dia', () => {
    expect(detectarIntencaoAdiamento('pode ser amanhã')).toEqual({ dias: 1, precisaRevisao: false });
    expect(detectarIntencaoAdiamento('amanhã de manhã')).toEqual({ dias: 1, precisaRevisao: false });
  });

  it('detecta "semana que vem" → 7 dias', () => {
    expect(detectarIntencaoAdiamento('me liga semana que vem')).toEqual({ dias: 7, precisaRevisao: false });
    expect(detectarIntencaoAdiamento('próxima semana tá bom')).toEqual({ dias: 7, precisaRevisao: false });
  });

  it('detecta "mês que vem" → 30 dias', () => {
    expect(detectarIntencaoAdiamento('mês que vem compro')).toEqual({ dias: 30, precisaRevisao: false });
    expect(detectarIntencaoAdiamento('próximo mês confirmo')).toEqual({ dias: 30, precisaRevisao: false });
  });

  // ── Numérico ─────────────────────────────────────────────────────────────

  it('detecta "X dias" com número explícito → dias exatos', () => {
    expect(detectarIntencaoAdiamento('me avisa em 10 dias')).toEqual({ dias: 10, precisaRevisao: false });
    expect(detectarIntencaoAdiamento('em 30 dias')).toEqual({ dias: 30, precisaRevisao: false });
    expect(detectarIntencaoAdiamento('daqui a 7 dias')).toEqual({ dias: 7, precisaRevisao: false });
  });

  it('NÃO confunde data "16/09" com quantidade de dias', () => {
    // "16/09" não tem espaço antes de "dia" — não deve bater
    expect(detectarIntencaoAdiamento('entrega em 16/09/2026')).toBeNull();
  });

  // ── Padrões vagos remanescentes ───────────────────────────────────────────

  it('detecta "agora não" → 7 dias com revisão', () => {
    expect(detectarIntencaoAdiamento('agora não posso')).toEqual({ dias: 7, precisaRevisao: true });
    expect(detectarIntencaoAdiamento('não agora')).toEqual({ dias: 7, precisaRevisao: true });
  });

  it('detecta "mais tarde" → 7 dias com revisão', () => {
    expect(detectarIntencaoAdiamento('mais tarde')).toEqual({ dias: 7, precisaRevisao: true });
    expect(detectarIntencaoAdiamento('pode ser mais tarde')).toEqual({ dias: 7, precisaRevisao: true });
  });

  // ── Normalização (acentos / case) ─────────────────────────────────────────

  it('ignora maiúsculas e acentos', () => {
    expect(detectarIntencaoAdiamento('AMANHÃ')).toEqual({ dias: 1, precisaRevisao: false });
    expect(detectarIntencaoAdiamento('Mais Tarde')).toEqual({ dias: 7, precisaRevisao: true });
    expect(detectarIntencaoAdiamento('EM 5 DIAS')).toEqual({ dias: 5, precisaRevisao: false });
  });
});
