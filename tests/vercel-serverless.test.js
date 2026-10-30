const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Vercel Serverless: api/index.js exporta una aplicación Express ejecutable', () => {
  const apiHandler = require('../api/index');
  assert.equal(typeof apiHandler, 'function', 'api/index debe ser una función Express');
  assert.equal(typeof apiHandler.listen, 'function', 'api/index debe tener método listen de Express');
});

test('Vercel Serverless: Base de datos FallbackDatabaseSync emula completamente la interfaz SQLite sin node:sqlite', () => {
  const { FallbackDatabaseSync } = require('../src/database-fallback');
  const fallback = new FallbackDatabaseSync('/tmp/test_fallback.sqlite');

  // 1. Probar exec
  fallback.exec('PRAGMA foreign_keys = ON; CREATE TABLE test (id INT);');

  // 2. Probar interview_dates
  const dates = fallback.prepare('SELECT * FROM interview_dates ORDER BY id ASC').all();
  assert.ok(Array.isArray(dates) && dates.length >= 2, 'Debe devolver las fechas por defecto');

  // 3. Probar phone_mappings
  const phone = fallback.prepare('SELECT phone_number FROM phone_mappings WHERE lid = ? OR lid = ? LIMIT 1').get('272632142377156', '272632142377156');
  assert.equal(phone?.phone_number, '50588776655');

  // 4. Probar appointments
  const allApts = fallback.prepare('SELECT * FROM appointments WHERE 1=1 ORDER BY date ASC, time_slot ASC, id ASC').all();
  assert.ok(Array.isArray(allApts) && allApts.length >= 41, 'Fallback debe sembrar automáticamente las 41 citas de recuperación');

  // 5. Probar estadísticas
  const stats = fallback.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'confirmada' THEN 1 ELSE 0 END) as confirmed FROM appointments").get();
  assert.ok(stats.total >= 41);
  assert.ok(stats.confirmed >= 41);
});

test('Vercel Config: vercel.json tiene runtime nodejs22.x y includeFiles como array válido', () => {
  const vercelPath = path.join(__dirname, '..', 'vercel.json');
  const vercelConfig = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));

  assert.ok(vercelConfig.functions && vercelConfig.functions['api/index.js'], 'Debe configurar api/index.js');
  assert.equal(vercelConfig.functions['api/index.js'].runtime, 'nodejs22.x', 'Debe especificar runtime nodejs22.x');
  assert.ok(Array.isArray(vercelConfig.functions['api/index.js'].includeFiles), 'includeFiles debe ser un array para no romper patrones glob');
  assert.ok(vercelConfig.functions['api/index.js'].includeFiles.includes('src/**'));
  assert.ok(vercelConfig.functions['api/index.js'].includeFiles.includes('data/alfa_citas.sqlite'));
});

test('Vercel Config: package.json define engines.node como 22.x compatible con Vercel', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.engines?.node, '22.x', 'engines.node debe ser 22.x para selección nativa en Vercel');
});
