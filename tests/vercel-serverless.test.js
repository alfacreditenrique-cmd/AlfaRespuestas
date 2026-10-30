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

test('Vercel Serverless: Ejecución HTTP real de endpoints en modo Serverless con Fallback Database', async () => {
  const http = require('http');
  const apiHandler = require('../api/index');
  assert.equal(typeof apiHandler.default, 'function', 'api/index debe proveer compatibilidad ESM (.default)');

  const testServer = http.createServer(apiHandler);
  await new Promise(resolve => testServer.listen(0, resolve));
  const port = testServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /
    const resHome = await fetch(`${baseUrl}/`);
    assert.equal(resHome.status, 200);
    assert.ok(resHome.headers.get('content-type')?.includes('text/html'));

    // 2. GET /agendar
    const resAgendar = await fetch(`${baseUrl}/agendar`);
    assert.equal(resAgendar.status, 200);
    const htmlAgendar = await resAgendar.text();
    assert.ok(htmlAgendar.includes('Agendar Entrevista'));

    // 3. GET /api/status
    const resStatus = await fetch(`${baseUrl}/api/status`);
    assert.equal(resStatus.status, 200);
    const jsonStatus = await resStatus.json();
    assert.equal(jsonStatus.success, true);
    assert.ok(jsonStatus.config?.dates?.length >= 2);

    // 4. GET /api/slots?date=2025-11-04
    const resSlots = await fetch(`${baseUrl}/api/slots?date=2025-11-04`);
    assert.equal(resSlots.status, 200);
    const jsonSlots = await resSlots.json();
    assert.equal(jsonSlots.success, true);
    assert.ok(Array.isArray(jsonSlots.available));

    // 5. GET /app.js
    const resStatic = await fetch(`${baseUrl}/app.js`);
    assert.equal(resStatic.status, 200);
    assert.ok(resStatic.headers.get('content-type')?.includes('javascript'));
  } finally {
    await new Promise(resolve => testServer.close(resolve));
  }
});

