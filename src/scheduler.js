const CONFIG = require('./config');
const database = require('./database');

const scheduler = {
  // Obtener la etiqueta legible de una fecha
  getDateLabel(dateId) {
    const fromDb = database.getDateById(dateId);
    if (fromDb && fromDb.label) return fromDb.label;
    const found = CONFIG.DATES.find(d => d.id === dateId);
    return found ? found.label : dateId;
  },

  // Obtener el objeto de fecha por ID o por índice ('1', '2', '3', ...)
  resolveDate(input, onlyActive = true) {
    if (!input) return null;
    const clean = String(input).trim();
    const activeDates = database.getActiveDates();

    // Comprobar si es un índice numérico '1', '2', '3' o '1.', 'opcion 1', '#1'
    const idMatch = clean.match(/^(?:opci[oó]n\s*|#\s*)?([1-9][0-9]?)(?:\.|\)|:|\s|$)/i);
    const num = idMatch ? parseInt(idMatch[1], 10) : parseInt(clean, 10);
    if (!isNaN(num) && num >= 1 && num <= activeDates.length) {
      return activeDates[num - 1];
    }

    // Buscar por ID exacto en activas (ej: '2025-11-04')
    const byId = activeDates.find(d => d.id === clean);
    if (byId) return byId;

    // Buscar por coincidencia parcial en nombre o short (normalizando tildes)
    const lower = clean.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (lower.length >= 3) {
      const byLabel = activeDates.find(d => {
        const normLabel = d.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const normShort = (d.short || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return normLabel.includes(lower) || (normShort && normShort.includes(lower));
      });
      if (byLabel) return byLabel;
    }

    // Fallback opcional a todas las fechas solo si se solicitó explícitamente
    if (!onlyActive) {
      const allDates = database.listDates();
      return allDates.find(d => d.id === clean) || null;
    }

    return null;
  },

  // Obtener la plaza por ID ('1', '2', '3') o nombre
  resolvePosition(input) {
    if (!input) return null;
    const clean = String(input).trim();

    // 1. Coincidencia por ID directo '1', '2', '3' o '1.', 'opcion 1', '#1'
    const idMatch = clean.match(/^(?:opci[oó]n\s*|#\s*)?([1-9])(?:\.|\)|:|\s|$)/i);
    if (idMatch) {
      const byId = CONFIG.POSITIONS.find(p => p.id === idMatch[1]);
      if (byId) return byId;
    }

    // 2. Coincidencia por texto normalizado
    const lower = clean.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    // Evitar falsos positivos con palabras comunes que comparten todas las plazas ('de', 'credito')
    if (lower === 'de' || lower === 'credito' || lower.length < 3) {
      return null;
    }

    // Coincidencias específicas por rol
    if (lower.includes('oficial')) return CONFIG.POSITIONS.find(p => p.id === '1') || null;
    if (lower.includes('promotor')) return CONFIG.POSITIONS.find(p => p.id === '2') || null;
    if (lower.includes('desembolsa')) return CONFIG.POSITIONS.find(p => p.id === '3') || null;

    return CONFIG.POSITIONS.find(p => p.code.toLowerCase() === lower) || null;
  },

  // Formatear hora 24h a 12h con AM/PM (ej: '08:30' -> '08:30 AM', '14:15' -> '02:15 PM')
  formatTime12h(timeStr) {
    if (!timeStr) return '';
    const parts = timeStr.split(':');
    if (parts.length < 2) return timeStr;
    let hours = parseInt(parts[0], 10);
    const minutes = parts[1];
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 === 0 ? 12 : hours % 12;
    return `${displayHours.toString().padStart(2, '0')}:${minutes} ${ampm}`;
  },

  // Lista de todos los turnos disponibles para una fecha
  getAvailableSlots(dateId) {
    const taken = new Set(database.getTakenSlotsForDate(dateId));
    return CONFIG.TIME_SLOTS.filter(slot => !taken.has(slot));
  },

  // Conteo de cupos restantes
  getRemainingCount(dateId) {
    const available = this.getAvailableSlots(dateId);
    return available.length;
  },

  // Próximo turno disponible cronológicamente
  getNextAvailableSlot(dateId) {
    const available = this.getAvailableSlots(dateId);
    return available.length > 0 ? available[0] : null;
  },

  // Alerta de cupos críticos (10 turnos o menos)
  isCriticalRemaining(dateId) {
    const remaining = this.getRemainingCount(dateId);
    return remaining > 0 && remaining <= CONFIG.LOW_SLOTS_ALERT_THRESHOLD;
  },

  // ¿Se agotaron los cupos?
  isExhausted(dateId) {
    return this.getRemainingCount(dateId) === 0;
  },

  // Mensaje de advertencia de cupos
  getQuotaNotice(dateId) {
    const remaining = this.getRemainingCount(dateId);
    const label = this.getDateLabel(dateId);
    if (remaining === 0) {
      return `❌ *Cupos Agotados* para el ${label}. Por favor seleccione otra fecha disponible.`;
    }
    if (remaining <= CONFIG.LOW_SLOTS_ALERT_THRESHOLD) {
      return `⚠️ *¡ÚLTIMOS CUPOS!* Quedan únicamente *${remaining}* turnos disponibles para el ${label}.`;
    }
    return `ℹ️ *Cupos Disponibles:* Quedan ${remaining} turnos para el ${label}.`;
  },

  // Generar ticket de confirmación para el candidato
  generateTicket({ candidate_name, position, date, time_slot }) {
    const dateLabel = this.getDateLabel(date);
    const timeFormatted = this.formatTime12h(time_slot);

    return (
      `══════════════════════════════\n` +
      `   *ALFACREDIT S.A. - CITA CONFIRMADA*   \n` +
      `══════════════════════════════\n\n` +
      `👤 *Postulante:* ${candidate_name}\n` +
      `💼 *Plaza:* ${position}\n` +
      `📅 *Fecha:* ${dateLabel}\n` +
      `⏰ *Hora:* ${timeFormatted} (${time_slot})\n` +
      `📍 *Ubicación:* ${CONFIG.LOCATION}\n\n` +
      `📋 *Recomendaciones y Requisitos:*\n` +
      `• Presentarse 5 minutos antes de su hora asignada.\n` +
      `• Traer Currículum Vitae (CV) impreso y actualizado.\n` +
      `• Documento de Identificación oficial (DPI o Cédula).\n` +
      `• Presentación formal / ejecutiva.\n\n` +
      `Si necesita reprogramar su cita, puede comunicarse con este mismo número.\n` +
      `¡Muchos éxitos en su proceso de selección!`
    );
  },

  // Generar mensaje de notificación tras edición o reprogramación desde el panel
  generateRescheduledNotice({ candidate_name, position, date, time_slot, status, notes }) {
    const dateLabel = this.getDateLabel(date);
    const timeFormatted = this.formatTime12h(time_slot);

    if (status === 'cancelada') {
      return (
        `📢 *NOTIFICACIÓN DE CANCELACIÓN - ALFACREDIT S.A.*\n\n` +
        `Estimado(a) *${candidate_name}*,\n\n` +
        `Le informamos que su entrevista programada para la plaza *${position}* ha sido cancelada.\n` +
        (notes ? `Motivo: ${notes}\n\n` : '\n') +
        `Para reagendar o consultar dudas, puede responder a este mensaje.\n` +
        `Atentamente,\nRecursos Humanos - AlfaCredit S.A.`
      );
    }

    return (
      `📢 *AVISO DE ACTUALIZACIÓN / REPROGRAMACIÓN*\n` +
      `*AlfaCredit S.A. - Departamento de Recursos Humanos*\n\n` +
      `Estimado(a) *${candidate_name}*,\n` +
      `Le notificamos que los datos de su entrevista han sido actualizados en nuestro sistema:\n\n` +
      `📌 *Plaza:* ${position}\n` +
      `📅 *Fecha:* ${dateLabel}\n` +
      `⏰ *Hora:* ${timeFormatted} (${time_slot})\n` +
      `📍 *Lugar:* ${CONFIG.LOCATION}\n\n` +
      (notes ? `📝 *Observaciones:* ${notes}\n\n` : '') +
      `📋 *Recuerde:*\n` +
      `• Llegar con 5 minutos de anticipación.\n` +
      `• Portar su Currículum Vitae impreso y documento de identificación personal.\n\n` +
      `Cualquier consulta adicional queda a su disposición por este medio.\n` +
      `¡Le deseamos el mejor de los éxitos!`
    );
  }
};

module.exports = scheduler;
