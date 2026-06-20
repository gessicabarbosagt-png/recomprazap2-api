#!/usr/bin/env node
'use strict';

/**
 * Cria a primeira loja + usuário admin (perfil 'dono') no banco de produção.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node scripts/seed-admin.js
 *
 * O script é interativo: pede os dados no terminal e oculta a senha.
 * Roda dentro de uma única transação — se qualquer passo falhar, nada é salvo.
 */

const postgres = require('postgres');
const bcrypt   = require('bcrypt');
const readline = require('readline');

// Tenta carregar .env se dotenv estiver instalado (não é dependência obrigatória)
try { require('dotenv').config(); } catch (_) {}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('\nErro: variável DATABASE_URL não definida.\n');
  process.exit(1);
}

// Leitura de linha simples via readline
function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// Leitura de senha sem eco no terminal
function askPassword(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;

    if (!stdin.isTTY) {
      // Ambiente sem TTY (CI, pipe): lê normalmente sem esconder
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
      return;
    }

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    function onData(char) {
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (char === '') {
        // Ctrl+C
        process.stdout.write('\n');
        process.exit(0);
      } else if (char === '' || char === '\b') {
        // Backspace
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    }
    stdin.on('data', onData);
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  console.log('\n=== RecompraZap — Seed do Primeiro Admin ===\n');
  console.log('Preencha os dados abaixo. A senha não será exibida.\n');

  const lojaNome   = (await ask(rl, 'Nome da loja:              ')).trim();
  const lojaSlug   = (await ask(rl, 'Slug da loja (ex: minha-loja): ')).trim();
  const lojaEmail  = (await ask(rl, 'Email da loja:             ')).trim();

  console.log('');

  const adminNome  = (await ask(rl, 'Nome do admin:   ')).trim();
  const adminEmail = (await ask(rl, 'Email do admin:  ')).trim();

  rl.close();

  const adminSenha = await askPassword('Senha do admin:  ');

  if (!lojaNome || !lojaSlug || !lojaEmail || !adminNome || !adminEmail || !adminSenha) {
    console.error('\nErro: todos os campos são obrigatórios.\n');
    process.exit(1);
  }

  console.log('\nHasheando senha...');
  const senhaHash = await bcrypt.hash(adminSenha, 12);

  console.log('Conectando ao banco...');
  const sql = postgres(DATABASE_URL, { max: 1 });

  try {
    const { loja, usuario } = await sql.begin(async (tx) => {
      const [loja] = await tx`
        INSERT INTO lojas (nome, email, slug)
        VALUES (${lojaNome}, ${lojaEmail}, ${lojaSlug})
        RETURNING id, nome, slug
      `;

      // RLS: a policy de usuarios exige app.loja_id setado na sessão
      await tx`SELECT set_config('app.loja_id', ${loja.id}, true)`;

      const [usuario] = await tx`
        INSERT INTO usuarios (loja_id, nome, email, senha_hash, perfil)
        VALUES (${loja.id}, ${adminNome}, ${adminEmail}, ${senhaHash}, 'dono')
        RETURNING id, nome, email, perfil
      `;

      return { loja, usuario };
    });

    console.log('\n--- Criado com sucesso ---');
    console.log(`\nLoja`);
    console.log(`  ID:   ${loja.id}`);
    console.log(`  Nome: ${loja.nome}`);
    console.log(`  Slug: ${loja.slug}`);
    console.log(`\nAdmin`);
    console.log(`  ID:     ${usuario.id}`);
    console.log(`  Nome:   ${usuario.nome}`);
    console.log(`  Email:  ${usuario.email}`);
    console.log(`  Perfil: ${usuario.perfil}`);
    console.log('\nUse o email e a senha definidos acima para fazer login.\n');
  } catch (err) {
    if (err.code === '23505') {
      // Unique violation
      const detail = err.detail || err.message;
      console.error(`\nErro: registro duplicado — ${detail}\n`);
    } else {
      console.error('\nErro ao inserir no banco:', err.message, '\n');
    }
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
