const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.PORT = '3099';
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'test_api_alfa.sqlite');

const { app } = require('../src/server');
const database = require('../src/database');

let serverInstance;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    serverInstance = app.listen(3099, () => {
      baseUrl = 'http://localhost:3099';
      resolve();
    });
  });
});

test.after(async () => {
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
  }
});

test.beforeEach(() => {
  database.db.exec('DELETE FROM appointments; DELETE FROM chat_states; DELETE FROM audit_logs; DELETE FROM interview_dates; DELETE FROM phone_mappings;');
  database.initDatesSeed();
  if (typeof database.initPhoneMappingsSeed === 'function') {
    database.initPhoneMappingsSeed();
  }
});

test('API: GET /api/status retorna configuración y estado del sistema', async () => {
  const res = await fetch(`${baseUrl}/api/status`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(data.config.dates.length === 2);
  assert.ok(data.config.positions.length === 3);
  assert.equal(data.config.threshold, 10);
});

test('API: GET /api/slots calcula cupos y turnos libres', async () => {
  const res = await fetch(`${baseUrl}/api/slots?date=2025-11-04`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.remaining, 31);
  assert.equal(data.isCritical, false);
});

test('API: POST /api/appointments crea cita manualmente', async () => {
  const payload = {
    candidate_name: 'Elena Morales',
    phone_number: '50244445555',
    position: 'Promotor de Crédito',
    date: '2025-11-04',
    time_slot: '09:15',
    notes: 'Registro vía panel',
    sendNotification: false
  };

  const res = await fetch(`${baseUrl}/api/appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.appointment.candidate_name, 'Elena Morales');
  assert.equal(data.appointment.time_slot, '09:15');
});

test('API: PUT /api/appointments/:id edita y reprograma cualquier dato', async () => {
  const created = database.createAppointment({
    candidate_name: 'Roberto Dávila',
    phone_number: '50266667777',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '11:30'
  });

  const updatePayload = {
    candidate_name: 'Roberto Dávila Castillo',
    phone_number: '50266667777',
    position: 'Desembolsador de Crédito',
    date: '2025-11-05',
    time_slot: '15:00',
    notes: 'Cambio solicitado por el postulante',
    notifyCandidate: false
  };

  const res = await fetch(`${baseUrl}/api/appointments/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatePayload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.appointment.candidate_name, 'Roberto Dávila Castillo');
  assert.equal(data.appointment.position, 'Desembolsador de Crédito');
  assert.equal(data.appointment.date, '2025-11-05');
  assert.equal(data.appointment.time_slot, '15:00');
  assert.equal(data.appointment.status, 'reprogramada');
});

test('API: GET /api/export/excel genera archivo binario .xlsx válido', async () => {
  database.createAppointment({
    candidate_name: 'Test Excel',
    phone_number: '50299998888',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '08:30'
  });

  const res = await fetch(`${baseUrl}/api/export/excel`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('spreadsheetml'));
  const buffer = await res.arrayBuffer();
  assert.ok(buffer.byteLength > 1000, 'El archivo Excel debe contener bytes reales');
});

test('API: POST /api/appointments rechaza plaza inválida o fecha inexistente', async () => {
  const invalidPosRes = await fetch(`${baseUrl}/api/appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate_name: 'Carlos Test',
      phone_number: '50255551111',
      position: 'Gerente General', // No válida
      date: '2025-11-04',
      time_slot: '09:00'
    })
  });
  assert.equal(invalidPosRes.status, 400);
  const dataPos = await invalidPosRes.json();
  assert.equal(dataPos.success, false);
  assert.ok(dataPos.error.includes('Plaza no válida'));

  const invalidDateRes = await fetch(`${baseUrl}/api/appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate_name: 'Carlos Test',
      phone_number: '50255551111',
      position: 'Oficial de Crédito',
      date: '2025-11-20', // No permitida
      time_slot: '09:00'
    })
  });
  assert.equal(invalidDateRes.status, 400);
});

test('API: GET /api/dates retorna lista de fechas', async () => {
  const res = await fetch(`${baseUrl}/api/dates`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.dates));
  assert.ok(data.dates.length >= 2);
});

test('API: POST /api/dates agrega nueva fecha y PATCH /api/dates/:id la desactiva', async () => {
  const newDatePayload = {
    id: '2025-11-08',
    label: 'Sábado 8 de Noviembre',
    short: '08/11'
  };

  const createRes = await fetch(`${baseUrl}/api/dates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newDatePayload)
  });
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.equal(createData.success, true);
  assert.equal(createData.date.id, '2025-11-08');
  assert.equal(createData.date.is_active, true);

  // Pausar con PATCH
  const patchRes = await fetch(`${baseUrl}/api/dates/2025-11-08`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_active: false })
  });
  assert.equal(patchRes.status, 200);
  const patchData = await patchRes.json();
  assert.equal(patchData.success, true);
  assert.equal(patchData.date.is_active, false);
});

test('API: GET /api/backup/download genera y descarga archivo SQLite válido', async () => {
  const res = await fetch(`${baseUrl}/api/backup/download`);
  assert.equal(res.status, 200);
  const disposition = res.headers.get('content-disposition');
  assert.ok(disposition.includes('.sqlite'), 'Debe descargar un archivo con extensión .sqlite');
  const buffer = await res.arrayBuffer();
  assert.ok(buffer.byteLength > 0, 'El archivo de backup descargado no debe estar vacío');
});

test('Frontend HTML: Estructura de modales no anidados (datesModal independiente de newModal)', async () => {
  const fs = require('fs');
  const htmlPath = path.join(__dirname, '..', 'src', 'public', 'index.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // Verificar que existan los 3 modales
  assert.ok(htmlContent.includes('id="editModal"'));
  assert.ok(htmlContent.includes('id="newModal"'));
  assert.ok(htmlContent.includes('id="datesModal"'));

  // newModal debe cerrarse antes de datesModal
  const newModalIdx = htmlContent.indexOf('id="newModal"');
  const datesModalIdx = htmlContent.indexOf('id="datesModal"');
  assert.ok(newModalIdx < datesModalIdx, 'newModal debe preceder a datesModal');

  // En el fragmento entre newModal y datesModal debe existir el cierre de newModal (</div>\s*</div>)
  const fragmentBetween = htmlContent.slice(newModalIdx, datesModalIdx);
  const closingDivCount = (fragmentBetween.match(/<\/div>/g) || []).length;
  // newModal tiene su contenedor principal y un subcontenedor (bg-white)
  // Dentro de newModal se abren y cierran varios divs (en el form).
  // Verificamos que datesModal esté fuera del form y cerrado.
  assert.ok(fragmentBetween.includes('</form>'), 'El formulario de newModal debe estar cerrado');
  assert.ok(fragmentBetween.endsWith('</div>\n\n  <!-- MODAL PARA GESTIÓN DE FECHAS DE ENTREVISTA -->\n  <div ') || fragmentBetween.includes('</div>\n  </div>\n\n  <!-- MODAL PARA GESTIÓN DE FECHAS DE ENTREVISTA -->'), 'newModal debe tener ambos </div> de cierre antes de datesModal');
});

test('API: GET /api/citas retorna 200 con listado de citas y conteo', async () => {
  database.createAppointment({
    candidate_name: 'Marcos Benavides',
    phone_number: '50588889999',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '09:00'
  });

  const res = await fetch(`${baseUrl}/api/citas`);
  assert.equal(res.status, 200, 'GET /api/citas debe responder con status 200');
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(typeof data.count, 'number');
  assert.ok(Array.isArray(data.appointments));
  assert.ok(data.appointments.length >= 1);
  const found = data.appointments.find(a => a.candidate_name === 'Marcos Benavides');
  assert.ok(found);
  assert.equal(found.phone_number, '50588889999');
});

test('API: Todas las citas en /api/citas y /api/appointments tienen número telefónico numérico válido (sin @lid)', async () => {
  database.savePhoneMapping('112233445566778', '50587776655', 'test_seed');

  database.createAppointment({
    candidate_name: 'Candidato Estandard',
    phone_number: '88881122',
    jid: '50588881122@s.whatsapp.net',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '08:30'
  });

  database.createAppointment({
    candidate_name: 'Candidato LID Mapeado',
    phone_number: '112233445566778',
    jid: '112233445566778@lid',
    position: 'Promotor de Crédito',
    date: '2025-11-04',
    time_slot: '08:45'
  });

  database.createAppointment({
    candidate_name: 'Candidato LID No Mapeado',
    phone_number: '998877665544332',
    jid: '998877665544332@lid',
    position: 'Desembolsador de Crédito',
    date: '2025-11-04',
    time_slot: '09:00'
  });

  for (const endpoint of ['/api/citas', '/api/appointments']) {
    const res = await fetch(`${baseUrl}${endpoint}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.appointments.length >= 3);

    for (const apt of data.appointments) {
      assert.ok(!apt.phone_number.includes('@lid'), `phone_number "${apt.phone_number}" en ${endpoint} no debe contener @lid`);
      assert.ok(!apt.phone_number.includes('@s.whatsapp.net'), `phone_number "${apt.phone_number}" no debe contener @s.whatsapp.net`);
      assert.ok(
        /^\d{8,11}$/.test(apt.phone_number) || /^(?:\+?505)?[2578]\d{7}$/.test(apt.phone_number),
        `phone_number "${apt.phone_number}" en ${endpoint} debe tener formato numérico válido de 8 a 11 dígitos`
      );
      assert.ok(apt.phone_number.length <= 12, `phone_number "${apt.phone_number}" no debe exceder 12 dígitos (LID sin normalizar)`);
    }
  }
});

test('API: Cita almacenada con @lid devuelve en /api/citas su número telefónico real normalizado', async () => {
  const testLid = '445566778899001';
  const realPhone = '50583334444';
  database.savePhoneMapping(testLid, realPhone, 'whatsapp_sync');

  database.createAppointment({
    candidate_name: 'Valeria Solórzano',
    phone_number: testLid,
    jid: `${testLid}@lid`,
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '09:30'
  });

  const res = await fetch(`${baseUrl}/api/citas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  const found = data.appointments.find(a => a.candidate_name === 'Valeria Solórzano');
  assert.ok(found, 'La cita de Valeria Solórzano debe existir');
  assert.equal(found.phone_number, realPhone, 'El número retornado debe ser el teléfono mapeado real');
});

test('API: Citas existentes con @s.whatsapp.net retienen sus números telefónicos válidos', async () => {
  database.createAppointment({
    candidate_name: 'Javier Argeñal',
    phone_number: '50587654321',
    jid: '50587654321@s.whatsapp.net',
    position: 'Promotor de Crédito',
    date: '2025-11-04',
    time_slot: '09:45'
  });

  const res = await fetch(`${baseUrl}/api/citas`);
  assert.equal(res.status, 200);
  const data = await res.json();
  const found = data.appointments.find(a => a.candidate_name === 'Javier Argeñal');
  assert.ok(found);
  assert.equal(found.phone_number, '50587654321');

  // Verificar también en /api/citas/:id
  const singleRes = await fetch(`${baseUrl}/api/citas/${found.id}`);
  assert.equal(singleRes.status, 200);
  const singleData = await singleRes.json();
  assert.equal(singleData.appointment.phone_number, '50587654321');
});


