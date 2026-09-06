#!/usr/bin/env node
'use strict';

// Executa migration_011_ciclo_produtos.sql
// Cria a tabela ciclo_produtos e migra os produto_id existentes.
// Uso: DATABASE_URL=postgres://... node scripts/run-migration-011.js

const postgres = require('postgres');
const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch (_) {}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida. Exemplo: DATABASE_URL=postgres://... node scripts/run-migration-011.js');
  process.exit(1);
}

const sql = postgres(url, { ssl: { rejectUnauthorized: false } });
const sqlFile = fs.readFileSync(
  path.join(__dirname, '../database/migration_011_ciclo_produtos.sql'),
  'utf8',
);

(async () => {
  try {
    console.log('Aplicando migration 011 (tabela ciclo_produtos + migração de dados)...');
    await sql.unsafe(sqlFile);
    console.log('✓ Migration 011 aplicada com sucesso.');
  } catch (err) {
    console.error('Erro na migration:', err.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
})();
