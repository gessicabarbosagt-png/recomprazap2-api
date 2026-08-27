/**
 * Script de teste da lógica de importação CSV.
 * Executa sem banco de dados — valida parse, normalização e sanitização.
 * Rodar: npx ts-node scripts/test-csv-import.ts
 */

// ── Replicação inline das funções privadas do service ────────────────

function normalizarTelefone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (trimmed.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  }
  if (digits.length === 10 || digits.length === 11) return '+55' + digits;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return '+' + digits;
  return null;
}

function sanitizarInjection(v: string): string {
  return v.replace(/^[=+\-@]+/, '').trim();
}

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  if (/[,"\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function parseCsvBuffer(buffer: Buffer): { headers: string[]; rows: string[][] } {
  const text = buffer.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const linhas = text.split('\n').filter(l => l.trim().length > 0);
  if (linhas.length === 0) throw new Error('Arquivo CSV vazio');
  const cabecalho = linhas[0];
  const delimitador = cabecalho.split(';').length > cabecalho.split(',').length ? ';' : ',';
  const parseRow = (linha: string): string[] => {
    const campos: string[] = [];
    let atual = '';
    let aspas = false;
    for (let i = 0; i < linha.length; i++) {
      const ch = linha[i];
      if (ch === '"') {
        if (aspas && linha[i + 1] === '"') { atual += '"'; i++; }
        else aspas = !aspas;
      } else if (ch === delimitador && !aspas) {
        campos.push(atual.trim());
        atual = '';
      } else {
        atual += ch;
      }
    }
    campos.push(atual.trim());
    return campos;
  };
  return {
    headers: parseRow(linhas[0]).map(h => h.toLowerCase().replace(/['"]/g, '').trim()),
    rows: linhas.slice(1).map(parseRow),
  };
}

// ── CSV de teste ─────────────────────────────────────────────────────

// 5 clientes válidos + 1 duplicado (mesmo tel da Maria) + 1 sem tel + 1 tel inválido
// Maria está pré-existente no banco (telefonesExistentes), então entra como "atualizado"
const csvTeste = `nome,telefone,email
Maria Silva,+5511999990001,maria@exemplo.com
João Santos,(11) 98888-0002,joao@exemplo.com
Ana Costa,11977770003,ana@exemplo.com
=FormulaInject,5511966660004,hack@x.com
Cliente Existente,+5511999990001,novo@exemplo.com
Sem Telefone,,sem@telefone.com
Numero Invalido,abc123,teste@ok.com`;

// ── Executar testes ───────────────────────────────────────────────────

console.log('\n===== Teste de Normalização de Telefone =====\n');
const casos: [string, string | null][] = [
  ['+5511999990001', '+5511999990001'],
  ['(11) 98888-0002', '+5511988880002'],
  ['11977770003', '+5511977770003'],
  ['5511966660004', '+5511966660004'],
  ['', null],
  ['abc123', null],
  ['+1-800-555-0100', '+18005550100'],
];
let ok = 0, fail = 0;
for (const [input, esperado] of casos) {
  const resultado = normalizarTelefone(input);
  const passou = resultado === esperado;
  console.log(`${passou ? '✅' : '❌'} normalizarTelefone("${input}") → ${resultado} ${!passou ? `(esperado: ${esperado})` : ''}`);
  passou ? ok++ : fail++;
}

console.log('\n===== Teste de Sanitização de Injeção =====\n');
const casosSan: [string, string][] = [
  ['=cmd|cmd', 'cmd|cmd'],
  ['+FormulaHere', 'FormulaHere'],
  ['-bad', 'bad'],
  ['@sum(a1)', 'sum(a1)'],
  ['Maria Silva', 'Maria Silva'],
  ['=A1+B1', 'A1+B1'],
];
for (const [input, esperado] of casosSan) {
  const resultado = sanitizarInjection(input);
  const passou = resultado === esperado;
  console.log(`${passou ? '✅' : '❌'} sanitizarInjection("${input}") → "${resultado}" ${!passou ? `(esperado: "${esperado}")` : ''}`);
  passou ? ok++ : fail++;
}

console.log('\n===== Teste de CSV Cell (export) =====\n');
const casosCel: [unknown, string][] = [
  [null, ''],
  ['normal', 'normal'],
  ['=FORMULA', "'=FORMULA"],
  ['com,virgula', '"com,virgula"'],
  ['com"aspas', '"com""aspas"'],
  ['+5511999', "'+5511999"],
];
for (const [input, esperado] of casosCel) {
  const resultado = csvCell(input);
  const passou = resultado === esperado;
  console.log(`${passou ? '✅' : '❌'} csvCell(${JSON.stringify(input)}) → "${resultado}" ${!passou ? `(esperado: "${esperado}")` : ''}`);
  passou ? ok++ : fail++;
}

console.log('\n===== Teste de Parse do CSV de Teste =====\n');
const buf = Buffer.from(csvTeste, 'utf-8');
const { headers, rows } = parseCsvBuffer(buf);
console.log('Headers:', headers);
console.log(`Linhas de dados: ${rows.length}`);

const idxDe = (opcoes: string[]) => {
  for (const op of opcoes) { const i = headers.indexOf(op); if (i >= 0) return i; }
  return -1;
};
const nomeIdx = idxDe(['nome', 'name']);
const telIdx = idxDe(['telefone', 'phone', 'celular']);
const emailIdx = idxDe(['email', 'e-mail']);

const erros: { linha: number; motivo: string }[] = [];
const importadosSimulados: string[] = [];
const atualizadosSimulados: string[] = [];
const telefonesExistentes = new Set(['+5511999990001']); // simula duplicado

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const linhaNum = i + 2;
  const rawTel = row[telIdx]?.trim() ?? '';
  const rawNome = nomeIdx >= 0 ? (row[nomeIdx]?.trim() ?? '') : '';
  const rawEmail = emailIdx >= 0 ? (row[emailIdx]?.trim() ?? '') : '';

  if (!rawTel) { erros.push({ linha: linhaNum, motivo: 'Telefone vazio' }); continue; }
  const tel = normalizarTelefone(rawTel);
  if (!tel) { erros.push({ linha: linhaNum, motivo: `Telefone inválido: "${rawTel}"` }); continue; }

  const nome = sanitizarInjection(rawNome) || tel;

  if (telefonesExistentes.has(tel)) {
    atualizadosSimulados.push(`${nome} (${tel})`);
  } else {
    importadosSimulados.push(`${nome} (${tel})`);
    telefonesExistentes.add(tel);
  }
}

console.log(`\nImportados (${importadosSimulados.length}):`, importadosSimulados);
console.log(`Atualizados (${atualizadosSimulados.length}):`, atualizadosSimulados);
console.log(`Erros (${erros.length}):`, erros);

const resultadoEsperado = {
  // Maria pré-existente → atualizada; João, Ana, FormulaInject → importados
  importados: 3,
  // Maria (pré-existe) + Cliente Existente (mesmo tel da Maria) → ambos atualizados
  atualizados: 2,
  // Sem Telefone + Numero Invalido
  erros: 2,
};
const passou2 =
  importadosSimulados.length === resultadoEsperado.importados &&
  atualizadosSimulados.length === resultadoEsperado.atualizados &&
  erros.length === resultadoEsperado.erros;
console.log(`\n${passou2 ? '✅' : '❌'} Resultado: ${importadosSimulados.length} importados, ${atualizadosSimulados.length} atualizados, ${erros.length} erros`);
if (!passou2) {
  console.log(`   Esperado: ${resultadoEsperado.importados} importados, ${resultadoEsperado.atualizados} atualizados, ${resultadoEsperado.erros} erros`);
  fail++;
} else ok++;

console.log(`\n===== Total: ${ok} ✅  ${fail} ❌ =====\n`);
if (fail > 0) process.exit(1);
