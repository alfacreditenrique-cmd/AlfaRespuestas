const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.DB_PATH = path.join(__dirname, '..', 'data', 'test_wa_flow.sqlite');
const database = require('../src/database');
const whatsappService = require('../src/whatsapp');
const CONFIG = require('../src/config');
const scheduler = require('../src/scheduler');

// Mock reply capture
let sentReplies = [];
whatsappService.reply = async function(jid, text) {
  sentReplies.push({ jid, text });
};

test.beforeEach(() => {
  database.db.exec('DELETE FROM appointments; DELETE FROM chat_states; DELETE FROM audit_logs; DELETE FROM interview_dates;');
  database.initDatesSeed();
  sentReplies = [];
});

test('WhatsApp Flow: Flujo completo de registro de postulante paso a paso', async () => {
  const fromJid = '50299887766@s.whatsapp.net';

  // Paso 0: Postulante saluda
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Buenas tardes, quiero agendar mi entrevista' }
  });

  assert.equal(sentReplies.length, 1);
  assert.ok(sentReplies[0].text.includes('Oficial de Crédito'));
  assert.ok(sentReplies[0].text.includes('Promotor de Crédito'));

  // Paso 1: Postulante elige plaza '1' (Oficial de Crédito)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '1' }
  });

  assert.equal(sentReplies.length, 2);
  assert.ok(sentReplies[1].text.includes('Miércoles 4 de Noviembre'));
  assert.ok(sentReplies[1].text.includes('Cupos disponibles'));

  // Paso 2: Postulante elige fecha '1' (Miércoles 4 de Noviembre)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '1' }
  });

  assert.equal(sentReplies.length, 3);
  assert.ok(sentReplies[2].text.includes('Nombre Completo'));
  assert.ok(sentReplies[2].text.includes('Miércoles 4 de Noviembre'));

  // Paso 3: Postulante envía su nombre
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Juan Carlos Batres' }
  });

  assert.equal(sentReplies.length, 4);
  assert.ok(sentReplies[3].text.includes('ENHORABUENA'));
  assert.ok(sentReplies[3].text.includes('Juan Carlos Batres'));

  // Verificar en base de datos
  const apt = database.getAppointmentByPhone('50299887766');
  assert.ok(apt);
  assert.equal(apt.candidate_name, 'Juan Carlos Batres');
  assert.equal(apt.position, 'Oficial de Crédito');
  assert.equal(apt.status, 'confirmada');
});

test('WhatsApp Flow: Rompe bucle infinito y permite reprogramar con la palabra REPROGRAMAR o REINICIAR', async () => {
  const fromJid = '50288776655@s.whatsapp.net';

  // Crear cita previa
  const originalApt = database.createAppointment({
    candidate_name: 'Silvia Orellana',
    phone_number: '50288776655',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '08:30'
  });

  // Silvia escribe al bot
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Hola, tengo una duda' }
  });

  assert.equal(sentReplies.length, 1);
  assert.ok(sentReplies[0].text.includes('Ya tienes una entrevista agendada'));
  assert.ok(sentReplies[0].text.includes('REPROGRAMAR'));

  // Silvia responde "REPROGRAMAR"
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'REPROGRAMAR' }
  });

  // NO debe repetir el mensaje de "Ya tienes cita", sino abrir el menú de selección de plaza
  assert.equal(sentReplies.length, 2);
  assert.ok(sentReplies[1].text.includes('REPROGRAMACIÓN DE ENTREVISTA'));
  assert.ok(sentReplies[1].text.includes('Oficial de Crédito'));

  // Silvia selecciona plaza '3' (Desembolsador de Crédito)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '3' }
  });

  // Selecciona fecha '2' (Miércoles 5 de Noviembre)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '2' }
  });

  // Confirma su nombre
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Silvia Orellana' }
  });

  // Verificar que la cita previa quedó cancelada y se liberó su slot
  const oldApt = database.getAppointmentById(originalApt.id);
  assert.equal(oldApt.status, 'cancelada');
  assert.equal(database.isSlotTaken('2025-11-04', '08:30'), false, 'El slot anterior debe quedar libre');

  // Y la nueva cita está activa
  const newApt = database.getAppointmentByPhone('50288776655');
  assert.ok(newApt);
  assert.equal(newApt.date, '2025-11-05');
  assert.equal(newApt.position, 'Desembolsador de Crédito');
});

test('WhatsApp Flow: Soporta mensajes efímeros / temporales sin descartarlos', async () => {
  const fromJid = '50277665544@s.whatsapp.net';

  // Mensaje envuelto en ephemeralMessage
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: {
      ephemeralMessage: {
        message: {
          conversation: 'Hola desde chat con mensajes temporales'
        }
      }
    }
  });

  assert.equal(sentReplies.length, 1);
  assert.ok(sentReplies[0].text.includes('AlfaCredit S.A.'));
  assert.ok(sentReplies[0].text.includes('Por favor selecciona la plaza'));
});

test('WhatsApp Flow: Normaliza usuarios multidispositivo (remueve sufijo :1 o :2)', async () => {
  const multiDeviceJid = '50566554433:2@s.whatsapp.net';

  await whatsappService.handleIncomingMessage({
    key: { remoteJid: multiDeviceJid, fromMe: false },
    message: { conversation: 'Quiero agendar' }
  });

  const state = database.getChatState('50566554433');
  assert.ok(state, 'El estado debe guardarse bajo el teléfono limpio sin sufijo :2');
  assert.equal(state.phone_number, '50566554433');
});

test('WhatsApp Flow: Soporta usuarios con cuenta LID (@lid) y responde a su @lid sin corromper a @s.whatsapp.net', async () => {
  const lidJid = '272632142377156:0@lid';

  // Paso 0: Postulante con LID escribe "hola"
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: 'Hola, buenas' }
  });

  assert.equal(sentReplies.length, 1);
  assert.equal(sentReplies[0].jid, '272632142377156@lid', 'La respuesta DEBE enviarse al JID @lid del usuario');
  assert.ok(sentReplies[0].text.includes('Oficial de Crédito'));

  // Paso 1: Postulante responde "2" (Promotor de Crédito)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: '2' }
  });

  assert.equal(sentReplies.length, 2);
  assert.equal(sentReplies[1].jid, '272632142377156@lid');
  assert.ok(sentReplies[1].text.includes('Promotor de Crédito'));

  // Paso 2: Postulante responde "1" (Martes 4 de Noviembre)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: '1' }
  });

  assert.equal(sentReplies.length, 3);
  assert.equal(sentReplies[2].jid, '272632142377156@lid');
  assert.ok(sentReplies[2].text.includes('Nombre Completo'));

  // Paso 3: Postulante envía su nombre
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: 'Pedro Alvarado' }
  });

  // El bot debe pedir su número de teléfono para Recursos Humanos
  assert.equal(sentReplies.length, 4);
  assert.equal(sentReplies[3].jid, '272632142377156@lid');
  assert.ok(sentReplies[3].text.includes('Número de Teléfono'));

  // Paso 4: Postulante envía su número de teléfono
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: '75551234' }
  });

  assert.equal(sentReplies.length, 5);
  assert.equal(sentReplies[4].jid, '272632142377156@lid');
  assert.ok(sentReplies[4].text.includes('ENHORABUENA'));

  // Verificar en base de datos que se guardó el teléfono real y el JID
  const apt = database.getAppointmentByPhone('50575551234');
  assert.ok(apt);
  assert.equal(apt.candidate_name, 'Pedro Alvarado');
  assert.equal(apt.jid, '272632142377156@lid');
  assert.equal(apt.position, 'Promotor de Crédito');
});

test('WhatsApp Flow: Blindaje Conversacional - Repetición estricta de menú ante entradas inválidas en cada paso', async () => {
  const fromJid = '50233445566@s.whatsapp.net';
  const cleanPhone = '50233445566';

  // Paso 0: Postulante saluda
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Hola, buenas tardes' }
  });

  assert.equal(sentReplies.length, 1);
  assert.ok(sentReplies[0].text.includes('Oficial de Crédito'));
  let state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_POSITION');

  // Paso 1 con error: Postulante escribe "hola", "4" o texto inválido
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'quiero informacion' }
  });

  assert.equal(sentReplies.length, 2);
  assert.ok(sentReplies[1].text.includes('Opción no reconocida'), 'Debe advertir que la opción no fue reconocida');
  assert.ok(sentReplies[1].text.includes('Oficial de Crédito'), 'Debe repetir el menú de plazas');
  state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_POSITION', 'No debe avanzar ni perder el paso');

  // Paso 1 corregido: Elige '1' (Oficial de Crédito)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '1' }
  });

  assert.equal(sentReplies.length, 3);
  assert.ok(sentReplies[2].text.includes('Has seleccionado: *Oficial de Crédito*'));
  state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_DATE');

  // Paso 2 con error: Postulante escribe fecha inválida "otro dia", "9"
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '9' }
  });

  assert.equal(sentReplies.length, 4);
  assert.ok(sentReplies[3].text.includes('Opción no reconocida'), 'Debe advertir que no reconoció la fecha');
  assert.ok(sentReplies[3].text.includes('Selecciona la fecha disponible'), 'Debe repetir el menú de fechas');
  state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_DATE', 'Debe mantenerse en AWAITING_DATE');

  // Paso 2 corregido: Elige fecha '2' (Miércoles 5)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '2' }
  });

  assert.equal(sentReplies.length, 5);
  assert.ok(sentReplies[4].text.includes('Nombre Completo'));
  state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_NAME');

  // Paso 3 con error: Postulante escribe números en lugar de nombre ("12345" o solo "?")
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '12345' }
  });

  assert.equal(sentReplies.length, 6);
  assert.ok(sentReplies[5].text.includes('Nombre no reconocido'), 'Debe advertir que el nombre no es válido');
  state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_NAME', 'Debe mantenerse en AWAITING_NAME');

  // Paso 3 con error conversacional: Postulante responde con un saludo ("buenas tardes" o "hola")
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'buenas tardes' }
  });

  assert.equal(sentReplies.length, 7);
  assert.ok(sentReplies[6].text.includes('Nombre no reconocido'), 'Debe advertir que un saludo no es un nombre válido');
  state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_NAME', 'Debe mantenerse en AWAITING_NAME');

  // Paso 3 con error: Postulante responde solo un nombre de 1 palabra ("Carlos")
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Carlos' }
  });

  assert.equal(sentReplies.length, 8);
  assert.ok(sentReplies[7].text.includes('Nombre no reconocido'), 'Debe requerir nombre y apellido completo');
  state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_NAME', 'Debe mantenerse en AWAITING_NAME');

  // Paso 3 corregido: Postulante escribe su nombre real completo
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Gabriela Monzón' }
  });

  assert.equal(sentReplies.length, 9);
  assert.ok(sentReplies[8].text.includes('ENHORABUENA'));
  assert.ok(sentReplies[8].text.includes('Gabriela Monzón'));

  // Verificar en base de datos
  const apt = database.getAppointmentByPhone(cleanPhone);
  assert.ok(apt);
  assert.equal(apt.candidate_name, 'Gabriela Monzón');
  assert.equal(apt.date, '2025-11-05');
});

test('WhatsApp Flow: Rechazo estricto de fechas pausadas (Blindaje de Fechas Inactivas)', async () => {
  const fromJid = '50244332211@s.whatsapp.net';
  const cleanPhone = '50244332211';

  // Pausar fecha 2025-11-04
  database.toggleDate('2025-11-04', false);

  // Iniciar flujo y elegir plaza 1
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Hola' }
  });
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '1' }
  });

  // Intentar elegir la fecha pausada (2025-11-04 o "martes")
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '2025-11-04' }
  });

  const lastReply = sentReplies[sentReplies.length - 1].text;
  assert.ok(lastReply.includes('Opción no reconocida'), 'Debe rechazar la selección de una fecha pausada');
  assert.ok(lastReply.includes('Jueves 5 de Noviembre'), 'Solo debe listar la fecha activa');
  assert.ok(!lastReply.includes('Miércoles 4 de Noviembre'), 'No debe ofrecer la fecha pausada');

  const state = database.getChatState(cleanPhone);
  assert.equal(state.step, 'AWAITING_DATE', 'Debe permanecer en AWAITING_DATE');
});

test('WhatsApp Flow: Fechas Dinámicas - Permite agregar una nueva fecha y seleccionarla en WhatsApp', async () => {
  const fromJid = '50212399999@s.whatsapp.net';

  // Agregar una tercera fecha dinámica en la base de datos
  database.addDate({
    id: '2025-11-06',
    label: 'Jueves 6 de Noviembre',
    short: '06/11'
  });

  // Postulante inicia
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Hola' }
  });

  // Selecciona plaza 2 (Promotor)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '2' }
  });

  // El menú de fechas DEBE incluir la tercera fecha recién agregada
  const dateMenuReply = sentReplies[1].text;
  assert.ok(dateMenuReply.includes('Jueves 6 de Noviembre'), 'El menú debe ofrecer la nueva fecha agregada');
  assert.ok(dateMenuReply.includes('3️⃣'), 'Debe mostrar la opción número 3');

  // Postulante responde "3"
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '3' }
  });

  // Debe confirmar la reserva para el 6 de Noviembre
  assert.ok(sentReplies[2].text.includes('Jueves 6 de Noviembre'));

  // Envía nombre
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Ernesto Valle' }
  });

  const apt = database.getAppointmentByPhone('50212399999');
  assert.ok(apt);
  assert.equal(apt.date, '2025-11-06');
  assert.equal(apt.candidate_name, 'Ernesto Valle');
});

test('WhatsApp Flow: Blindaje Conversacional en AWAITING_PHONE - Repite solicitud de teléfono ante entrada inválida', async () => {
  const lidJid = '999888777666@lid';

  // 1. Iniciar conversación con cuenta LID
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: 'Hola' }
  });

  // 2. Elegir plaza 1
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: '1' }
  });

  // 3. Elegir fecha 1
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: '1' }
  });

  // 4. Enviar nombre
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: 'Ramiro Lemus' }
  });

  const state1 = database.getChatState('999888777666');
  assert.equal(state1.step, 'AWAITING_PHONE');

  // 5. Enviar teléfono inválido (ej: "123" o "no se")
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: '123' }
  });

  const lastReply = sentReplies[sentReplies.length - 1].text;
  assert.ok(lastReply.includes('Número telefónico no reconocido'), 'Debe advertir que el teléfono no es válido');
  assert.ok(lastReply.includes('mínimo 8 dígitos'), 'Debe repetir la instrucción y ejemplo');

  const state2 = database.getChatState('999888777666');
  assert.equal(state2.step, 'AWAITING_PHONE', 'Debe mantenerse en el paso AWAITING_PHONE');

  // 6. Enviar teléfono válido de 8 dígitos
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: lidJid, fromMe: false },
    message: { conversation: '88776655' }
  });

  const successReply = sentReplies[sentReplies.length - 1].text;
  assert.ok(successReply.includes('ENHORABUENA'), 'Debe confirmar la cita exitosamente');
  assert.ok(successReply.includes('Ramiro Lemus'));

  const apt = database.getAppointmentByPhone('50588776655');
  assert.ok(apt);
  assert.equal(apt.candidate_name, 'Ramiro Lemus');
});

// =============================================================================
// REQUISITO R1 & R2: Pruebas de Detección de Intenciones y Redirección de Crédito
// =============================================================================

test('WhatsApp Flow R1: Intenciones de consulta y agendamiento ("info", "informacion", "que necesito", "agendar") activan bienvenida y menú de plazas', async () => {
  // 1. Consulta con "info"
  const jid1 = '50588010001@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: jid1, fromMe: false },
    message: { conversation: 'info' }
  });

  assert.equal(sentReplies.length, 1);
  assert.ok(sentReplies[0].text.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'));
  assert.ok(sentReplies[0].text.includes('Oficial de Crédito'));
  assert.ok(sentReplies[0].text.includes('Promotor de Crédito'));
  assert.ok(sentReplies[0].text.includes('Desembolsador de Crédito'));
  let state1 = database.getChatState('50588010001');
  assert.equal(state1.step, 'AWAITING_POSITION');

  // 2. Consulta con tilde y variantes "información", "¿qué necesito?"
  const jid2 = '50588010002@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: jid2, fromMe: false },
    message: { conversation: 'Buenas tardes, ¿qué necesito para aplicar a las vacantes?' }
  });

  assert.equal(sentReplies.length, 2);
  assert.ok(sentReplies[1].text.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'));
  assert.ok(sentReplies[1].text.includes('Oficial de Crédito'));
  let state2 = database.getChatState('50588010002');
  assert.equal(state2.step, 'AWAITING_POSITION');

  // 3. Intención de agendamiento "agendar"
  const jid3 = '50588010003@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: jid3, fromMe: false },
    message: { conversation: 'agendar' }
  });

  assert.equal(sentReplies.length, 3);
  assert.ok(sentReplies[2].text.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'));
  assert.ok(sentReplies[2].text.includes('Oficial de Crédito'));

  // 4. Extracción desde media caption (imagen con pie de foto)
  const jid4 = '50588010004@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: jid4, fromMe: false },
    message: {
      imageMessage: {
        caption: 'Hola, deseo información sobre los requisitos'
      }
    }
  });

  assert.equal(sentReplies.length, 4);
  assert.ok(sentReplies[3].text.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'));
  assert.ok(sentReplies[3].text.includes('Oficial de Crédito'));

  // 5. Reinicio de estado estancado / abandonado en AWAITING_DATE al enviar "agendar" o "informacion"
  const jid5 = '50588010005@s.whatsapp.net';
  database.saveChatState('50588010005', {
    step: 'AWAITING_DATE',
    selected_position: 'Oficial de Crédito',
    jid: jid5
  });

  await whatsappService.handleIncomingMessage({
    key: { remoteJid: jid5, fromMe: false },
    message: { conversation: 'agendar entrevista' }
  });

  assert.equal(sentReplies.length, 5);
  assert.ok(sentReplies[4].text.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'), 'Debe reiniciar el estado estancado y enviar la bienvenida');
  assert.ok(sentReplies[4].text.includes('Oficial de Crédito'));
  const state5 = database.getChatState('50588010005');
  assert.equal(state5.step, 'AWAITING_POSITION', 'El estado debe quedar en AWAITING_POSITION');
});

test('WhatsApp Flow R1: Postulante avanza fluidamente desde detonador de consulta ("que necesito") hasta cita completada', async () => {
  const fromJid = '50589123456@s.whatsapp.net';

  // Paso 0: Candidato inicia con consulta "que necesito para agendar"
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Hola, ¿qué necesito para agendar?' }
  });

  assert.equal(sentReplies.length, 1);
  assert.ok(sentReplies[0].text.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'));
  assert.ok(sentReplies[0].text.includes('Oficial de Crédito'));

  // Paso 1: Selecciona plaza 1 (Oficial de Crédito)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '1' }
  });

  assert.equal(sentReplies.length, 2);
  assert.ok(sentReplies[1].text.includes('Has seleccionado: *Oficial de Crédito*'));
  assert.ok(sentReplies[1].text.includes('Miércoles 4 de Noviembre'));

  // Paso 2: Selecciona fecha 1 (Miércoles 4 de Noviembre)
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: '1' }
  });

  assert.equal(sentReplies.length, 3);
  assert.ok(sentReplies[2].text.includes('Hemos reservado provisionalmente tu turno'));
  assert.ok(sentReplies[2].text.includes('Nombre Completo'));

  // Paso 3: Envía su nombre completo
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Mario Fernando Castillo' }
  });

  assert.equal(sentReplies.length, 4);
  assert.ok(sentReplies[3].text.includes('ENHORABUENA'), 'Debe generar el pase de entrevista');
  assert.ok(sentReplies[3].text.includes('Mario Fernando Castillo'));
  assert.ok(sentReplies[3].text.includes('Oficial de Crédito'));

  // Verificación en base de datos
  const apt = database.getAppointmentByPhone('50589123456');
  assert.ok(apt, 'La cita debe existir en la base de datos');
  assert.equal(apt.candidate_name, 'Mario Fernando Castillo');
  assert.equal(apt.position, 'Oficial de Crédito');
  assert.equal(apt.date, '2025-11-04');
  assert.equal(apt.status, 'confirmada');
});

test('WhatsApp Flow R2: Intenciones de crédito ("credito", "prestamo", "financiamiento") activan aviso de Call Center sin crear cita ni mostrar menú', async () => {
  const creditJid1 = '50570010001@s.whatsapp.net';

  // 1. Mensaje solicitando crédito
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: creditJid1, fromMe: false },
    message: { conversation: 'Buenas tardes, quiero información sobre un crédito' }
  });

  assert.equal(sentReplies.length, 1);
  const reply1 = sentReplies[0].text;
  assert.ok(reply1.includes('https://wa.me/50558096263'), 'Debe incluir enlace oficial de Call Center');
  assert.ok(reply1.includes('exclusivamente al proceso de selección y entrevistas de trabajo'), 'Debe aclarar que el canal es solo de selección');
  assert.ok(reply1.includes('"EMPLEO"'), 'Debe indicar que responda EMPLEO si busca vacantes');
  assert.ok(!reply1.includes('Oficial de Crédito'), 'NO debe mostrar el menú de plazas');
  assert.ok(!reply1.includes('Promotor de Crédito'), 'NO debe mostrar el menú de plazas');

  // No debe registrar cita ni dejar estado activo
  const apt1 = database.getAppointmentByPhone('50570010001');
  assert.ok(!apt1, 'No debe registrarse ninguna cita para solicitante de crédito');
  const state1 = database.getChatState('50570010001');
  assert.ok(!state1, 'El chat state debe quedar limpio');

  // 2. Mensaje solicitando préstamo
  const creditJid2 = '50570010002@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: creditJid2, fromMe: false },
    message: { conversation: 'Necesito un préstamo urgente' }
  });

  assert.equal(sentReplies.length, 2);
  const reply2 = sentReplies[1].text;
  assert.ok(reply2.includes('https://wa.me/50558096263'));
  assert.ok(!reply2.includes('Oficial de Crédito'));
  assert.ok(!database.getAppointmentByPhone('50570010002'));

  // 3. Mensaje solicitando financiamiento
  const creditJid3 = '50570010003@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: creditJid3, fromMe: false },
    message: { conversation: '¿Ofrecen financiamiento para motos?' }
  });

  assert.equal(sentReplies.length, 3);
  assert.ok(sentReplies[2].text.includes('https://wa.me/50558096263'));
  assert.ok(!database.getAppointmentByPhone('50570010003'));

  // 4. Imagen con pie de foto solicitando préstamo
  const creditJid4 = '50570010004@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: creditJid4, fromMe: false },
    message: {
      imageMessage: {
        caption: 'Requisitos para un préstamo personal'
      }
    }
  });

  assert.equal(sentReplies.length, 4);
  assert.ok(sentReplies[3].text.includes('https://wa.me/50558096263'));
  assert.ok(!database.getAppointmentByPhone('50570010004'));

  // 5. Usuario redirigido responde "EMPLEO" -> ahora sí ingresa al flujo de contratación
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: creditJid1, fromMe: false },
    message: { conversation: 'EMPLEO' }
  });

  assert.equal(sentReplies.length, 5);
  const replyRecruit = sentReplies[4].text;
  assert.ok(replyRecruit.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'));
  assert.ok(replyRecruit.includes('Oficial de Crédito'));
  const stateRecruit = database.getChatState('50570010001');
  assert.equal(stateRecruit.step, 'AWAITING_POSITION');
});

test('WhatsApp Flow R2: Desambiguación - Postulante que menciona "vacante oficial de credito" avanza a reclutamiento sin redirección de crédito', async () => {
  // 1. Postulante menciona "vacante de oficial de crédito"
  const jid1 = '50566010001@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: jid1, fromMe: false },
    message: { conversation: 'Buenas tardes, me interesa la vacante de oficial de crédito' }
  });

  assert.equal(sentReplies.length, 1);
  const reply1 = sentReplies[0].text;
  assert.ok(reply1.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'), 'Debe recibir la bienvenida de RRHH');
  assert.ok(reply1.includes('Oficial de Crédito'), 'Debe mostrar menú de plazas');
  assert.ok(!reply1.includes('https://wa.me/50558096263'), 'NO debe redirigir a Call Center');

  // 2. Postulante menciona "postulación para promotor de crédito"
  const jid2 = '50566010002@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: jid2, fromMe: false },
    message: { conversation: 'Postulación para plaza de promotor de crédito' }
  });

  assert.equal(sentReplies.length, 2);
  const reply2 = sentReplies[1].text;
  assert.ok(reply2.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'));
  assert.ok(!reply2.includes('https://wa.me/50558096263'));

  // 3. Postulante envía CV para desembolsador de crédito
  const jid3 = '50566010003@s.whatsapp.net';
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: jid3, fromMe: false },
    message: {
      documentMessage: {
        caption: 'Envío mi CV para desembolsador de crédito'
      }
    }
  });

  assert.equal(sentReplies.length, 3);
  const reply3 = sentReplies[2].text;
  assert.ok(reply3.includes('¡Hola! Te damos la bienvenida a *AlfaCredit S.A.*'));
  assert.ok(!reply3.includes('https://wa.me/50558096263'));
});

test('WhatsApp Flow R1 & R2: Candidato con cita existente que consulta sobre créditos recibe aviso de Call Center sin alterar su cita', async () => {
  const fromJid = '50577889900@s.whatsapp.net';

  // Registrar cita previa para este candidato
  const existingApt = database.createAppointment({
    candidate_name: 'Daniela Kassandra Molina',
    phone_number: '50577889900',
    position: 'Promotor de Crédito',
    date: '2025-11-04',
    time_slot: '10:00'
  });

  // Candidato escribe preguntando por un crédito
  await whatsappService.handleIncomingMessage({
    key: { remoteJid: fromJid, fromMe: false },
    message: { conversation: 'Hola, ¿también otorgan préstamos personales?' }
  });

  assert.equal(sentReplies.length, 1);
  const reply = sentReplies[0].text;
  assert.ok(reply.includes('https://wa.me/50558096263'), 'Debe redirigir a Call Center');

  // Su cita previa sigue intacta
  const aptCheck = database.getAppointmentById(existingApt.id);
  assert.equal(aptCheck.status, 'confirmada');
  assert.equal(aptCheck.candidate_name, 'Daniela Kassandra Molina');
  assert.equal(aptCheck.position, 'Promotor de Crédito');
});
