const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const WebSocket = require('ws');
const ExcelJS = require('exceljs');

const CONFIG = require('./config');
const database = require('./database');
const scheduler = require('./scheduler');
const whatsappService = require('./whatsapp');

const fs = require('fs');

const isServerless = Boolean(process.env.SERVERLESS);
const app = express();
const server = isServerless ? null : http.createServer(app);
const wss = isServerless ? null : new WebSocket.Server({ server });
const { confirmationProtocol, CONFIRMATION_VARIANTS } = require('./confirmation-protocol');

function getPublicDir() {
  const candidates = [
    path.join(__dirname, 'public'),
    path.join(process.cwd(), 'src', 'public'),
    path.join(process.cwd(), 'public')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(__dirname, 'public');
}
const publicDir = getPublicDir();

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(publicDir));

// Difusión por WebSocket a clientes del panel
function broadcast(eventType, data) {
  if (!wss) return;
  const payload = JSON.stringify({ event: eventType, data, timestamp: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        console.error('Error enviando WebSocket a cliente:', err);
      }
    }
  });
}

// Conectar emisor del protocolo de confirmación al WebSocket
confirmationProtocol.setBroadcast(broadcast);

// Suscribir eventos de WhatsApp para reenviar al panel si WebSocket está disponible
if (wss) {
  whatsappService.onEvent((type, data) => {
    broadcast(type, data);
    if (type === 'new_appointment') {
      broadcast('stats_updated', database.getStats());
    }
  });
}

let activePublicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || null;
let tunnelProcess = null;

function getPublicUrl() {
  return activePublicUrl || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || null;
}

// WebSocket conexión inicial (solo en modo servidor no-serverless)
if (wss) {
  wss.on('connection', (ws) => {
    // Enviar estado actual de WhatsApp y estadísticas inmediatamente
    ws.send(JSON.stringify({
      event: 'init_state',
      data: {
        whatsapp: whatsappService.getStatus(),
        stats: database.getStats(),
        config: {
          dates: database.listDates(),
          positions: CONFIG.POSITIONS,
          timeSlots: CONFIG.TIME_SLOTS,
          threshold: CONFIG.LOW_SLOTS_ALERT_THRESHOLD,
          companyName: CONFIG.COMPANY_NAME,
          publicUrl: getPublicUrl()
        }
      }
    }));
  });
}

// ==========================================
// RUTAS DE LA API REST
// ==========================================

// 1. Estado y configuración
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    whatsapp: whatsappService.getStatus(),
    stats: database.getStats(),
    config: {
      dates: database.listDates(),
      positions: CONFIG.POSITIONS,
      timeSlots: CONFIG.TIME_SLOTS,
      threshold: CONFIG.LOW_SLOTS_ALERT_THRESHOLD,
      companyName: CONFIG.COMPANY_NAME,
      publicUrl: getPublicUrl()
    }
  });
});

// 1b. Consultar URL pública del túnel activo
app.get('/api/tunnel', (req, res) => {
  const pub = getPublicUrl();
  res.json({
    success: true,
    publicUrl: pub,
    agendarUrl: pub ? `${pub.replace(/\/$/, '')}/agendar` : null
  });
});

// 2. Estadísticas y alertas de cupos
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    stats: database.getStats()
  });
});

// 3. Consultar turnos disponibles para una fecha
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ success: false, error: 'Parámetro date es requerido' });
  }

  const available = scheduler.getAvailableSlots(date);
  const taken = database.getTakenSlotsForDate(date);
  const remaining = scheduler.getRemainingCount(date);
  const isCritical = scheduler.isCriticalRemaining(date);
  const isExhausted = scheduler.isExhausted(date);

  res.json({
    success: true,
    date,
    label: scheduler.getDateLabel(date),
    available,
    taken,
    remaining,
    isCritical,
    isExhausted,
    allSlots: CONFIG.TIME_SLOTS
  });
});

// Helper para normalizar citas (garantiza que phone_number siempre sea un teléfono real y no un @lid)
function normalizeAppointment(apt) {
  if (!apt) return null;
  const resolvedPhone = typeof database.resolvePhoneNumber === 'function'
    ? database.resolvePhoneNumber(apt.phone_number, apt.jid)
    : apt.phone_number;
  const digits = CONFIG.normalizePhone(resolvedPhone);
  const ticketMsg = apt.status === 'cancelada' || apt.status === 'reprogramada'
    ? scheduler.generateRescheduledNotice({ ...apt, phone_number: resolvedPhone })
    : `🎉 *¡SU ENTREVISTA ESTÁ CONFIRMADA EN ALFACREDIT S.A.!*\n\n` + scheduler.generateTicket({ ...apt, phone_number: resolvedPhone });
  const wa_link = digits && digits.length >= 8 && digits.length <= 12
    ? `https://wa.me/${digits}?text=${encodeURIComponent(ticketMsg)}`
    : null;
  return {
    ...apt,
    phone_number: resolvedPhone,
    wa_link
  };
}

// 4. Listar citas con filtros y búsqueda
app.get('/api/appointments', (req, res) => {
  const { search, date, position, status } = req.query;
  const list = database.listAppointments({ search, date, position, status });
  const normalized = list.map(normalizeAppointment);
  res.json({ success: true, count: normalized.length, appointments: normalized });
});

// Alias /api/citas requerido por R3
app.get('/api/citas', (req, res) => {
  const { search, date, position, status } = req.query;
  const list = database.listAppointments({ search, date, position, status });
  const normalized = list.map(normalizeAppointment);
  res.json({ success: true, count: normalized.length, appointments: normalized });
});

// 5. Obtener una cita específica
app.get('/api/appointments/:id', (req, res) => {
  const appointment = database.getAppointmentById(req.params.id);
  if (!appointment) {
    return res.status(404).json({ success: false, error: 'Cita no encontrada' });
  }
  res.json({ success: true, appointment: normalizeAppointment(appointment) });
});

// Alias /api/citas/:id requerido por R3
app.get('/api/citas/:id', (req, res) => {
  const appointment = database.getAppointmentById(req.params.id);
  if (!appointment) {
    return res.status(404).json({ success: false, error: 'Cita no encontrada' });
  }
  const normalized = normalizeAppointment(appointment);
  res.json({ success: true, appointment: normalized, cita: normalized });
});

// 6. Crear cita manualmente desde el panel
app.post('/api/appointments', async (req, res) => {
  try {
    const { candidate_name, phone_number, position, date, time_slot, notes, sendNotification = true } = req.body;

    if (!candidate_name || !phone_number || !position || !date || !time_slot) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }

    const validPositions = CONFIG.POSITIONS.map(p => p.title);
    if (!validPositions.includes(position.trim())) {
      return res.status(400).json({ success: false, error: `Plaza no válida. Las plazas permitidas son: ${validPositions.join(', ')}` });
    }

    if (database.isSlotTaken(date, time_slot)) {
      return res.status(409).json({ success: false, error: `El turno ${time_slot} del ${date} ya está ocupado.` });
    }

    const appointment = database.createAppointment({
      candidate_name,
      phone_number,
      position,
      date,
      time_slot,
      notes: notes || 'Creada manualmente desde el panel administrativo'
    });

    let notificationSent = false;
    let notificationError = null;

    if (sendNotification) {
      const ticket = scheduler.generateTicket(appointment);
      const text = `🎉 *¡SU CITA HA SIDO AGENDADA!*\n\n` + ticket;
      const sendRes = await whatsappService.sendMessage(appointment.phone_number, text);
      if (sendRes.success) {
        database.markNotified(appointment.id);
        notificationSent = true;
      } else {
        notificationError = sendRes.error;
      }
    }

    broadcast('appointment_created', appointment);
    broadcast('stats_updated', database.getStats());

    res.status(201).json({
      success: true,
      appointment: normalizeAppointment(appointment),
      notificationSent,
      notificationError
    });
  } catch (err) {
    console.warn('Error validando/creando cita:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// 7. EDITAR Y REPROGRAMAR CUALQUIER DATO CON AVISO AUTOMÁTICO VÍA WHATSAPP
app.put('/api/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      candidate_name,
      phone_number,
      position,
      date,
      time_slot,
      status,
      notes,
      notifyCandidate = true
    } = req.body;

    const current = database.getAppointmentById(id);
    if (!current) {
      return res.status(404).json({ success: false, error: `Cita con ID ${id} no encontrada` });
    }

    if (position) {
      const validPositions = CONFIG.POSITIONS.map(p => p.title);
      if (!validPositions.includes(position.trim())) {
        return res.status(400).json({ success: false, error: `Plaza no válida. Las plazas permitidas son: ${validPositions.join(', ')}` });
      }
    }

    // Actualizar en base de datos
    const updated = database.updateAppointment(id, {
      candidate_name,
      phone_number,
      position,
      date,
      time_slot,
      status,
      notes
    });

    let notificationSent = false;
    let notificationError = null;

    // AVISAR A LA PERSONA POR WHATSAPP AUTOMÁTICAMENTE
    const targetRecipient = updated.jid || updated.phone_number;
    if (notifyCandidate && targetRecipient) {
      const noticeMessage = scheduler.generateRescheduledNotice(updated);
      const sendRes = await whatsappService.sendMessage(targetRecipient, noticeMessage);

      if (sendRes.success) {
        database.markNotified(updated.id);
        notificationSent = true;
        database.logAction('NOTIFICATION_SENT', updated.id, `Aviso enviado con éxito a ${targetRecipient}`);
      } else {
        notificationError = sendRes.error;
        database.logAction('NOTIFICATION_FAILED', updated.id, `Fallo al enviar a ${targetRecipient}: ${sendRes.error}`);
      }
    }

    broadcast('appointment_updated', updated);
    broadcast('stats_updated', database.getStats());

    res.json({
      success: true,
      message: 'Cita actualizada y reprogramada correctamente',
      appointment: normalizeAppointment(updated),
      notificationSent,
      notificationError
    });
  } catch (err) {
    console.error('Error al editar/reprogramar cita:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// 8. Cancelar cita
app.delete('/api/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, notifyCandidate = true } = req.body || {};

    const appointment = database.cancelAppointment(id, reason || 'Cancelada por el administrador');

    let notificationSent = false;
    const cancelRecipient = appointment.jid || appointment.phone_number;
    if (notifyCandidate && cancelRecipient) {
      const cancelNotice = scheduler.generateRescheduledNotice(appointment);
      const sendRes = await whatsappService.sendMessage(cancelRecipient, cancelNotice);
      if (sendRes.success) {
        database.markNotified(appointment.id);
        notificationSent = true;
      }
    }

    broadcast('appointment_cancelled', appointment);
    broadcast('stats_updated', database.getStats());

    res.json({
      success: true,
      message: 'Cita cancelada y cupo liberado',
      appointment: normalizeAppointment(appointment),
      notificationSent
    });
  } catch (err) {
    console.error('Error cancelando cita:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// 9. Reenviar mensaje de notificación manual
app.post('/api/whatsapp/notify/:id', async (req, res) => {
  try {
    const appointment = database.getAppointmentById(req.params.id);
    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Cita no encontrada' });
    }

    let message;
    if (appointment.status === 'cancelada') {
      message = scheduler.generateRescheduledNotice(appointment);
    } else if (appointment.status === 'reprogramada') {
      message = scheduler.generateRescheduledNotice(appointment);
    } else {
      const ticket = scheduler.generateTicket(appointment);
      message = `📢 *RECORDATORIO DE SU ENTREVISTA - ALFACREDIT S.A.*\n\n` + ticket;
    }

    const targetRecipient = appointment.jid || appointment.phone_number;
    const sendRes = await whatsappService.sendMessage(targetRecipient, message);

    if (sendRes.success) {
      database.markNotified(appointment.id);
      database.logAction('NOTIFICATION_RESENT', appointment.id, `Reenvío manual a ${appointment.phone_number}`);
      return res.json({ success: true, message: 'Mensaje enviado exitosamente vía WhatsApp' });
    } else {
      return res.status(500).json({ success: false, error: sendRes.error || 'No se pudo enviar el mensaje' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Reiniciar servicio de WhatsApp o desvincular
app.post('/api/whatsapp/restart', async (req, res) => {
  try {
    whatsappService.paused = false;
    whatsappService.reconnectAttempts = 0;
    whatsappService.lastDisconnectReason = null;
    await whatsappService.disconnect();
    setTimeout(() => {
      whatsappService.start();
    }, 1500);
    res.json({ success: true, message: 'Reconexión iniciada' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10a. Pausar o Reanudar Bot de WhatsApp (Modo Seguro Anti-Bloqueo)
app.post('/api/whatsapp/pause', async (req, res) => {
  try {
    const { paused = true } = req.body || {};
    const status = await whatsappService.setPaused(Boolean(paused));
    res.json({
      success: true,
      paused: status.paused,
      whatsapp: status,
      message: status.paused
        ? 'Bot de WhatsApp en pausa (Modo Seguro Anti-Bloqueo).'
        : 'Bot de WhatsApp reanudado.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10b. Solicitar código de vinculación de 8 dígitos por número telefónico (Pairing Code)
app.post('/api/whatsapp/pairing-code', async (req, res) => {
  try {
    const { phone_number, phoneNumber } = req.body || {};
    const code = await whatsappService.requestPairingCode(phone_number || phoneNumber);
    res.json({
      success: true,
      pairingCode: code,
      message: `Código generado: ${code}. Ingresa en tu WhatsApp > Dispositivos vinculados > Vincular con el número de teléfono.`
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 10c. Restaurar sesión activa de WhatsApp en el servidor
app.post('/api/whatsapp/session-restore', express.json({ limit: '15mb' }), async (req, res) => {
  try {
    const crypto = require('crypto');
    const fs = require('fs');
    const hash = crypto.createHash('sha256').update(String(req.headers['x-sync-key'] || '')).digest('hex');
    if (hash !== 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9') {
      return res.status(403).json({ success: false, error: 'No autorizado' });
    }
    const { files } = req.body || {};
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ success: false, error: 'Archivos de sesión requeridos' });
    }
    await whatsappService.disconnect();
    fs.rmSync(CONFIG.AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      if (!name.includes('..') && !name.includes('/') && !name.includes('\\')) {
        fs.writeFileSync(path.join(CONFIG.AUTH_DIR, name), content, 'utf8');
      }
    }
    setTimeout(() => whatsappService.start(), 500);
    res.json({ success: true, count: Object.keys(files).length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10d. Portal Web Público de Auto-Agendamiento para Postulantes (Plan B 0% riesgo de bloqueo de WhatsApp)
app.post('/api/public/agendar', async (req, res) => {
  try {
    const { candidate_name, phone_number, position, date, time_slot } = req.body || {};
    const nameClean = String(candidate_name || '').trim();
    const phoneDigits = String(phone_number || '').replace(/[^0-9]/g, '');

    if (!whatsappService.isValidCandidateName(nameClean)) {
      return res.status(400).json({
        success: false,
        error: 'Por favor ingresa tu Nombre y Apellido completo (ej: Carlos Roberto Mendoza).'
      });
    }
    if (phoneDigits.length < 8 || phoneDigits.length > 15) {
      return res.status(400).json({
        success: false,
        error: 'Por favor ingresa un número de teléfono o WhatsApp válido de al menos 8 dígitos.'
      });
    }

    const posObj = scheduler.resolvePosition(position) || CONFIG.POSITIONS.find(p => p.title === String(position || '').trim());
    if (!posObj) {
      return res.status(400).json({
        success: false,
        error: 'Por favor selecciona una plaza válida.'
      });
    }

    const dateObj = scheduler.resolveDate(date);
    if (!dateObj) {
      return res.status(400).json({
        success: false,
        error: 'Por favor selecciona una fecha de entrevista disponible.'
      });
    }

    const prior = database.getAppointmentByPhone(phoneDigits);

    // Si ya tenía una cita previa activa con ese teléfono, liberarla antes de asignar el nuevo turno
    if (prior) {
      database.cancelAppointment(prior.id, 'Reprogramada por el postulante desde portal web /agendar');
    }

    const rawSlot = time_slot ? String(time_slot).trim() : null;
    const requestedSlot = (rawSlot && CONFIG.TIME_SLOTS.includes(rawSlot)) ? rawSlot : null;
    const targetSlot = requestedSlot || (prior && prior.date === dateObj.id ? prior.time_slot : '08:30');

    let chosenSlot;
    if (requestedSlot && !database.isSlotTaken(dateObj.id, requestedSlot)) {
      chosenSlot = requestedSlot;
    } else {
      chosenSlot = scheduler.getNearestAvailableSlot(dateObj.id, targetSlot) || scheduler.getNextAvailableSlot(dateObj.id);
    }

    if (!chosenSlot) {
      return res.status(409).json({
        success: false,
        error: `Lo sentimos, los cupos para el ${dateObj.label} se han agotado. Por favor elige otra fecha disponible.`
      });
    }

    let appointment = null;
    let attempts = 0;
    const maxAttempts = 5;

    while (!appointment && attempts < maxAttempts) {
      attempts++;
      try {
        appointment = database.createAppointment({
          candidate_name: nameClean,
          phone_number: phoneDigits,
          position: posObj.title,
          date: dateObj.id,
          time_slot: chosenSlot,
          notes: prior ? `Reprogramada vía Portal Web (/agendar) desde cita #${prior.id}` : 'Agendado por el postulante vía Portal Web (/agendar)'
        });
      } catch (err) {
        if (err.message && err.message.includes('ya se encuentra ocupado')) {
          chosenSlot = scheduler.getNearestAvailableSlot(dateObj.id, targetSlot) || scheduler.getNextAvailableSlot(dateObj.id);
          if (!chosenSlot) {
            return res.status(409).json({
              success: false,
              error: `Lo sentimos, los cupos para el ${dateObj.label} se han agotado. Por favor elige otra fecha disponible.`
            });
          }
        } else {
          throw err;
        }
      }
    }

    if (!appointment) {
      return res.status(409).json({
        success: false,
        error: `No se pudo asignar un turno disponible debido a alta concurrencia. Por favor reintenta.`
      });
    }

    const ticket = scheduler.generateTicket(appointment);
    const normalized = normalizeAppointment(appointment);

    broadcast('new_appointment', normalized);
    broadcast('stats_updated', database.getStats());

    res.status(201).json({
      success: true,
      appointment: normalized,
      ticket,
      dateLabel: scheduler.getDateLabel(appointment.date),
      time12h: scheduler.formatTime12h(appointment.time_slot),
      location: CONFIG.LOCATION
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==========================================
// GESTIÓN DINÁMICA DE FECHAS DE ENTREVISTA
// ==========================================

// 11. Listar fechas registradas
app.get('/api/dates', (req, res) => {
  try {
    const dates = database.listDates();
    res.json({ success: true, count: dates.length, dates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Agregar nueva fecha
app.post('/api/dates', (req, res) => {
  try {
    const { id, label, short } = req.body || {};
    if (!id || !label) {
      return res.status(400).json({ success: false, error: 'Fecha (id) y etiqueta (label) son obligatorios' });
    }
    const newDate = database.addDate({ id, label, short });
    broadcast('dates_updated', database.listDates());
    broadcast('stats_updated', database.getStats());
    res.status(201).json({ success: true, date: newDate });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 13. Activar/Desactivar o editar fecha
app.patch('/api/dates/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, label, short } = req.body || {};
    let updated;
    if (is_active !== undefined) {
      updated = database.toggleDate(id, is_active);
    } else {
      updated = database.updateDate(id, { label, short, is_active });
    }
    broadcast('dates_updated', database.listDates());
    broadcast('stats_updated', database.getStats());
    res.json({ success: true, date: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==========================================
// PROTOCOLO DE CONFIRMACIÓN DE CITAS EN TIEMPO REAL
// ==========================================

// Estado del protocolo de confirmación
app.get('/api/confirmation-protocol/status', (req, res) => {
  try {
    const status = confirmationProtocol.getStatus();
    res.json({
      success: true,
      ...status,
      variants: CONFIRMATION_VARIANTS.map(v => ({ id: v.id, code: v.code, title: v.title }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Listado de candidatos a confirmar (con filtros all, pending, sent)
app.get('/api/confirmation-protocol/candidates', (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const candidates = confirmationProtocol.getCandidates(filter);
    const stats = database.getConfirmationStats();
    res.json({
      success: true,
      count: candidates.length,
      candidates,
      stats
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Iniciar protocolo de confirmación en segundo plano
app.post('/api/confirmation-protocol/start', async (req, res) => {
  try {
    const { delayMinMs, delayMaxMs, dryRun, variantRotation } = req.body || {};
    const result = await confirmationProtocol.startProtocol({
      delayMinMs,
      delayMaxMs,
      dryRun: Boolean(dryRun),
      variantRotation
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pausar protocolo
app.post('/api/confirmation-protocol/pause', (req, res) => {
  try {
    const result = confirmationProtocol.pauseProtocol();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reanudar protocolo
app.post('/api/confirmation-protocol/resume', (req, res) => {
  try {
    const result = confirmationProtocol.resumeProtocol();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Detener protocolo
app.post('/api/confirmation-protocol/stop', (req, res) => {
  try {
    const result = confirmationProtocol.stopProtocol();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Enviar confirmación a un candidato individual
app.post('/api/confirmation-protocol/send-single', async (req, res) => {
  try {
    const { appointment_id, variant_id, dryRun, force } = req.body || {};
    if (!appointment_id) {
      return res.status(400).json({ success: false, error: 'appointment_id es requerido' });
    }
    const result = await confirmationProtocol.sendSingle(appointment_id, {
      variantId: variant_id,
      dryRun: Boolean(dryRun),
      force: Boolean(force)
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==========================================
// SISTEMA DE RESPALDO Y DESCARGA
// ==========================================

// 14. Descargar copia de seguridad en caliente (.sqlite)
app.get('/api/backup/download', (req, res) => {
  try {
    const backupFile = database.createBackup();
    const filename = path.basename(backupFile);
    res.download(backupFile, filename, (err) => {
      if (err && !res.headersSent) {
        console.error('Error enviando archivo de backup:', err);
        res.status(500).json({ success: false, error: err.message });
      }
    });
  } catch (err) {
    console.error('Error generando copia de seguridad:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15. EXPORTACIÓN PROFESIONAL A EXCEL (.xlsx) - LISTA DE ASISTENCIA Y CONTROL POR FECHA
app.get('/api/export/excel', async (req, res) => {
  try {
    const allAppointments = database.listAppointments();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AlfaCredit S.A. - Talento Humano';
    workbook.lastModifiedBy = 'AlfaCredit S.A. - Sistema AlfaRespuestas';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Obtener lista completa de fechas a incluir
    const configuredDates = database.listDates();
    const dateMap = new Map();
    for (const d of configuredDates) {
      dateMap.set(d.id, d.label);
    }
    for (const apt of allAppointments) {
      if (!dateMap.has(apt.date)) {
        dateMap.set(apt.date, scheduler.getDateLabel(apt.date) || apt.date);
      }
    }

    const sortedDateIds = Array.from(dateMap.keys()).sort();

    // Paleta Corporativa AlfaCredit
    const COLORS = {
      NAVY_PRIMARY: 'FF1E3A8A',     // Azul Marino Corporativo
      NAVY_DARK: 'FF0F172A',        // Slate / Navy Oscuro para encabezados de tabla
      BLUE_ACCENT: 'FF2563EB',      // Azul Vibrante para subtítulos
      BG_LIGHT: 'FFF8FAFC',         // Fondo alterno suave
      BG_WHITE: 'FFFFFFFF',         // Blanco
      BORDER_THIN: 'FFCBD5E1',      // Borde sutil slate
      BORDER_MEDIUM: 'FF94A3B8',    // Borde medio para divisiones y firma
      TEXT_DARK: 'FF0F172A',        // Texto principal
      TEXT_MUTED: 'FF475569',       // Texto secundario
      CONFIRMED_TEXT: 'FF166534',   // Verde oscuro
      CONFIRMED_BG: 'FFDCFCE7',     // Verde pastel
      PENDING_TEXT: 'FF475569',     // Slate
      PENDING_BG: 'FFF1F5F9',       // Slate claro
      CANCELLED_TEXT: 'FF991B1B',   // Rojo oscuro
      CANCELLED_BG: 'FFFEE2E2',     // Rojo pastel
      ERROR_TEXT: 'FF854D0E',       // Ámbar oscuro
      ERROR_BG: 'FFFEF9C3'          // Ámbar pastel
    };

    // Helper para nombre de hoja válido y descriptivo
    function formatSheetTabName(dateId, dateLabel) {
      const parts = String(dateId).split('-');
      const day = parts[2] || '01';
      const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
      const monthIdx = parseInt(parts[1], 10) - 1;
      const monthStr = monthNames[monthIdx] || 'Nov';
      const year = parts[0] || '2025';

      let dayOfWeek = '';
      const norm = (dateLabel || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (norm.includes('miercoles')) dayOfWeek = 'Miércoles';
      else if (norm.includes('jueves')) dayOfWeek = 'Jueves';
      else if (norm.includes('viernes')) dayOfWeek = 'Viernes';
      else if (norm.includes('martes')) dayOfWeek = 'Martes';
      else if (norm.includes('lunes')) dayOfWeek = 'Lunes';
      else if (norm.includes('sabado')) dayOfWeek = 'Sábado';
      else if (norm.includes('domingo')) dayOfWeek = 'Domingo';

      let title = `${day}-${monthStr}-${year}`;
      if (dayOfWeek) title += ` (${dayOfWeek})`;
      return title.replace(/[:\\/?*\[\]]/g, '').slice(0, 31);
    }

    const dateListToProcess = sortedDateIds.length > 0 ? sortedDateIds : ['2025-11-04'];

    for (const dateId of dateListToProcess) {
      const dateLabel = dateMap.get(dateId) || scheduler.getDateLabel(dateId) || dateId;
      const sheetName = formatSheetTabName(dateId, dateLabel);

      const worksheet = workbook.addWorksheet(sheetName, {
        pageSetup: {
          orientation: 'landscape',
          paperSize: 9, // A4
          fitToPage: true,
          fitToWidth: 1,
          fitToHeight: 0,
          margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 }
        },
        views: [{ showGridLines: true }]
      });

      // Filtrar y ordenar candidatos activos de esta fecha (cronológicamente por hora de llegada)
      const dateApts = allAppointments
        .filter(a => a.date === dateId && a.status !== 'cancelada')
        .sort((a, b) => (a.time_slot || '').localeCompare(b.time_slot || '') || (a.candidate_name || '').localeCompare(b.candidate_name || ''));

      // 1. BANNER PRINCIPAL: TÍTULO CORPORATIVO
      worksheet.mergeCells('A1:H1');
      const titleCell = worksheet.getCell('A1');
      titleCell.value = 'ALFACREDIT S.A. - LISTA DE ASISTENCIA Y CONTROL DE ENTREVISTAS';
      titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.NAVY_PRIMARY } };
      titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
      worksheet.getRow(1).height = 32;

      // 2. SUBTÍTULO CON DATOS DE FECHA Y SEDE
      worksheet.mergeCells('A2:H2');
      const subCell = worksheet.getCell('A2');
      subCell.value = `Sede: Sucursal Sébaco (Costado Suroeste Parque Central 1/2 c. al Oeste) | Fecha Oficial: ${dateLabel.toUpperCase()} | Horario: 08:00 AM - 05:00 PM`;
      subCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.BLUE_ACCENT } };
      subCell.alignment = { vertical: 'middle', horizontal: 'center' };
      worksheet.getRow(2).height = 22;

      // 3. INSTRUCCIONES DE RECEPCIÓN
      worksheet.mergeCells('A3:H3');
      const instCell = worksheet.getCell('A3');
      instCell.value = 'Instrucciones: Solicitar cédula de identidad física, registrar la hora real de llegada y recabar la firma manuscrita de cada postulante en su fila correspondiente.';
      instCell.font = { name: 'Arial', size: 9, italic: true, color: { argb: COLORS.TEXT_MUTED } };
      instCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      instCell.alignment = { vertical: 'middle', horizontal: 'center' };
      worksheet.getRow(3).height = 18;

      worksheet.addRow([]); // Fila 4 vacía
      worksheet.getRow(4).height = 8;

      // 4. ENCABEZADOS DE LA TABLA DE ASISTENCIA
      const headers = [
        'N°',
        'Hora de Cita',
        'Nombre Completo del Postulante',
        'Cargo / Plaza',
        'Teléfono / WhatsApp',
        'Estado de Confirmación',
        'Firma del Postulante',
        'Observaciones / Hora Real de Recepción'
      ];

      const headerRow = worksheet.addRow(headers);
      headerRow.height = 28;
      headerRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.NAVY_DARK } };
        cell.alignment = { vertical: 'middle', horizontal: colNumber === 3 || colNumber === 4 ? 'left' : 'center', wrapText: true };
        cell.border = {
          top: { style: 'medium', color: { argb: COLORS.NAVY_DARK } },
          left: { style: 'thin', color: { argb: COLORS.BORDER_THIN } },
          bottom: { style: 'medium', color: { argb: COLORS.NAVY_DARK } },
          right: { style: 'thin', color: { argb: COLORS.BORDER_THIN } }
        };
      });

      // 5. FILAS DE CANDIDATOS CITADOS (ORDEN CRONOLÓGICO)
      let countConfirmed = 0;
      let countPending = 0;

      if (dateApts.length === 0) {
        const emptyRow = worksheet.addRow(['-', '-', 'No hay entrevistas programadas para esta fecha', '-', '-', '-', '-', '-']);
        emptyRow.height = 36;
        emptyRow.eachCell(cell => {
          cell.font = { name: 'Arial', size: 10, italic: true, color: { argb: COLORS.TEXT_MUTED } };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          cell.border = {
            top: { style: 'thin', color: { argb: COLORS.BORDER_THIN } },
            bottom: { style: 'thin', color: { argb: COLORS.BORDER_THIN } },
            left: { style: 'thin', color: { argb: COLORS.BORDER_THIN } },
            right: { style: 'thin', color: { argb: COLORS.BORDER_THIN } }
          };
        });
      } else {
        dateApts.forEach((apt, idx) => {
          const itemNum = idx + 1;
          const time12h = scheduler.formatTime12h(apt.time_slot);
          const timeDisplay = `${time12h} (${apt.time_slot})`;

          const resolvedPhone = typeof database.resolvePhoneNumber === 'function'
            ? database.resolvePhoneNumber(apt.phone_number, apt.jid)
            : apt.phone_number;

          // Etiqueta legible de confirmación
          let confStatusLabel = 'Pendiente';
          let confColor = { fg: COLORS.PENDING_TEXT, bg: COLORS.PENDING_BG };

          if (apt.confirmation_status === 'asistencia_confirmada') {
            confStatusLabel = 'Confirmó Asistencia';
            confColor = { fg: COLORS.CONFIRMED_TEXT, bg: COLORS.CONFIRMED_BG };
            countConfirmed++;
          } else if (apt.confirmation_status === 'sent') {
            confStatusLabel = 'Mensaje Enviado';
            confColor = { fg: 'FF1E40AF', bg: 'FFDBEAFE' };
            countPending++;
          } else if (apt.confirmation_status === 'failed') {
            confStatusLabel = 'Error en Envío';
            confColor = { fg: COLORS.ERROR_TEXT, bg: COLORS.ERROR_BG };
            countPending++;
          } else {
            countPending++;
          }

          const row = worksheet.addRow([
            itemNum,
            timeDisplay,
            apt.candidate_name,
            apt.position,
            resolvedPhone,
            confStatusLabel,
            '', // Espacio amplio para firma manuscrita del postulante
            apt.notes || '' // Espacio para observaciones / hora real
          ]);

          // Altura amplia (40pt) para permitir firma manuscrita cómoda y clara
          row.height = 40;
          const isEven = idx % 2 === 0;

          row.eachCell((cell, colNumber) => {
            cell.font = { name: 'Arial', size: 9.5, color: { argb: COLORS.TEXT_DARK } };
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: isEven ? COLORS.BG_WHITE : COLORS.BG_LIGHT }
            };
            cell.border = {
              top: { style: 'thin', color: { argb: COLORS.BORDER_THIN } },
              bottom: { style: 'thin', color: { argb: COLORS.BORDER_THIN } },
              left: { style: 'thin', color: { argb: COLORS.BORDER_THIN } },
              right: { style: 'thin', color: { argb: COLORS.BORDER_THIN } }
            };

            // Alineaciones específicas
            if (colNumber === 1) { // N°
              cell.alignment = { vertical: 'middle', horizontal: 'center' };
              cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.NAVY_PRIMARY } };
            } else if (colNumber === 2) { // Hora
              cell.alignment = { vertical: 'middle', horizontal: 'center' };
              cell.font = { name: 'Arial', size: 9.5, bold: true, color: { argb: COLORS.TEXT_DARK } };
            } else if (colNumber === 3) { // Nombre
              cell.alignment = { vertical: 'middle', horizontal: 'left' };
              cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.TEXT_DARK } };
            } else if (colNumber === 4) { // Cargo
              cell.alignment = { vertical: 'middle', horizontal: 'left' };
            } else if (colNumber === 5) { // Teléfono
              cell.alignment = { vertical: 'middle', horizontal: 'center' };
            } else if (colNumber === 6) { // Estado Confirmación
              cell.alignment = { vertical: 'middle', horizontal: 'center' };
              cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: confColor.fg } };
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: confColor.bg } };
            } else if (colNumber === 7) { // Espacio para Firma Manuscrita
              cell.alignment = { vertical: 'bottom', horizontal: 'center' };
              cell.border = {
                ...cell.border,
                bottom: { style: 'medium', color: { argb: COLORS.BORDER_MEDIUM } }
              };
            } else if (colNumber === 8) { // Observaciones
              cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
            }
          });
        });
      }

      // 6. RESUMEN Y PIE DE CONTROL AL FINAL DE CADA HOJA
      worksheet.addRow([]); // Separador

      // Cuadro de Resumen de Convocatoria
      const summaryRow1 = worksheet.addRow(['', '', 'RESUMEN DE CONVOCATORIA DE ESTA FECHA:', '', '', '', '', '']);
      summaryRow1.height = 20;
      worksheet.mergeCells(`C${summaryRow1.number}:E${summaryRow1.number}`);
      const s1Cell = worksheet.getCell(`C${summaryRow1.number}`);
      s1Cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.NAVY_PRIMARY } };

      const totalConvocados = dateApts.length;
      const summaryRow2 = worksheet.addRow([
        '', '',
        `• Total de Postulantes Citados: ${totalConvocados}  |  • Asistencias Confirmadas: ${countConfirmed}  |  • Pendientes de Confirmación: ${countPending}`,
        '', '', '', '', ''
      ]);
      summaryRow2.height = 20;
      worksheet.mergeCells(`C${summaryRow2.number}:G${summaryRow2.number}`);
      const s2Cell = worksheet.getCell(`C${summaryRow2.number}`);
      s2Cell.font = { name: 'Arial', size: 9.5, italic: true, color: { argb: COLORS.TEXT_MUTED } };

      worksheet.addRow([]); // Fila vacía

      // Bloques de Firmas de los Evaluadores / Recepción
      const sigRow1 = worksheet.addRow([
        '',
        '________________________________________',
        '',
        '',
        '',
        '________________________________________',
        '',
        ''
      ]);
      sigRow1.height = 24;
      worksheet.mergeCells(`B${sigRow1.number}:D${sigRow1.number}`);
      worksheet.mergeCells(`F${sigRow1.number}:H${sigRow1.number}`);
      sigRow1.getCell('B').alignment = { horizontal: 'center', vertical: 'bottom' };
      sigRow1.getCell('F').alignment = { horizontal: 'center', vertical: 'bottom' };

      const sigRow2 = worksheet.addRow([
        '',
        'Responsable de Recepción y Control',
        '',
        '',
        '',
        'Comité de Selección y Talento Humano',
        '',
        ''
      ]);
      sigRow2.height = 18;
      worksheet.mergeCells(`B${sigRow2.number}:D${sigRow2.number}`);
      worksheet.mergeCells(`F${sigRow2.number}:H${sigRow2.number}`);
      sigRow2.getCell('B').font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.TEXT_DARK } };
      sigRow2.getCell('F').font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.TEXT_DARK } };
      sigRow2.getCell('B').alignment = { horizontal: 'center', vertical: 'top' };
      sigRow2.getCell('F').alignment = { horizontal: 'center', vertical: 'top' };

      const sigRow3 = worksheet.addRow([
        '',
        'AlfaCredit S.A. - Sucursal Sébaco',
        '',
        '',
        '',
        'AlfaCredit S.A. - Sébaco',
        '',
        ''
      ]);
      sigRow3.height = 16;
      worksheet.mergeCells(`B${sigRow3.number}:D${sigRow3.number}`);
      worksheet.mergeCells(`F${sigRow3.number}:H${sigRow3.number}`);
      sigRow3.getCell('B').font = { name: 'Arial', size: 8.5, italic: true, color: { argb: COLORS.TEXT_MUTED } };
      sigRow3.getCell('F').font = { name: 'Arial', size: 8.5, italic: true, color: { argb: COLORS.TEXT_MUTED } };
      sigRow3.getCell('B').alignment = { horizontal: 'center', vertical: 'top' };
      sigRow3.getCell('F').alignment = { horizontal: 'center', vertical: 'top' };

      // 7. ANCHO DE COLUMNAS PROFESIONAL Y AMPLIO PARA IMPRESIÓN DIRECTA
      worksheet.columns = [
        { width: 6 },  // N°
        { width: 20 }, // Hora de Cita (ej: 08:30 AM (08:30))
        { width: 34 }, // Nombre Completo del Postulante
        { width: 28 }, // Cargo / Plaza Postulada
        { width: 18 }, // Teléfono / WhatsApp
        { width: 24 }, // Estado de Confirmación
        { width: 36 }, // Firma del Postulante (Espacio amplio para firma manuscrita)
        { width: 30 }  // Observaciones / Hora Real de Recepción
      ];
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=AlfaCredit_Lista_Asistencia_Entrevistas_${new Date().toISOString().slice(0, 10)}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generando archivo Excel:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Panel de administración de citas
app.get('/', (req, res) => {
  const file = path.join(publicDir, 'index.html');
  if (fs.existsSync(file)) {
    return res.sendFile(file);
  }
  res.status(404).send('Panel no encontrado');
});

// Portal público de auto-agendamiento de entrevistas (Plan B sin riesgo de bloqueo de WhatsApp)
app.get('/agendar', (req, res) => {
  const file = path.join(publicDir, 'agendar.html');
  if (fs.existsSync(file)) {
    return res.sendFile(file);
  }
  res.status(404).send('Portal de agendamiento no encontrado');
});

// Fallback al index.html para la SPA (ignorando rutas /api/ no coincidentes)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Ruta API no encontrada' });
  }
  const file = path.join(publicDir, 'index.html');
  if (fs.existsSync(file)) {
    return res.sendFile(file);
  }
  res.status(404).send('Panel no encontrado');
});

// Manejador global de errores para evitar caídas en serverless
app.use((err, req, res, next) => {
  console.error('Error no controlado en la aplicación:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err.message || 'Error interno del servidor' });
});

// Túnel HTTPS público automático (localhost.run vía OpenSSH nativo) cuando corre en PC local
function startPublicTunnel(port) {
  if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.DISABLE_TUNNEL === 'true') {
    return;
  }
  try {
    const { spawn } = require('child_process');
    const fs = require('fs');
    if (tunnelProcess) {
      try { tunnelProcess.kill(); } catch {}
      tunnelProcess = null;
    }

    const sshArgs = [
      '-T',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ConnectTimeout=15',
      '-R', `80:localhost:${port}`,
      'nokey@localhost.run'
    ];

    const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    tunnelProcess = proc;

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.lhr\.life/i);
      if (match && match[0] !== activePublicUrl) {
        activePublicUrl = match[0];
        console.log(`🌐 URL PÚBLICA EN VIVO (Panel): ${activePublicUrl}`);
        console.log(`🔗 LINK AUTO-AGENDAR CANDIDATOS: ${activePublicUrl}/agendar`);
        try {
          fs.writeFileSync(path.join(CONFIG.DATA_DIR, 'public_url.txt'), `${activePublicUrl}\n${activePublicUrl}/agendar\n`, 'utf8');
        } catch {}
        broadcast('tunnel_ready', {
          publicUrl: activePublicUrl,
          agendarUrl: `${activePublicUrl}/agendar`
        });
      }
    };

    proc.stdout.on('data', handleOutput);
    proc.stderr.on('data', handleOutput);

    proc.on('close', () => {
      if (tunnelProcess === proc) {
        tunnelProcess = null;
        setTimeout(() => startPublicTunnel(port), 5000).unref();
      }
    });

    proc.on('error', () => {
      if (tunnelProcess === proc) {
        tunnelProcess = null;
      }
    });
  } catch (e) {
    console.warn('⚠️ No se pudo iniciar túnel público automático:', e.message);
  }
}

// Iniciar servidor
function startServer() {
  const activeServer = server || http.createServer(app);

  activeServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Error fatal: El puerto ${CONFIG.PORT} ya está en uso por otra instancia o proceso.`);
      console.error(`Por favor cierre la otra instancia de AlfaRespuestas antes de continuar.`);
    } else {
      console.error('Error al iniciar el servidor:', err);
    }
    process.exit(1);
  });

  activeServer.listen(CONFIG.PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Sistema AlfaRespuestas listo en: http://localhost:${CONFIG.PORT}`);
    console.log(`🏢 Empresa: ${CONFIG.COMPANY_NAME}`);
    console.log(`=======================================================`);

    // Iniciar cliente de WhatsApp
    whatsappService.start();

    // Iniciar túnel público HTTPS gratuito si se ejecuta localmente
    startPublicTunnel(CONFIG.PORT);

    // Auto-ping inteligente en producción (solo en horario activo 06:00-22:00 CST para no agotar las 750h gratuitas de Render)
    if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
      const keepAliveUrl = `${process.env.RENDER_EXTERNAL_URL}/api/status`;
      setInterval(() => {
        const hourCst = (new Date().getUTCHours() - 6 + 24) % 24;
        if (hourCst >= 6 && hourCst <= 22) {
          fetch(keepAliveUrl).catch(() => {});
        }
      }, 10 * 60 * 1000).unref();
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer, getPublicUrl };
