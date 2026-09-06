#!/usr/bin/env node
'use strict';

// Executa migration_010_horario_envio_ciclos.sql
// Uso: DATABASE_URL=postgres://... node scripts/run-migration-010.js

const postgres = require('postgres');
const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch (_) {}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida. Exemplo: DATABASE_URL=postgres://... node scripts/run-migration-010.js');
  process.exit(1);
}

const sql = postgres(url, { ssl: { rejectUnauthorized: false } });
const sqlFile = fs.readFileSync(
  path.join(__dirname, '../database/migration_010_horario_envio_ciclos.sql'),
  'utf8',
);

(async () => {
  try {
    console.log('Aplicando migration 010 (horario_envio em ciclos_recompra)...');
    await sql.unsafe(sqlFile);
    console.log('✓ Migration 010 aplicada com sucesso.');
  } catch (err) {
    console.error('Erro na migration:', err.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
})();
