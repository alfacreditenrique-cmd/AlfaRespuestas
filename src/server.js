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

const isServerless = Boolean(process.env.VERCEL || process.env.SERVERLESS);
const app = express();
const server = isServerless ? null : http.createServer(app);
const wss = isServerless ? null : new WebSocket.Server({ server });

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
    const { candidate_name, phone_number, position, date } = req.body || {};
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
    let nextSlot = scheduler.getNextAvailableSlot(dateObj.id);
    if (!nextSlot && (!prior || prior.date !== dateObj.id)) {
      return res.status(409).json({
        success: false,
        error: `Lo sentimos, los cupos para el ${dateObj.label} se han agotado. Por favor elige otra fecha disponible.`
      });
    }

    // Si ya tenía una cita previa activa con ese teléfono, liberarla antes de asignar el nuevo turno
    if (prior) {
      database.cancelAppointment(prior.id, 'Reprogramada por el postulante desde portal web /agendar');
      if (prior.date === dateObj.id) {
        nextSlot = scheduler.getNextAvailableSlot(dateObj.id) || prior.time_slot;
      }
    }

    const appointment = database.createAppointment({
      candidate_name: nameClean,
      phone_number: phoneDigits,
      position: posObj.title,
      date: dateObj.id,
      time_slot: nextSlot,
      notes: prior ? `Reprogramada vía Portal Web (/agendar) desde cita #${prior.id}` : 'Agendado por el postulante vía Portal Web (/agendar)'
    });

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

// 15. EXPORTACIÓN PROFESIONAL A EXCEL (.xlsx)
app.get('/api/export/excel', async (req, res) => {
  try {
    const appointments = database.listAppointments();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AlfaCredit S.A. - Sistema AlfaRespuestas';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Citas Agendadas', {
      views: [{ showGridLines: true }]
    });

    // Título Principal
    worksheet.mergeCells('A1:H1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'ALFACREDIT S.A. - LISTADO OFICIAL DE ENTREVISTAS DE TRABAJO';
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }; // Azul Corporativo
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 36;

    // Subtítulo con fecha de generación
    const activeDatesLabel = database.getActiveDates().map(d => d.label).join(' | ');
    worksheet.mergeCells('A2:H2');
    const subCell = worksheet.getCell('A2');
    subCell.value = `Fechas: ${activeDatesLabel} | Generado el: ${new Date().toLocaleString('es-GT')}`;
    subCell.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF475569' } };
    subCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(2).height = 20;

    worksheet.addRow([]); // Fila vacía

    // Encabezados de Columnas
    const headers = [
      'ID',
      'Postulante (Nombre)',
      'Teléfono / WhatsApp',
      'Plaza a la que Aplica',
      'Fecha',
      'Hora (24h)',
      'Hora (12h)',
      'Estado',
      'Notas / Observaciones'
    ];

    const headerRow = worksheet.addRow(headers);
    headerRow.height = 26;
    headerRow.eachCell((cell) => {
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'medium', color: { argb: 'FF1E3A8A' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });

    // Agregar filas de datos
    appointments.forEach((apt, index) => {
      const dateLabel = scheduler.getDateLabel(apt.date);
      const time12h = scheduler.formatTime12h(apt.time_slot);

      const resolvedPhone = typeof database.resolvePhoneNumber === 'function'
        ? database.resolvePhoneNumber(apt.phone_number, apt.jid)
        : apt.phone_number;

      const row = worksheet.addRow([
        apt.id,
        apt.candidate_name,
        resolvedPhone,
        apt.position,
        dateLabel,
        apt.time_slot,
        time12h,
        apt.status.toUpperCase(),
        apt.notes || ''
      ]);

      row.height = 22;
      const isEven = index % 2 === 0;

      row.eachCell((cell, colNumber) => {
        cell.font = { name: 'Arial', size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: colNumber === 1 || colNumber >= 5 ? 'center' : 'left' };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isEven ? 'FFF8FAFC' : 'FFFFFFFF' }
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };

        // Resaltar estado
        if (colNumber === 8) {
          if (apt.status === 'confirmada') {
            cell.font = { bold: true, color: { argb: 'FF166534' } }; // Verde
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
          } else if (apt.status === 'reprogramada') {
            cell.font = { bold: true, color: { argb: 'FF854D0E' } }; // Ámbar
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF9C3' } };
          } else if (apt.status === 'cancelada') {
            cell.font = { bold: true, color: { argb: 'FF991B1B' } }; // Rojo
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          }
        }
      });
    });

    // Ajustar anchos automáticos
    worksheet.columns = [
      { width: 8 },  // ID
      { width: 30 }, // Nombre
      { width: 20 }, // Teléfono
      { width: 28 }, // Plaza
      { width: 28 }, // Fecha
      { width: 14 }, // Hora 24h
      { width: 16 }, // Hora 12h
      { width: 18 }, // Estado
      { width: 36 }  // Notas
    ];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=AlfaCredit_Citas_${new Date().toISOString().slice(0, 10)}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generando archivo Excel:', err);
    res.status(500).json({ success: false, error: err.message });
  }
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
  if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL || process.env.DISABLE_TUNNEL === 'true') {
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
