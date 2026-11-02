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

test('Scheduler: getNearestAvailableSlot encuentra el turno con menor distancia en minutos', () => {
  const origGetAvailable = scheduler.getAvailableSlots;
  try {
    // 1. Coincidencia exacta
    scheduler.getAvailableSlots = () => ['08:30', '09:00', '09:15', '09:30', '10:00'];
    assert.equal(scheduler.getNearestAvailableSlot('2025-11-04', '09:00'), '09:00', 'Coincidencia exacta');

    // 2. Turno anterior más próximo vs turno posterior
    // Target 09:10 -> 09:00 (10m) vs 09:15 (5m) -> 09:15
    scheduler.getAvailableSlots = () => ['08:30', '09:00', '09:15', '10:00'];
    assert.equal(scheduler.getNearestAvailableSlot('2025-11-04', '09:10'), '09:15', 'Más cercano posterior');

    // Target 09:05 -> 09:00 (5m) vs 09:15 (10m) -> 09:00
    assert.equal(scheduler.getNearestAvailableSlot('2025-11-04', '09:05'), '09:00', 'Más cercano anterior');

    // 3. Empate de distancia: debe preferir el turno posterior (+15m)
    // Target 09:00 con 08:45 (-15m) y 09:15 (+15m)
    scheduler.getAvailableSlots = () => ['08:30', '08:45', '09:15', '09:30'];
    assert.equal(scheduler.getNearestAvailableSlot('2025-11-04', '09:00'), '09:15', 'Empate prefiere turno posterior (+15m)');

    // 4. Límites al inicio y fin del día
    scheduler.getAvailableSlots = () => ['08:45', '09:00', '17:00'];
    assert.equal(scheduler.getNearestAvailableSlot('2025-11-04', '07:00'), '08:45', 'Límite inicio de jornada');
    assert.equal(scheduler.getNearestAvailableSlot('2025-11-04', '18:30'), '17:00', 'Límite fin de jornada');

    // 5. Día completamente agotado (sin cupos disponibles)
    scheduler.getAvailableSlots = () => [];
    assert.equal(scheduler.getNearestAvailableSlot('2025-11-04', '09:00'), null, 'Retorna null si no hay turnos disponibles');
  } finally {
    scheduler.getAvailableSlots = origGetAvailable;
  }
});

test('Scheduler: getNearestAvailableSlot con base de datos real calcula correctamente ante turnos tomados', () => {
  const database = require('../src/database');
  const testDate = '2025-11-04';
  const available = scheduler.getAvailableSlots(testDate);
  if (available.length > 0) {
    const firstFree = available[0];
    const nearest = scheduler.getNearestAvailableSlot(testDate, firstFree);
    assert.equal(nearest, firstFree, 'Turno libre debe coincidir consigo mismo');
  }
});
