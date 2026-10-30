const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = require('../src/database-fallback').FallbackDatabaseSync;
}

const database = require('../src/database');
const CONFIG = require('../src/config');
const { app } = require('../src/server');

test('Candidatos: Base de datos alfa_citas.sqlite contiene exactamente 41 candidatos confirmados', () => {
  const apts = database.listAppointments();
  const confirmed = apts.filter(a => a.status === 'confirmada');
  const cancelled = apts.filter(a => a.status === 'cancelada');

  assert.ok(confirmed.length >= 41, `Deben existir al menos 41 candidatos confirmados (actual: ${confirmed.length})`);
  assert.equal(cancelled.length, 2, 'Deben preservarse 2 citas canceladas para auditoría');
  assert.ok(apts.length >= 43, `Total de citas en sistema debe ser al menos 43 (actual: ${apts.length})`);

  // Verificar que ninguno tiene @lid como teléfono expuesto
  for (const c of confirmed) {
    const resolved = database.resolvePhoneNumber(c.phone_number, c.jid);
    assert.ok(resolved && !resolved.includes('@lid'), `Candidato ${c.candidate_name} debe tener teléfono numérico válido sin @lid`);
    assert.ok(c.candidate_name && c.candidate_name.trim().length > 0, 'Nombre del candidato no debe estar vacío');
    assert.ok(CONFIG.DATES.some(d => d.id === c.date), `Fecha ${c.date} debe ser válida`);
    assert.ok(CONFIG.TIME_SLOTS.includes(c.time_slot), `Turno ${c.time_slot} debe ser válido`);
  }
});

test('Candidatos: Pedro Alvarado está registrado con LID resuelto a teléfono 50588776655', () => {
  const pedro = database.listAppointments().find(a => a.candidate_name === 'Pedro Alvarado');
  assert.ok(pedro, 'Pedro Alvarado debe existir en las citas');
  assert.equal(pedro.jid, '272632142377156@lid');
  const resolved = database.resolvePhoneNumber(pedro.phone_number, pedro.jid);
  assert.equal(resolved, '50588776655', 'El teléfono resuelto debe ser 50588776655');
  assert.equal(pedro.position, 'Promotor de Crédito');
  assert.equal(pedro.date, '2025-11-04');
  assert.equal(pedro.time_slot, '15:00');
});

test('Despliegue Vercel: api/index.js y vercel.json configurados correctamente para ejecución serverless', () => {
  // 1. api/index.js existe y exporta Express app
  const serverlessEntry = require('../api/index');
  assert.equal(typeof serverlessEntry, 'function', 'api/index.js debe exportar una función Express');

  // 2. vercel.json existe y tiene rewrite a /api/index.js
  const vercelPath = path.join(__dirname, '..', 'vercel.json');
  assert.ok(fs.existsSync(vercelPath), 'vercel.json debe existir en la raíz');
  const vercelJson = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
  assert.ok(Array.isArray(vercelJson.rewrites), 'vercel.json debe definir rewrites');
  const mainRewrite = vercelJson.rewrites.find(r => r.source === '/(.*)');
  assert.ok(mainRewrite, 'Debe existir un rewrite para /(.*)');
  assert.ok(mainRewrite.destination === '/api' || mainRewrite.destination === '/api/index.js', 'El rewrite debe apuntar a /api o /api/index.js');

  // 3. package.json tiene engines >= 22.5.0 para node:sqlite
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.engines && pkg.engines.node, 'package.json debe especificar engines.node');
});

test('Respaldo y Auto-Seed: Nueva base SQLite en frío restaura automáticamente los 41 candidatos', () => {
  const tmpDbPath = path.join(__dirname, '..', 'data', 'temp_verify_seed.sqlite');
  try {
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);

    const tmpDb = new DatabaseSync(tmpDbPath);
    tmpDb.exec(`
      CREATE TABLE appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_name TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        jid TEXT,
        position TEXT NOT NULL,
        date TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmada',
        notes TEXT DEFAULT '',
        notified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_states (
        phone_number TEXT PRIMARY KEY,
        step TEXT NOT NULL DEFAULT 'IDLE',
        selected_position TEXT,
        selected_date TEXT,
        selected_time TEXT,
        candidate_name TEXT,
        jid TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    // Sincronizar desde seed-recovery.json
    database.syncFromSeedRecovery(tmpDb);

    const rows = tmpDb.prepare('SELECT * FROM appointments').all();
    const confirmedRows = rows.filter(r => r.status === 'confirmada');

    assert.ok(confirmedRows.length >= 41, `Base recién sembrada debe tener al menos 41 confirmados (actual: ${confirmedRows.length})`);
    assert.ok(rows.length >= 43, `Base recién sembrada debe tener al menos 43 citas en total (actual: ${rows.length})`);

    tmpDb.close();
  } finally {
    try { if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath); } catch {}
  }
});
