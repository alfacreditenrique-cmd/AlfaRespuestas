const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.DB_PATH = path.join(__dirname, '..', 'data', 'test_recovery.sqlite');
const database = require('../src/database');
const whatsappService = require('../src/whatsapp');
const scheduler = require('../src/scheduler');

let ts = 1000;
const msg = (jid, fromMe, text) => ({ key: { remoteJid: jid, fromMe }, messageTimestamp: ts++, message: { conversation: text } });
const ticket = (a) => `🎉 *¡ENHORABUENA! TU ENTREVISTA HA SIDO AGENDADA CON ÉXITO*\n\n` + scheduler.generateTicket(a);

test.beforeEach(() => {
  database.db.exec('DELETE FROM appointments; DELETE FROM chat_states; DELETE FROM audit_logs;');
  database.db.exec("DELETE FROM interview_dates WHERE id NOT IN ('2025-11-04','2025-11-05')");
});

test('Recuperación: reconstruye citas desde el historial de WhatsApp (normal, LID, reprogramada, cancelada, fecha perdida)', () => {
  const messages = [
    // 1) Chat normal
    msg('50511112222@s.whatsapp.net', false, 'Hola'),
    msg('50511112222@s.whatsapp.net', true, ticket({ candidate_name: 'Ana López', position: 'Oficial de Crédito', date: '2025-11-04', time_slot: '08:30' })),
    // 2) Chat LID: el postulante escribió su teléfono
    msg('272632142377156@lid', false, 'Pedro Alvarado'),
    msg('272632142377156@lid', false, '88776655'),
    msg('272632142377156@lid', true, ticket({ candidate_name: 'Pedro Alvarado', position: 'Promotor de Crédito', date: '2025-11-04', time_slot: '08:45' })),
    // 3) Reprogramada desde el panel: vale el último aviso
    msg('50533334444@s.whatsapp.net', true, ticket({ candidate_name: 'Luis Mora', position: 'Desembolsador de Crédito', date: '2025-11-04', time_slot: '09:00' })),
    msg('50533334444@s.whatsapp.net', true, scheduler.generateRescheduledNotice({ candidate_name: 'Luis Mora', position: 'Desembolsador de Crédito', date: '2025-11-05', time_slot: '10:15', status: 'reprogramada' })),
    // 4) Cancelada: no se recupera
    msg('50555556666@s.whatsapp.net', true, ticket({ candidate_name: 'Rosa Díaz', position: 'Oficial de Crédito', date: '2025-11-04', time_slot: '09:15' })),
    msg('50555556666@s.whatsapp.net', true, scheduler.generateRescheduledNotice({ candidate_name: 'Rosa Díaz', position: 'Oficial de Crédito', date: '2025-11-04', time_slot: '09:15', status: 'cancelada' })),
    // 5) Fecha agregada en el panel que ya no existe
    msg('50577778888@s.whatsapp.net', true, ticket({ candidate_name: 'Mario Ruiz', position: 'Oficial de Crédito', date: '2025-11-04', time_slot: '13:30' }).replace('Martes 4 de Noviembre', 'Jueves 6 de Noviembre')),
    // Mensaje del resumen al administrador: no es un ticket, se ignora
    msg('50575534509@s.whatsapp.net', true, '💾 *RESPALDO AUTOMÁTICO DE CITA*\n👤 *Postulante:* X Y\n⏰ *Hora:* 08:30 AM')
  ];

  // Orden aleatorio: la recuperación debe ordenar por fecha del mensaje
  const recovered = whatsappService.recoverFromHistory([...messages].reverse());
  assert.equal(recovered.length, 4);

  const ana = database.getAppointmentByPhone('50511112222');
  assert.equal(ana.candidate_name, 'Ana López');
  assert.equal(ana.time_slot, '08:30');

  const pedro = database.getAppointmentByPhone('272632142377156@lid');
  assert.equal(pedro.phone_number, '50588776655');
  assert.equal(pedro.position, 'Promotor de Crédito');

  const luis = database.getAppointmentByPhone('50533334444');
  assert.equal(luis.date, '2025-11-05');
  assert.equal(luis.time_slot, '10:15');

  assert.equal(database.getAppointmentByPhone('50555556666'), undefined);

  const mario = database.getAppointmentByPhone('50577778888');
  assert.equal(mario.date, '2025-11-06');
  assert.ok(database.getDateById('2025-11-06'));

  // Idempotente: una segunda pasada no duplica
  assert.equal(whatsappService.recoverFromHistory(messages).length, 0);
});

test('Recuperación: si el turno ya está ocupado, conserva la cita y la marca para revisar', () => {
  database.createAppointment({ candidate_name: 'Enrique Castillo', phone_number: '50575534505', position: 'Oficial de Crédito', date: '2025-11-04', time_slot: '08:30' });
  const recovered = whatsappService.recoverFromHistory([
    msg('50599990000@s.whatsapp.net', true, ticket({ candidate_name: 'Carla Pérez', position: 'Oficial de Crédito', date: '2025-11-04', time_slot: '08:30' }))
  ]);
  assert.equal(recovered.length, 1);
  assert.match(recovered[0].notes, /TURNO COMPARTIDO/);
});
