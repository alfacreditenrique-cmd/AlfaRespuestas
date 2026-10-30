const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Usar una base de datos temporal aislada para pruebas
const testDbPath = path.join(__dirname, '..', 'data', 'test_alfa.sqlite');
process.env.DB_PATH = testDbPath;

const CONFIG = require('../src/config');
const database = require('../src/database');
const scheduler = require('../src/scheduler');

test.beforeEach(() => {
  // Limpiar tablas antes de cada prueba
  database.db.exec('DELETE FROM appointments; DELETE FROM chat_states; DELETE FROM audit_logs; DELETE FROM interview_dates;');
  database.initDatesSeed();
});

test('Database: Creación y recuperación de cita', () => {
  const apt = database.createAppointment({
    candidate_name: 'Carlos Ramírez',
    phone_number: '50255551234',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '08:30',
    notes: 'Prueba unitaria'
  });

  assert.ok(apt.id > 0);
  assert.equal(apt.candidate_name, 'Carlos Ramírez');
  assert.equal(apt.status, 'confirmada');
  assert.equal(apt.date, '2025-11-04');
  assert.equal(apt.time_slot, '08:30');

  const retrieved = database.getAppointmentById(apt.id);
  assert.equal(retrieved.candidate_name, 'Carlos Ramírez');
});

test('Database: Detección de turnos tomados y prevención de duplicados', () => {
  database.createAppointment({
    candidate_name: 'Pedro Juárez',
    phone_number: '50255550001',
    position: 'Promotor de Crédito',
    date: '2025-11-04',
    time_slot: '09:00'
  });

  assert.equal(database.isSlotTaken('2025-11-04', '09:00'), true);
  assert.equal(database.isSlotTaken('2025-11-04', '09:15'), false);
});

test('Database: Edición y Reprogramación de Cita', () => {
  const original = database.createAppointment({
    candidate_name: 'María Fernández',
    phone_number: '50255557788',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '10:00'
  });

  // Reprogramar a otra fecha y hora
  const updated = database.updateAppointment(original.id, {
    candidate_name: 'María Fernández Soto',
    position: 'Desembolsador de Crédito',
    date: '2025-11-05',
    time_slot: '14:30',
    notes: 'Reprogramado por solicitud telefónica'
  });

  assert.equal(updated.id, original.id);
  assert.equal(updated.candidate_name, 'María Fernández Soto');
  assert.equal(updated.position, 'Desembolsador de Crédito');
  assert.equal(updated.date, '2025-11-05');
  assert.equal(updated.time_slot, '14:30');
  assert.equal(updated.status, 'reprogramada');

  // El turno anterior debe quedar libre
  assert.equal(database.isSlotTaken('2025-11-04', '10:00'), false);
  // El nuevo turno debe quedar ocupado
  assert.equal(database.isSlotTaken('2025-11-05', '14:30'), true);
});

test('Database: Rechaza reprogramar a un turno ya ocupado por otra persona', () => {
  database.createAppointment({
    candidate_name: 'Postulante 1',
    phone_number: '50211111111',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '11:00'
  });

  const apt2 = database.createAppointment({
    candidate_name: 'Postulante 2',
    phone_number: '50222222222',
    position: 'Promotor de Crédito',
    date: '2025-11-04',
    time_slot: '11:15'
  });

  // Intentar mover apt2 al turno 11:00 que ya tiene Postulante 1
  assert.throws(() => {
    database.updateAppointment(apt2.id, {
      date: '2025-11-04',
      time_slot: '11:00'
    });
  }, /ya se encuentra ocupado/);
});

test('Database: Cancelación libera el turno', () => {
  const apt = database.createAppointment({
    candidate_name: 'Luis Méndez',
    phone_number: '50233333333',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '08:45'
  });

  assert.equal(database.isSlotTaken('2025-11-04', '08:45'), true);

  database.cancelAppointment(apt.id, 'Candidato no puede asistir');
  assert.equal(database.isSlotTaken('2025-11-04', '08:45'), false);

  const cancelledApt = database.getAppointmentById(apt.id);
  assert.equal(cancelledApt.status, 'cancelada');
});

test('Alerta de Cupos <= 10: Se activa exactamente cuando quedan 10 turnos o menos', () => {
  const totalSlots = CONFIG.TIME_SLOTS.length; // 31
  const dateId = '2025-11-04';

  // Llenamos 20 turnos -> Quedan 11 turnos (aún NO es crítico, umbral es 10)
  for (let i = 0; i < 20; i++) {
    database.createAppointment({
      candidate_name: `Candidato ${i + 1}`,
      phone_number: `502900000${i.toString().padStart(2, '0')}`,
      position: 'Oficial de Crédito',
      date: dateId,
      time_slot: CONFIG.TIME_SLOTS[i]
    });
  }

  assert.equal(scheduler.getRemainingCount(dateId), 11);
  assert.equal(scheduler.isCriticalRemaining(dateId), false, 'Con 11 cupos no debe marcar crítico');

  // Llenamos el turno 21 -> Quedan exactamente 10 turnos (¡ALERTA CRÍTICA ACTIVA!)
  database.createAppointment({
    candidate_name: 'Candidato 21',
    phone_number: '50290000021',
    position: 'Oficial de Crédito',
    date: dateId,
    time_slot: CONFIG.TIME_SLOTS[20]
  });

  assert.equal(scheduler.getRemainingCount(dateId), 10);
  assert.equal(scheduler.isCriticalRemaining(dateId), true, 'Con 10 cupos DEBE activarse la alerta crítica');

  const notice = scheduler.getQuotaNotice(dateId);
  assert.ok(notice.includes('ÚLTIMOS CUPOS'), 'El aviso debe contener la advertencia de últimos cupos');
  assert.ok(notice.includes('10'), 'El aviso debe indicar que quedan 10 turnos');
});

test('Database: Rechaza reactivar cita cancelada si el turno fue tomado por otra persona', () => {
  // 1. Candidato A crea cita en 09:30
  const aptA = database.createAppointment({
    candidate_name: 'Candidato A',
    phone_number: '50255550001',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '09:30'
  });

  // 2. Candidato A cancela
  database.cancelAppointment(aptA.id, 'Cancelado temporalmente');
  assert.equal(database.isSlotTaken('2025-11-04', '09:30'), false);

  // 3. Candidato B toma ese turno 09:30
  const aptB = database.createAppointment({
    candidate_name: 'Candidato B',
    phone_number: '50255550002',
    position: 'Promotor de Crédito',
    date: '2025-11-04',
    time_slot: '09:30'
  });
  assert.equal(database.isSlotTaken('2025-11-04', '09:30'), true);

  // 4. Intentar reactivar Candidato A a 'confirmada' en la misma fecha y hora (debe fallar)
  assert.throws(() => {
    database.updateAppointment(aptA.id, {
      status: 'confirmada'
    });
  }, /ya se encuentra ocupado/);
});

test('Database: Normalización y búsqueda de teléfono (soporta 8 dígitos con prefijo por defecto)', () => {
  const apt = database.createAppointment({
    candidate_name: 'Hugo Morales',
    phone_number: '71234567', // 8 dígitos nacional
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '10:15'
  });

  assert.equal(apt.phone_number, '50571234567');

  // Buscar con prefijo 505
  const found1 = database.getAppointmentByPhone('50571234567');
  assert.ok(found1);
  assert.equal(found1.id, apt.id);

  // Buscar con formato WhatsApp internacional con espacios o símbolos
  const found2 = database.getAppointmentByPhone('+505 7123-4567');
  assert.ok(found2);
  assert.equal(found2.id, apt.id);

  // Buscar con formato 8 dígitos
  const found3 = database.getAppointmentByPhone('71234567');
  assert.ok(found3);
  assert.equal(found3.id, apt.id);
});

test('Database: Validación estricta de fechas y turnos autorizados', () => {
  // Fecha inválida
  assert.throws(() => {
    database.createAppointment({
      candidate_name: 'Error Date',
      phone_number: '50212345678',
      position: 'Oficial de Crédito',
      date: '2025-11-99',
      time_slot: '08:30'
    });
  }, /Fecha inválida/);

  // Horario no autorizado (ej: durante el almuerzo o fuera de rango)
  assert.throws(() => {
    database.createAppointment({
      candidate_name: 'Error Time',
      phone_number: '50212345678',
      position: 'Oficial de Crédito',
      date: '2025-11-04',
      time_slot: '12:30' // Bloque de almuerzo
    });
  }, /Horario inválido/);
});

test('Database: Gestión Dinámica de Fechas (agregar, pausar, reactivar)', () => {
  // 1. Agregar nueva fecha
  const newDate = database.addDate({
    id: '2025-11-07',
    label: 'Viernes 7 de Noviembre',
    short: '07/11'
  });

  assert.equal(newDate.id, '2025-11-07');
  assert.equal(newDate.label, 'Viernes 7 de Noviembre');
  assert.equal(newDate.is_active, true);

  // 2. Verificar que aparezca en getActiveDates
  const activeDates = database.getActiveDates();
  assert.ok(activeDates.some(d => d.id === '2025-11-07'));

  // 3. Crear cita en la nueva fecha
  const apt = database.createAppointment({
    candidate_name: 'Candidato Viernes',
    phone_number: '50277778888',
    position: 'Oficial de Crédito',
    date: '2025-11-07',
    time_slot: '09:00'
  });
  assert.equal(apt.date, '2025-11-07');

  // 4. Pausar la fecha
  const toggledOff = database.toggleDate('2025-11-07', false);
  assert.equal(toggledOff.is_active, false);

  const activeDatesAfterPause = database.getActiveDates();
  assert.equal(activeDatesAfterPause.some(d => d.id === '2025-11-07'), false, 'La fecha pausada no debe estar en activas');

  // Intentar crear nueva cita en fecha pausada debe fallar
  assert.throws(() => {
    database.createAppointment({
      candidate_name: 'Intento en fecha inactiva',
      phone_number: '50299991111',
      position: 'Oficial de Crédito',
      date: '2025-11-07',
      time_slot: '09:15'
    });
  }, /Fecha inválida/);

  // 5. Reactivar fecha
  const toggledOn = database.toggleDate('2025-11-07', true);
  assert.equal(toggledOn.is_active, true);
  assert.ok(database.getActiveDates().some(d => d.id === '2025-11-07'));
});

test('Database: Sistema de Respaldos Automáticos en Caliente (createBackup)', () => {
  // Crear una cita para tener datos reales
  database.createAppointment({
    candidate_name: 'Candidato Para Respaldo',
    phone_number: '50298765432',
    position: 'Desembolsador de Crédito',
    date: '2025-11-04',
    time_slot: '14:00'
  });

  const backupPath = database.createBackup();
  assert.ok(backupPath, 'createBackup debe devolver una ruta');
  assert.ok(fs.existsSync(backupPath), 'El archivo de respaldo SQLite debe existir en disco');

  const stat = fs.statSync(backupPath);
  assert.ok(stat.size > 0, 'El archivo de respaldo debe contener bytes');

  // Verificar integridad leyendo la base de datos de respaldo
  const { DatabaseSync } = require('node:sqlite');
  const backupDb = new DatabaseSync(backupPath);
  const row = backupDb.prepare('SELECT candidate_name FROM appointments WHERE phone_number = ?').get('50298765432');
  assert.ok(row);
  assert.equal(row.candidate_name, 'Candidato Para Respaldo');
  backupDb.close();

  // Limpiar archivo de prueba generado
  try { fs.unlinkSync(backupPath); } catch {}
});

test('Database: Sincronización no destructiva desde seed-recovery.json (syncFromSeedRecovery)', () => {
  // Base de datos limpia tras beforeEach
  const res1 = database.syncFromSeedRecovery();
  assert.ok(res1.appointments >= 24, `Debe sincronizar al menos 24 citas (sincronizó ${res1.appointments})`);

  const list = database.listAppointments();
  assert.ok(list.length >= 24, `Total de citas en BD debe ser >= 24 (encontró ${list.length})`);

  // Verificar presencia de candidatos clave requeridos por R4 y R5
  const ronald = list.find(a => /ronald\s+espinoza/i.test(a.candidate_name));
  assert.ok(ronald, 'Ronald Espinoza debe estar presente en las citas');
  assert.equal(ronald.position, 'Oficial de Crédito');
  assert.equal(ronald.date, '2025-11-04');
  assert.equal(ronald.time_slot, '14:30');

  const esmeyling = list.find(a => /esmeyling/i.test(a.candidate_name));
  assert.ok(esmeyling, 'Esmeyling Martínez debe estar presente');
  assert.equal(esmeyling.date, '2025-11-04');
  assert.equal(esmeyling.time_slot, '13:30');

  const daniela = list.find(a => /daniela\s+kassandra/i.test(a.candidate_name));
  assert.ok(daniela, 'Daniela Kassandra Molina Castro debe estar presente');
  assert.equal(daniela.date, '2025-11-04');
  assert.equal(daniela.time_slot, '13:45');

  const juan = list.find(a => /juan\s+alberto/i.test(a.candidate_name));
  assert.ok(juan, 'Juan Alberto Chavarría aguirre debe estar presente');

  const napoleon = list.find(a => /napoleon/i.test(a.candidate_name));
  assert.ok(napoleon, 'Napoleon García vivas debe estar presente');

  // Idempotencia: una segunda pasada no debe duplicar registros
  const res2 = database.syncFromSeedRecovery();
  assert.equal(res2.appointments, 0, 'La segunda ejecución no debe insertar citas duplicadas');
  assert.equal(database.listAppointments().length, list.length, 'El total de citas debe permanecer inalterado');
});

test('Database: Conciliación y resolución de Ronald Espinoza por teléfono y LID', () => {
  database.syncFromSeedRecovery();

  // Búsqueda por número directo asignado
  const aptByPhone = database.getAppointmentByPhone('50589436869');
  assert.ok(aptByPhone, 'Debe encontrar a Ronald Espinoza por su teléfono 50589436869');
  assert.match(aptByPhone.candidate_name, /Ronald Espinoza/i);

  // Búsqueda por LID histórico de WhatsApp
  const aptByLid = database.getAppointmentByPhone('87424344531017@lid');
  assert.ok(aptByLid, 'Debe encontrar a Ronald Espinoza por su JID @lid');
  assert.match(aptByLid.candidate_name, /Ronald Espinoza/i);
});

test('Database & Session: Verificación de integridad de credenciales de WhatsApp (auth_info_baileys)', () => {
  const credsPath = path.join(CONFIG.AUTH_DIR, 'creds.json');
  assert.ok(fs.existsSync(credsPath), 'auth_info_baileys/creds.json debe existir');

  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  assert.ok(creds.me, 'creds.json debe tener objeto de identidad me');
  assert.ok(creds.me.id && creds.me.id.includes('@s.whatsapp.net'), 'ID de WhatsApp debe tener formato @s.whatsapp.net');
  assert.ok(creds.noiseKey, 'Clave criptográfica noiseKey debe estar presente');
  assert.ok(creds.signedIdentityKey, 'signedIdentityKey debe estar presente');
  assert.ok(creds.signedPreKey, 'signedPreKey debe estar presente');
});

test('WhatsApp Session: Re-vinculación freshRegistration persiste nuevas credenciales vía saveCreds() sin perder referencia', async () => {
  const { useMultiFileAuthState, initAuthCreds } = require('@whiskeysockets/baileys');
  const tmpAuthDir = path.join(__dirname, '..', 'data', 'test_tmp_auth_baileys');
  fs.mkdirSync(tmpAuthDir, { recursive: true });
  try {
    // 1. Simular sesión antigua expirada en disco
    const oldCreds = initAuthCreds();
    oldCreds.me = { id: '50500000000:1@s.whatsapp.net', name: 'OldDevice' };
    fs.writeFileSync(path.join(tmpAuthDir, 'creds.json'), JSON.stringify(oldCreds));
    fs.writeFileSync(path.join(tmpAuthDir, 'session-stale.0.json'), JSON.stringify({ stale: true }));

    // 2. Cargar estado con useMultiFileAuthState y aplicar el flujo in-place de freshRegistration
    const { state, saveCreds } = await useMultiFileAuthState(tmpAuthDir);
    const freshCreds = initAuthCreds();
    for (const k of Object.keys(state.creds)) {
      delete state.creds[k];
    }
    Object.assign(state.creds, freshCreds);
    assert.equal(state.creds.me, undefined, 'Antes de vincular, state.creds.me debe estar limpio');

    // 3. Simular emparejamiento exitoso (QR o Código de 8 dígitos)
    Object.assign(state.creds, {
      me: { id: '50575534509:99@s.whatsapp.net', name: 'AlfaCredit S.A.' },
      account: { details: 'test' },
      registered: true
    });
    await saveCreds();

    // 4. Verificar que creds.json en disco guardó la NUEVA sesión y no la antigua
    const savedOnDisk = JSON.parse(fs.readFileSync(path.join(tmpAuthDir, 'creds.json'), 'utf8'));
    assert.equal(savedOnDisk.me.id, '50575534509:99@s.whatsapp.net');
    assert.equal(savedOnDisk.registered, true);
  } finally {
    try { fs.rmSync(tmpAuthDir, { recursive: true, force: true }); } catch {}
  }
});

