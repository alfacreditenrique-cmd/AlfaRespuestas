const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CONFIG = require('../src/config');
const database = require('../src/database');
const { app } = require('../src/server');
const {
  confirmationProtocol,
  CONFIRMATION_VARIANTS,
  formatConfirmationMessage
} = require('../src/confirmation-protocol');

test('Protocolo Confirmación: Existen exactamente 4 variantes naturales y humanizadas', () => {
  assert.equal(CONFIRMATION_VARIANTS.length, 4, 'Deben existir 4 variantes de mensajes');
  const codes = new Set(CONFIRMATION_VARIANTS.map(v => v.code));
  assert.equal(codes.size, 4, 'Los códigos de variante deben ser únicos');

  // Cada variante debe contener las variables clave y no sonar robótica
  const mockApt = {
    candidate_name: 'Enrique Castillo',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '08:30'
  };

  for (let i = 1; i <= 4; i++) {
    const text = formatConfirmationMessage(i, mockApt);
    assert.ok(text.includes('Enrique'), `Variante ${i} debe personalizar con el nombre`);
    assert.ok(text.includes('Oficial de Crédito'), `Variante ${i} debe incluir la plaza`);
    assert.ok(text.includes('08:30 AM'), `Variante ${i} debe incluir la hora en 12h`);
    assert.ok(text.includes('Sébaco'), `Variante ${i} debe incluir la sede`);
    assert.ok(text.toLowerCase().includes('confirm'), `Variante ${i} debe solicitar confirmación`);
  }
});

test('Protocolo Confirmación: Personalización inteligente con nombres genéricos', () => {
  const genericApt = {
    candidate_name: 'Postulante Confirmado (ID 106674740297844)',
    position: 'Promotor de Crédito',
    date: '2025-11-04',
    time_slot: '08:45'
  };

  const text = formatConfirmationMessage(1, genericApt);
  assert.ok(!text.includes('Postulante Confirmado (ID 106674740297844)'), 'No debe usar el ID crudo como nombre personal');
  assert.ok(text.includes('postulante'), 'Debe usar un tratamiento natural como "postulante"');
});

test('Protocolo Confirmación: Idempotencia estricta (1 solo mensaje por persona)', async () => {
  const candidates = database.listCandidatesForConfirmation();
  assert.ok(candidates.length >= 40, `Deben existir candidatos activos (actual: ${candidates.length})`);
  const target = candidates[0];

  // 1. Envío exitoso (dryRun)
  const res1 = await confirmationProtocol.sendSingle(target.id, { variantId: 1, dryRun: true, force: true });
  assert.equal(res1.success, true);
  assert.equal(res1.variantId, 1);

  // Verificar estado actualizado en base de datos
  const updatedApt = database.getAppointmentById(target.id);
  assert.equal(updatedApt.confirmation_status, 'sent');
  assert.ok(updatedApt.confirmation_sent_at, 'Debe registrar timestamp confirmation_sent_at');
  assert.equal(updatedApt.confirmation_variant, 1);

  // 2. Segundo intento sin force debe ser omitido por idempotencia
  const res2 = await confirmationProtocol.sendSingle(target.id, { variantId: 2, dryRun: true, force: false });
  assert.equal(res2.success, false);
  assert.equal(res2.skipped, true);
  assert.ok(res2.reason.includes('ya fue enviado previamente'));
});

test('Protocolo Confirmación: getCandidates retorna candidatos enriquecidos con previsualización', () => {
  const list = confirmationProtocol.getCandidates('all');
  assert.ok(Array.isArray(list) && list.length >= 40);

  const sample = list[0];
  assert.ok(sample.id);
  assert.ok(sample.candidate_name);
  assert.ok(sample.phone_number);
  assert.ok(sample.dateLabel);
  assert.ok(sample.time12h);
  assert.ok(sample.message_preview);
  assert.ok(sample.message_preview.length > 50);
});

test('Protocolo Confirmación: Estadísticas del protocolo reflejan totales correctos', () => {
  const stats = database.getConfirmationStats();
  assert.ok(typeof stats.total === 'number' && stats.total >= 40);
  assert.ok(typeof stats.sent === 'number');
  assert.ok(typeof stats.pending === 'number');
  assert.equal(stats.total, stats.sent + stats.pending + stats.failed);
});

test('Protocolo Confirmación: Ejecución asíncrona por lotes con rotación de variantes y pausas', async () => {
  // Iniciar con pausas ultra-cortas en entorno de prueba
  const startRes = await confirmationProtocol.startProtocol({
    delayMinMs: 10,
    delayMaxMs: 30,
    dryRun: true,
    variantRotation: 'sequential'
  });

  assert.equal(startRes.success, true);
  assert.ok(startRes.runId);

  // Esperar a que el protocolo avance y finalice
  let checks = 0;
  while (confirmationProtocol.isRunning && checks < 50) {
    await new Promise(r => setTimeout(r, 100));
    checks++;
  }

  const finalStatus = confirmationProtocol.getStatus();
  assert.equal(finalStatus.isRunning, false, 'El protocolo debe finalizar correctamente');
  assert.ok(finalStatus.stats.sent >= 1, 'Debe haber enviado al menos una confirmación');
});

test('API Endpoints Protocolo Confirmación: HTTP GET /api/confirmation-protocol/candidates y /status', async () => {
  const testServer = http.createServer(app);
  await new Promise(resolve => testServer.listen(0, resolve));
  const port = testServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET status
    const resStatus = await fetch(`${baseUrl}/api/confirmation-protocol/status`);
    assert.equal(resStatus.status, 200);
    const jsonStatus = await resStatus.json();
    assert.equal(jsonStatus.success, true);
    assert.equal(jsonStatus.variantsCount, 4);
    assert.ok(jsonStatus.stats.total >= 40);

    // 2. GET candidates
    const resCand = await fetch(`${baseUrl}/api/confirmation-protocol/candidates?filter=all`);
    assert.equal(resCand.status, 200);
    const jsonCand = await resCand.json();
    assert.equal(jsonCand.success, true);
    assert.ok(jsonCand.candidates.length >= 40);

    // 3. POST send-single
    const firstCand = jsonCand.candidates[0];
    const resSend = await fetch(`${baseUrl}/api/confirmation-protocol/send-single`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointment_id: firstCand.id, variant_id: 3, dryRun: true, force: true })
    });
    assert.equal(resSend.status, 200);
    const jsonSend = await resSend.json();
    assert.equal(jsonSend.success, true);
  } finally {
    await new Promise(resolve => testServer.close(resolve));
  }
});

test('UI Frontend: Archivos JavaScript del panel tienen sintaxis válida sin errores de compilación', () => {
  const { execSync } = require('child_process');
  const files = [
    path.join(__dirname, '..', 'public', 'app.js'),
    path.join(__dirname, '..', 'src', 'public', 'app.js')
  ];

  for (const f of files) {
    assert.doesNotThrow(() => {
      execSync(`node -c "${f}"`, { stdio: 'pipe' });
    }, `El archivo ${f} debe compilar sin errores de sintaxis en Node.js`);
  }
});

test('Protocolo Confirmación: startProtocol rechaza inicio en modo real si WhatsApp no está conectado', async () => {
  // Asegurarse de que en modo real sin conexión no inicie un bucle destructivo
  const res = await confirmationProtocol.startProtocol({ dryRun: false });
  assert.equal(res.success, false);
  assert.ok(res.message.includes('WhatsApp no está conectado'));
});

test('Protocolo Confirmación: Filtro failed y unconfirmed retornan candidatos correctos', () => {
  const candidates = database.listCandidatesForConfirmation();
  const testCandidate = candidates[0];

  // Marcar como failed
  database.markConfirmationFailed(testCandidate.id, 'Simulated network timeout');

  const failedList = confirmationProtocol.getCandidates('failed');
  assert.ok(failedList.some(c => c.id === testCandidate.id), 'Candidato fallido debe aparecer en filtro failed');

  const unconfirmedList = confirmationProtocol.getCandidates('unconfirmed');
  assert.ok(unconfirmedList.some(c => c.id === testCandidate.id), 'Candidato fallido debe ser reintentable en unconfirmed');

  // Restaurar candidato
  database.db.exec(`UPDATE appointments SET confirmation_status = 'pending', confirmation_error = NULL WHERE id = ${testCandidate.id}`);
});

test('UI Frontend: Botón y modal del Protocolo de Confirmación presentes en public/index.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="btnOpenConfirmationModal"'), 'Debe existir el botón btnOpenConfirmationModal');
  assert.ok(html.includes('Protocolo Confirmación'), 'Debe contener el texto Protocolo Confirmación');
  assert.ok(html.includes('id="confirmationModal"'), 'Debe existir el modal confirmationModal');
  assert.ok(html.includes('id="btnStartConfProtocol"'), 'Debe existir el botón para iniciar protocolo');
  assert.ok(html.includes('id="confConsoleLog"'), 'Debe existir la consola de eventos en tiempo real');
  assert.ok(html.includes('value="failed"'), 'Debe existir la opción para filtrar candidatos con error');
});

test('Despliegue Centralizado en Render: Configuración correcta y eliminación de Vercel', () => {
  // 1. package.json está configurado para Render
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node src/server.js', 'El script start debe ejecutar node src/server.js');
  assert.equal(pkg.main, 'src/server.js');

  // 2. Base de datos contiene los 46 candidatos intactos sin duplicados
  const apts = database.listAppointments();
  assert.ok(apts.length >= 46, `Deben existir 46 citas (actual: ${apts.length})`);
  const confirmed = apts.filter(a => a.status === 'confirmada');
  assert.ok(confirmed.length >= 44, `Deben existir 44 confirmadas (actual: ${confirmed.length})`);

  // 3. No colisiones en turnos activos
  const seenSlots = new Set();
  for (const c of confirmed) {
    const key = `${c.date}_${c.time_slot}`;
    assert.ok(!seenSlots.has(key), `No deben existir duplicados en turnos activos: ${key} (${c.candidate_name})`);
    seenSlots.add(key);
  }
});

const originalSeedContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'seed-recovery.json'), 'utf8');

test.after(() => {
  database.db.exec(`
    UPDATE appointments 
    SET confirmation_sent_at = NULL,
        confirmation_status = 'pending',
        confirmation_variant = NULL,
        confirmation_error = NULL
  `);
  // Restaurar el seed-recovery original para no ensuciar git con timestamps modificados
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'seed-recovery.json'), originalSeedContent, 'utf8');
});
