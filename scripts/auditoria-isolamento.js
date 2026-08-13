// Auditoria read-only — isolamento multi-tenant
// Executa: railway run node scripts/auditoria-isolamento.js
const postgres = require('postgres');

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { max: 3, transform: postgres.camel });

  console.log('\n======= AUDITORIA DE ISOLAMENTO MULTI-TENANT =======\n');

  // 1. Lojas cadastradas
  const lojas = await sql`
    SELECT id, nome, created_at, ativa
    FROM lojas
    ORDER BY created_at ASC
  `;
  console.log('--- 1. LOJAS (ordem de criação) ---');
  lojas.forEach((l, i) => {
    const tag = i === 0 ? ' ← LOJA PRINCIPAL (fallback antigo LIMIT 1)' : '';
    console.log(`  [${i + 1}] ${l.nome} | id=${l.id} | ativa=${l.ativa} | criada=${l.createdAt?.toISOString().slice(0, 10)}${tag}`);
  });

  if (lojas.length <= 1) {
    console.log('\n  Apenas 1 loja — nenhum risco de contaminação cross-loja. Auditoria encerrada.\n');
    await sql.end();
    return;
  }

  const lojaPrincipalId = lojas[0].id;
  const lojaPrincipalNome = lojas[0].nome;
  const outrasLojas = lojas.slice(1);

  // 2. Contagem de clientes por loja
  console.log('\n--- 2. CLIENTES POR LOJA ---');
  const clientesPorLoja = await sql`
    SELECT l.nome AS loja_nome, COUNT(c.id)::int AS total
    FROM lojas l
    LEFT JOIN clientes c ON c.loja_id = l.id AND c.deleted_at IS NULL
    GROUP BY l.id, l.nome
    ORDER BY l.created_at ASC
  `;
  clientesPorLoja.forEach(r => {
    console.log(`  ${r.lojaNome}: ${r.total} clientes`);
  });

  // 3. Clientes com mesmo telefone em múltiplas lojas (possível duplicata cross-tenant)
  console.log('\n--- 3. TELEFONES EM MAIS DE UMA LOJA ---');
  const duplos = await sql`
    SELECT c.telefone, COUNT(DISTINCT c.loja_id)::int AS num_lojas,
           STRING_AGG(l.nome, ', ' ORDER BY l.created_at) AS lojas_nomes,
           MIN(c.created_at) AS primeiro_registro
    FROM clientes c
    JOIN lojas l ON l.id = c.loja_id
    WHERE c.deleted_at IS NULL
    GROUP BY c.telefone
    HAVING COUNT(DISTINCT c.loja_id) > 1
    ORDER BY primeiro_registro ASC
  `;
  if (duplos.length === 0) {
    console.log('  Nenhum telefone duplicado entre lojas. ✓');
  } else {
    console.log(`  ATENÇÃO: ${duplos.length} telefone(s) cadastrado(s) em mais de uma loja:`);
    duplos.forEach(d => {
      console.log(`    ${d.telefone} → ${d.numLojas} lojas: [${d.lojasNomes}] | primeiro: ${d.primeiroRegistro?.toISOString()}`);
    });
  }

  // 4. Mensagens cujo loja_id não bate com loja_id do cliente
  console.log('\n--- 4. MENSAGENS COM LOJA_ID INCONSISTENTE ---');
  const msgInconsistentes = await sql`
    SELECT
      m.id AS msg_id,
      m.loja_id AS msg_loja_id,
      lm.nome AS msg_loja_nome,
      c.loja_id AS cliente_loja_id,
      lc.nome AS cliente_loja_nome,
      c.telefone,
      m.created_at
    FROM mensagens_whatsapp m
    JOIN clientes c ON c.id = m.cliente_id
    JOIN lojas lm ON lm.id = m.loja_id
    JOIN lojas lc ON lc.id = c.loja_id
    WHERE m.loja_id != c.loja_id
    ORDER BY m.created_at ASC
    LIMIT 50
  `;
  if (msgInconsistentes.length === 0) {
    console.log('  Nenhuma mensagem com loja_id divergente do cliente. ✓');
  } else {
    console.log(`  ATENÇÃO: ${msgInconsistentes.length} mensagem(ns) com loja errada (limite 50):`);
    msgInconsistentes.forEach(m => {
      console.log(`    msg=${m.msgId} | tel=${m.telefone} | msg.loja=[${m.msgLojaNome}] | cliente.loja=[${m.clienteLojaNome}] | data=${m.createdAt?.toISOString().slice(0, 16)}`);
    });
  }

  // 5. Pedidos cujo loja_id não bate com loja_id do cliente
  console.log('\n--- 5. PEDIDOS COM LOJA_ID INCONSISTENTE ---');
  const pedInconsistentes = await sql`
    SELECT
      p.id AS pedido_id,
      p.loja_id AS pedido_loja_id,
      lp.nome AS pedido_loja_nome,
      c.loja_id AS cliente_loja_id,
      lc.nome AS cliente_loja_nome,
      c.telefone,
      p.created_at
    FROM pedidos p
    JOIN clientes c ON c.id = p.cliente_id
    JOIN lojas lp ON lp.id = p.loja_id
    JOIN lojas lc ON lc.id = c.loja_id
    WHERE p.loja_id != c.loja_id
      AND p.deleted_at IS NULL
    ORDER BY p.created_at ASC
    LIMIT 50
  `;
  if (pedInconsistentes.length === 0) {
    console.log('  Nenhum pedido com loja_id divergente do cliente. ✓');
  } else {
    console.log(`  ATENÇÃO: ${pedInconsistentes.length} pedido(s) com loja errada (limite 50):`);
    pedInconsistentes.forEach(p => {
      console.log(`    pedido=${p.pedidoId} | tel=${p.telefone} | pedido.loja=[${p.pedidoLojaNome}] | cliente.loja=[${p.clienteLojaNome}] | data=${p.createdAt?.toISOString().slice(0, 16)}`);
    });
  }

  // 6. Clientes na loja principal sem origem detectada (candidatos a terem sido mal-atribuídos)
  console.log('\n--- 6. CLIENTES NA LOJA PRINCIPAL SEM ORIGEM (possível atribuição errada) ---');
  const semOrigem = await sql`
    SELECT c.telefone, c.nome, c.origem_lead, c.created_at
    FROM clientes c
    WHERE c.loja_id = ${lojaPrincipalId}
      AND c.origem_lead IS NULL
      AND c.deleted_at IS NULL
    ORDER BY c.created_at ASC
    LIMIT 30
  `;
  console.log(`  Loja principal: ${lojaPrincipalNome} (${lojaPrincipalId})`);
  if (semOrigem.length === 0) {
    console.log('  Nenhum cliente sem origem na loja principal. ✓');
  } else {
    console.log(`  ${semOrigem.length} cliente(s) sem origem (limite 30):`);
    semOrigem.forEach(c => {
      console.log(`    ${c.telefone} | ${c.nome} | criado=${c.createdAt?.toISOString().slice(0, 16)}`);
    });
    console.log('\n  NOTA: Estes clientes chegaram sem #codigo e foram atribuídos à loja principal pelo fallback.');
    console.log('        Só são problema se deveriam ter ido para outra loja.');
  }

  // 7. Clientes em outras lojas criados antes da data do fix (08/ago/2026 ~14h)
  console.log('\n--- 7. CLIENTES NAS OUTRAS LOJAS (período de risco) ---');
  const dataFix = new Date('2026-08-08T17:15:00Z'); // commit 03a153e UTC
  for (const loja of outrasLojas) {
    const clientes = await sql`
      SELECT telefone, nome, origem_lead, created_at
      FROM clientes
      WHERE loja_id = ${loja.id}
        AND deleted_at IS NULL
        AND created_at < ${dataFix}
      ORDER BY created_at ASC
      LIMIT 20
    `;
    console.log(`\n  Loja: ${loja.nome} | clientes criados ANTES do fix:`);
    if (clientes.length === 0) {
      console.log('    Nenhum. ✓');
    } else {
      clientes.forEach(c => {
        console.log(`    ${c.telefone} | ${c.nome} | origem=${c.origemLead ?? 'null'} | ${c.createdAt?.toISOString().slice(0, 16)}`);
      });
    }
  }

  console.log('\n======= FIM DA AUDITORIA =======\n');
  await sql.end();
}

main().catch(e => {
  console.error('ERRO na auditoria:', e.message);
  process.exit(1);
});
