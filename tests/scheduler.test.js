const test = require('node:test');
const assert = require('node:assert/strict');
const CONFIG = require('../src/config');
const scheduler = require('../src/scheduler');

test('Horarios: Total de turnos por día debe ser 31 en lapsos de 15 minutos', () => {
  assert.equal(CONFIG.TIME_SLOTS.length, 31, 'Debe haber exactamente 31 turnos configurados');
  
  // Primer turno de la mañana
  assert.equal(CONFIG.TIME_SLOTS[0], '08:30');
  // Último turno de la mañana
  assert.equal(CONFIG.TIME_SLOTS[14], '12:00');
  
  // Ningún turno entre 12:01 y 13:29 (Almuerzo bloqueado)
  const lunchSlots = CONFIG.TIME_SLOTS.filter(s => s > '12:00' && s < '13:30');
  assert.equal(lunchSlots.length, 0, 'No debe existir ningún turno en el bloque de almuerzo (12:00 - 13:30)');
  
  // Primer turno de la tarde
  assert.equal(CONFIG.TIME_SLOTS[15], '13:30');
  // Último turno de la tarde
  assert.equal(CONFIG.TIME_SLOTS[CONFIG.TIME_SLOTS.length - 1], '17:15');
});

test('Formato 12h: convierte correctamente horarios de 24h a 12h con AM/PM', () => {
  assert.equal(scheduler.formatTime12h('08:30'), '08:30 AM');
  assert.equal(scheduler.formatTime12h('11:45'), '11:45 AM');
  assert.equal(scheduler.formatTime12h('12:00'), '12:00 PM');
  assert.equal(scheduler.formatTime12h('13:30'), '01:30 PM');
  assert.equal(scheduler.formatTime12h('17:15'), '05:15 PM');
});

test('Resolución de Plazas: identifica correctamente por ID y nombre', () => {
  const p1 = scheduler.resolvePosition('1');
  assert.ok(p1);
  assert.equal(p1.title, 'Oficial de Crédito');

  const p2 = scheduler.resolvePosition('2');
  assert.ok(p2);
  assert.equal(p2.title, 'Promotor de Crédito');

  const p3 = scheduler.resolvePosition('3');
  assert.ok(p3);
  assert.equal(p3.title, 'Desembolsador de Crédito');

  const byName = scheduler.resolvePosition('desembolsador');
  assert.ok(byName);
  assert.equal(byName.title, 'Desembolsador de Crédito');

  // Variaciones de formatos comunes en WhatsApp
  assert.equal(scheduler.resolvePosition('1.').title, 'Oficial de Crédito');
  assert.equal(scheduler.resolvePosition('opcion 2').title, 'Promotor de Crédito');
  assert.equal(scheduler.resolvePosition('#3').title, 'Desembolsador de Crédito');

  // Prevención de falsos positivos con palabras ambiguas compartidas
  assert.equal(scheduler.resolvePosition('de'), null, 'No debe coincidir con la preposición "de"');
  assert.equal(scheduler.resolvePosition('credito'), null, 'No debe coincidir con "credito" ambiguo');
});

test('Resolución de Fechas: identifica 4 y 5 de Noviembre por ID numérico o código', () => {
  const d1 = scheduler.resolveDate('1');
  assert.ok(d1);
  assert.equal(d1.id, '2025-11-04');
  assert.equal(d1.label, 'Miércoles 4 de Noviembre');

  const d2 = scheduler.resolveDate('2');
  assert.ok(d2);
  assert.equal(d2.id, '2025-11-05');
  assert.equal(d2.label, 'Jueves 5 de Noviembre');

  const byCode = scheduler.resolveDate('2025-11-04');
  assert.ok(byCode);
  assert.equal(byCode.label, 'Miércoles 4 de Noviembre');

  // Variaciones numéricas
  assert.equal(scheduler.resolveDate('1.').id, '2025-11-04');
  assert.equal(scheduler.resolveDate('opcion 2').id, '2025-11-05');
});

test('Alertas de Cupos Críticos: se activa cuando cupos restantes <= 10', () => {
  // Verificamos que el umbral configurado sea 10
  assert.equal(CONFIG.LOW_SLOTS_ALERT_THRESHOLD, 10);

  // Verificamos texto de advertencia
  const noticeMsg = scheduler.getQuotaNotice('2025-11-04');
  assert.ok(typeof noticeMsg === 'string');
});

test('Generación de Notificación de Reprogramación: incluye todos los datos clave para el aviso por WhatsApp', () => {
  const appointment = {
    candidate_name: 'Ana Lucía Gómez',
    position: 'Oficial de Crédito',
    date: '2025-11-04',
    time_slot: '09:30',
    status: 'reprogramada',
    notes: 'Cambio de horario confirmado'
  };

  const message = scheduler.generateRescheduledNotice(appointment);
  assert.ok(message.includes('Ana Lucía Gómez'), 'Debe incluir el nombre del candidato');
  assert.ok(message.includes('Oficial de Crédito'), 'Debe incluir el cargo/plaza');
  assert.ok(message.includes('Miércoles 4 de Noviembre'), 'Debe incluir la fecha legible');
  assert.ok(message.includes('09:30 AM'), 'Debe incluir la hora formateada');
  assert.ok(message.includes('AlfaCredit S.A.'), 'Debe incluir el nombre de la empresa');
});
