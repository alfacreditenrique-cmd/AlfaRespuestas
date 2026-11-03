const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const fs = require('fs');
const ExcelJS = require('exceljs');

const database = require('../src/database');
const whatsappService = require('../src/whatsapp');
const CONFIG = require('../src/config');
const scheduler = require('../src/scheduler');
const { app } = require('../src/server');

// Mock reply capture for WhatsApp service
let sentReplies = [];
const originalReply = whatsappService.reply;

function setupMockReply() {
  whatsappService.reply = async function(jid, text) {
    sentReplies.push({ jid, text });
  };
}

function restoreMockReply() {
  whatsappService.reply = originalReply;
}

const originalSeed = fs.readFileSync(path.join(__dirname, '..', 'src', 'seed-recovery.json'), 'utf8');

test('WhatsApp Protocolo Confirmación: Respuesta Afirmativa ("Sí", "Confirmo", "Asistiré", "Listo", "Ahí estaré")', async () => {
  setupMockReply();
  sentReplies = [];

  const candidates = database.listCandidatesForConfirmation();
  assert.ok(candidates.length >= 10, 'Deben existir candidatos en la base');
  const target = candidates[0];
  const resolvedPhone = database.resolvePhoneNumber(target.phone_number, target.jid);
  const originalConfStatus = target.confirmation_status;
  const originalSentAt = target.confirmation_sent_at;
  const originalVariant = target.confirmation_variant;

  try {
    // Marcar que se le envió el mensaje de confirmación
    database.markConfirmationSent(target.id, 1, 'Test envio confirmacion');

    // Casos de respuesta afirmativa naturales y modismos
    const affirmativePhrases = [
      'Sí, confirmo mi asistencia',
      'Confirmo',
      'Asistiré puntual',
      'Listo, muchas gracias',
      'De acuerdo, ahí estaré',
      'Buenas tardes, voy a asistir a la entrevista',
      'Confirmando mi cita',
      'Estaré puntual',
      'Llegaré puntual',
      'Enterado, muchas gracias',
      'Recibido, ahí estaré',
      'Anotado, gracias',
      'Confirmo la cita en mi agenda',
      'Listo, anotado en mi agenda'
    ];

    for (const phrase of affirmativePhrases) {
      sentReplies = [];
      await whatsappService.handleIncomingMessage({
        key: { remoteJid: target.jid || `${resolvedPhone}@s.whatsapp.net`, fromMe: false },
        message: { conversation: phrase }
      });

      assert.equal(sentReplies.length, 1, `Debe responder a la confirmación afirmativa: "${phrase}"`);
      const reply = sentReplies[0].text;

      // Debe ser un mensaje cordial de confirmación con recordatorio de Sébaco
      assert.ok(reply.includes(target.candidate_name.split(' ')[0]), 'Debe saludar al candidato por su nombre');
      assert.ok(reply.includes('confirmada'), 'Debe indicar que la asistencia quedó confirmada');
      assert.ok(reply.includes('Sébaco'), 'Debe incluir la sede Sébaco');
      assert.ok(reply.includes(target.position), 'Debe incluir la plaza');

      // Verificar estado en base de datos
      const updated = database.getAppointmentById(target.id);
      assert.equal(updated.confirmation_status, 'asistencia_confirmada', 'El estado de confirmación debe ser asistencia_confirmada');
      assert.equal(updated.status, 'confirmada', 'El estado de la cita debe permanecer confirmada');
    }
  } finally {
    database.db.prepare(`
      UPDATE appointments 
      SET confirmation_status = ?, confirmation_sent_at = ?, confirmation_variant = ?
      WHERE id = ?
    `).run(originalConfStatus, originalSentAt, originalVariant, target.id);
    restoreMockReply();
  }
});

test('WhatsApp Protocolo Confirmación: Respuesta Negativa ("No puedo", "No voy a ir", "Cancelo", "Ya conseguí empleo")', async () => {
  setupMockReply();
  sentReplies = [];

  const candidates = database.listCandidatesForConfirmation();
  const target = candidates[1];
  const resolvedPhone = database.resolvePhoneNumber(target.phone_number, target.jid);
  const chatId = target.jid ? target.jid.split('@')[0] : resolvedPhone;
  database.clearChatState(chatId);
  database.clearChatState(target.phone_number);
  if (resolvedPhone) database.clearChatState(resolvedPhone);

  const originalStatus = target.status;
  const originalConfStatus = target.confirmation_status;
  const originalNotes = target.notes;
  const originalSentAt = target.confirmation_sent_at;
  const originalVariant = target.confirmation_variant;

  try {
    database.markConfirmationSent(target.id, 2, 'Test envio confirmacion');

    // El turno debe estar ocupado inicialmente
    assert.equal(database.isSlotTaken(target.date, target.time_slot), true, 'El turno debe estar ocupado inicialmente');

    // Postulante responde negativamente
    await whatsappService.handleIncomingMessage({
      key: { remoteJid: target.jid || `${resolvedPhone}@s.whatsapp.net`, fromMe: false },
      message: { conversation: 'Buenas tardes, lamentablemente no puedo asistir, ya conseguí empleo en otro lugar. Cancelo mi cita.' }
    });

    assert.equal(sentReplies.length, 1);
    const reply = sentReplies[0].text;

    // Debe acusar recibo cordialmente y avisar de liberación del turno
    assert.ok(reply.includes('Entendido') || reply.includes('liberamos tu turno'));
    assert.ok(reply.includes('liberamos tu turno'));
    assert.ok(reply.includes('éxito'));

    // Verificar que la cita pasó a cancelada y liberó el turno
    const updated = database.getAppointmentById(target.id);
    assert.equal(updated.status, 'cancelada', 'La cita debe marcarse como cancelada');
    assert.equal(updated.confirmation_status, 'no_asistira', 'confirmation_status debe ser no_asistira');

    // El turno debe haber quedado liberado
    assert.equal(database.isSlotTaken(target.date, target.time_slot), false, 'El turno debe haber quedado liberado');
  } finally {
    database.db.prepare(`
      UPDATE appointments 
      SET status = ?, confirmation_status = ?, notes = ?, confirmation_sent_at = ?, confirmation_variant = ?
      WHERE id = ?
    `).run(originalStatus, originalConfStatus, originalNotes, originalSentAt, originalVariant, target.id);
    database.clearChatState(chatId);
    restoreMockReply();
  }
});

test('WhatsApp Protocolo Confirmación: "REPROGRAMAR" conserva el flujo de reprogramación sin colisión', async () => {
  setupMockReply();
  sentReplies = [];

  const candidates = database.listCandidatesForConfirmation();
  const target = candidates[2];
  const resolvedPhone = database.resolvePhoneNumber(target.phone_number, target.jid);

  try {
    database.markConfirmationSent(target.id, 3);

    // Candidato envía "REPROGRAMAR"
    await whatsappService.handleIncomingMessage({
      key: { remoteJid: target.jid || `${resolvedPhone}@s.whatsapp.net`, fromMe: false },
      message: { conversation: 'REPROGRAMAR' }
    });

    assert.equal(sentReplies.length, 1);
    assert.ok(sentReplies[0].text.includes('REPROGRAMACIÓN DE ENTREVISTA'));
    assert.ok(sentReplies[0].text.includes(target.candidate_name));
    assert.ok(sentReplies[0].text.includes('Por favor selecciona la plaza'));
  } finally {
    database.clearChatState(target.phone_number);
    if (resolvedPhone) database.clearChatState(resolvedPhone);
    if (target.jid) database.clearChatState(target.jid.split('@')[0]);
    restoreMockReply();
  }
});

test('Reporte Excel: GET /api/export/excel genera archivo multi-hoja dividido por fechas con lista de firmas', async () => {
  const testServer = http.createServer(app);
  await new Promise(resolve => testServer.listen(0, resolve));
  const port = testServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/api/export/excel`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('spreadsheetml'));

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    assert.ok(buffer.length > 2000, 'El archivo Excel debe tener contenido binario válido');

    // Parsear el workbook con ExcelJS
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    // Debe contener hojas separadas por fecha
    assert.ok(workbook.worksheets.length >= 2, `Debe contener al menos 2 hojas por fecha (actual: ${workbook.worksheets.length})`);

    const sheetNames = workbook.worksheets.map(w => w.name);
    assert.ok(sheetNames.some(n => n.includes('04-Nov') || n.includes('Miércoles')), 'Debe existir hoja para 04-Nov');
    assert.ok(sheetNames.some(n => n.includes('05-Nov') || n.includes('Jueves')), 'Debe existir hoja para 05-Nov');

    // Verificar estructura de cada hoja
    for (const ws of workbook.worksheets) {
      // 1. Título corporativo
      const cellA1 = ws.getCell('A1');
      assert.ok(cellA1.value.includes('ALFACREDIT S.A.'), 'Fila 1 debe tener título corporativo AlfaCredit S.A.');
      assert.ok(cellA1.value.includes('LISTA DE ASISTENCIA'), 'Debe titularse Lista de Asistencia');

      // 2. Subtítulo con sede Sébaco
      const cellA2 = ws.getCell('A2');
      assert.ok(cellA2.value.includes('Sébaco'), 'Fila 2 debe indicar la sede Sébaco');

      // 3. Encabezados de la tabla oficial en fila 5
      const headerRow = ws.getRow(5);
      const expectedHeaders = [
        'N°',
        'Hora de Cita',
        'Nombre Completo del Postulante',
        'Cargo / Plaza',
        'Teléfono / WhatsApp',
        'Estado de Confirmación',
        'Firma del Postulante',
        'Observaciones / Hora Real de Recepción'
      ];

      expectedHeaders.forEach((expected, i) => {
        const val = headerRow.getCell(i + 1).value;
        assert.ok(val && String(val).includes(expected.split(' ')[0]), `Columna ${i + 1} debe coincidir con ${expected} (actual: ${val})`);
      });

      // 4. Espacio amplio para firma y dimensiones
      const colFirma = ws.getColumn(7);
      assert.ok(colFirma.width >= 30, 'Columna Firma del Postulante debe tener ancho amplio (>= 30)');

      // 5. Configuración de impresión horizontal (landscape, Carta y títulos repetidos)
      assert.equal(ws.pageSetup.orientation, 'landscape', 'Debe estar configurado en horizontal para impresión directa');
      assert.equal(ws.pageSetup.paperSize, 1, 'Debe estar configurado en papel Carta (paperSize 1)');
      assert.equal(ws.pageSetup.printTitlesRow, '5:5', 'Debe repetir los encabezados oficiales en cada página impresa');

      // 6. Orden cronológico de llegada (time_slot ascendente)
      const times = [];
      ws.eachRow((row, rowNumber) => {
        if (rowNumber >= 6 && row.getCell(1).value && typeof row.getCell(1).value === 'number') {
          const timeVal = String(row.getCell(2).value || '');
          const match = timeVal.match(/\((\d{2}:\d{2})\)/);
          if (match) times.push(match[1]);
        }
      });

      if (times.length > 1) {
        for (let i = 1; i < times.length; i++) {
          assert.ok(times[i] >= times[i - 1], `Los horarios deben estar en orden cronológico: ${times[i - 1]} <= ${times[i]}`);
        }
      }
    }
  } finally {
    await new Promise(resolve => testServer.close(resolve));
  }
});

test('WhatsApp Protocolo Confirmación: Candidato con estado previo en chat_states confirma exitosamente', async () => {
  setupMockReply();
  sentReplies = [];

  const candidates = database.listCandidatesForConfirmation();
  const target = candidates[3];
  const resolvedPhone = database.resolvePhoneNumber(target.phone_number, target.jid);
  const chatId = target.jid ? target.jid.split('@')[0] : resolvedPhone;

  const originalConfStatus = target.confirmation_status;
  const originalSentAt = target.confirmation_sent_at;
  const originalVariant = target.confirmation_variant;

  try {
    // Simular que el candidato tenía un estado previo abierto (ej: menú o interacción no concluida)
    database.saveChatState(chatId, { step: 'AWAITING_POSITION', jid: target.jid || `${resolvedPhone}@s.whatsapp.net` });
    database.markConfirmationSent(target.id, 1, 'Envio previo');

    // Candidato responde con confirmación natural
    await whatsappService.handleIncomingMessage({
      key: { remoteJid: target.jid || `${resolvedPhone}@s.whatsapp.net`, fromMe: false },
      message: { conversation: 'Buenas tardes, voy a asistir a la entrevista' }
    });

    assert.equal(sentReplies.length, 1);
    const reply = sentReplies[0].text;
    assert.ok(!reply.includes('Opción no válida'), 'NO debe responder con error de opción no válida');
    assert.ok(reply.includes('confirmada'), 'Debe confirmar su asistencia exitosamente');

    const updated = database.getAppointmentById(target.id);
    assert.equal(updated.confirmation_status, 'asistencia_confirmada');
  } finally {
    database.db.prepare(`
      UPDATE appointments 
      SET confirmation_status = ?, confirmation_sent_at = ?, confirmation_variant = ?
      WHERE id = ?
    `).run(originalConfStatus, originalSentAt, originalVariant, target.id);
    database.clearChatState(chatId);
    restoreMockReply();
  }
});

test.after(() => {
  // Restaurar estado limpio para no alterar otras suites
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'seed-recovery.json'), originalSeed, 'utf8');
  database.syncFromSeedRecovery(database.db);
});
