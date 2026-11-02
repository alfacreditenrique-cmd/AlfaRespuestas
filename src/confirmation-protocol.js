const CONFIG = require('./config');
const database = require('./database');
const scheduler = require('./scheduler');
const whatsappService = require('./whatsapp');

/**
 * 4 Variantes Naturales y Personalizadas de Mensajes de Confirmación
 * Diseñadas para emular atención humana personalizada y evitar detección de patrones automatizados por WhatsApp.
 */
const CONFIRMATION_VARIANTS = [
  {
    id: 1,
    code: 'CORDIAL_DIRECTA',
    title: 'Variante 1: Cordial y Directa',
    buildText: ({ name, position, dateLabel, time12h, location }) => {
      const greeting = getFriendlyGreetingName(name);
      return (
        `Hola ${greeting}, gusto en saludarte. Te escribimos del área de Selección y Talento de AlfaCredit S.A.\n\n` +
        `Queremos consultar tu disponibilidad para la entrevista de la plaza *${position}*, programada para el día *${dateLabel}* a las *${time12h}* en nuestra sucursal de Sébaco (${location}).\n\n` +
        `¿Podrías por favor confirmarnos respondiendo a este mensaje si cuentas con disponibilidad para presentarte? Quedamos atentos a tu confirmación. ¡Muchas gracias!`
      );
    }
  },
  {
    id: 2,
    code: 'PERSONALIZADA_DINAMICA',
    title: 'Variante 2: Personalizada y Dinámica',
    buildText: ({ name, position, dateLabel, time12h, location }) => {
      const greeting = getFriendlyGreetingName(name);
      return (
        `Estimado/a ${greeting}, te enviamos un cordial saludo de parte del equipo de Selección de AlfaCredit.\n\n` +
        `Revisando nuestra agenda de entrevistas para la vacante de *${position}*, tenemos reservado tu turno para el *${dateLabel}* a las *${time12h}* en nuestra sede central de Sébaco (${location}).\n\n` +
        `Para asegurar tu espacio con el comité evaluador, por favor indícanos si confirmas tu asistencia a la cita. ¡Te deseamos mucho éxito en el proceso!`
      );
    }
  },
  {
    id: 3,
    code: 'FORMAL_ATENTA',
    title: 'Variante 3: Formal y Atenta',
    buildText: ({ name, position, dateLabel, time12h, location }) => {
      const greeting = getFriendlyGreetingName(name);
      return (
        `Buenos días ${greeting}, esperamos te encuentres muy bien. Te contactamos de AlfaCredit S.A.\n\n` +
        `Nos comunicamos para validar tu asistencia a la entrevista presencial programada como *${position}*, para el *${dateLabel}* a las *${time12h}* en Sébaco (${location}).\n\n` +
        `Agradecemos responder brevemente confirmando si asistirás para tener listo tu expediente con el equipo de contratación. Saludos cordiales.`
      );
    }
  },
  {
    id: 4,
    code: 'CERCANA_BREVE',
    title: 'Variante 4: Cercana y Breve',
    buildText: ({ name, position, dateLabel, time12h, location }) => {
      const greeting = getFriendlyGreetingName(name);
      return (
        `Hola ${greeting}, ¿cómo estás? Te escribe el equipo de talento humano de AlfaCredit.\n\n` +
        `Con relación a tu postulación para la posición de *${position}*, tu cita presencial en Sébaco (${location}) está agendada para el *${dateLabel}* a las *${time12h}*.\n\n` +
        `¿Nos confirmas por favor respondiendo a este mensaje si te es posible asistir en ese horario? Con tu respuesta validamos tu turno oficial. ¡Feliz día!`
      );
    }
  }
];

function getFriendlyGreetingName(rawName) {
  if (!rawName) return 'postulante';
  const clean = String(rawName).trim();
  if (clean.toLowerCase().startsWith('postulante') || clean.toLowerCase().startsWith('id ') || /^\d+$/.test(clean)) {
    return 'postulante';
  }
  const parts = clean.split(/\s+/);
  return parts[0] || 'postulante';
}

function formatConfirmationMessage(variantId, appointment) {
  const vId = Number(variantId) || 1;
  const variant = CONFIRMATION_VARIANTS.find(v => v.id === vId) || CONFIRMATION_VARIANTS[0];
  const dateLabel = scheduler.getDateLabel(appointment.date);
  const time12h = scheduler.formatTime12h(appointment.time_slot);
  const location = CONFIG.LOCATION || 'Costado Suroeste Parque Central 1/2 cuadra al Oeste, Sébaco';

  return variant.buildText({
    name: appointment.candidate_name,
    position: appointment.position,
    dateLabel,
    time12h,
    location
  });
}

class ConfirmationProtocolService {
  constructor() {
    this.isRunning = false;
    this.isPaused = false;
    this.currentCandidateId = null;
    this.lastSentAt = 0;
    this.broadcastCallback = null;
    this.activeRunId = null;
    this.processedPhones = new Set();
  }

  setBroadcast(fn) {
    this.broadcastCallback = fn;
  }

  emit(eventType, data) {
    if (typeof this.broadcastCallback === 'function') {
      try {
        this.broadcastCallback(eventType, data);
      } catch (e) {
        console.error('[ConfirmationProtocol] Error emitiendo evento:', e.message);
      }
    }
  }

  getStatus() {
    const dbStats = database.getConfirmationStats();
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      currentCandidateId: this.currentCandidateId,
      lastSentAt: this.lastSentAt,
      stats: dbStats,
      variantsCount: CONFIRMATION_VARIANTS.length,
      antiBanConfig: {
        minPauseSec: 8,
        maxPauseSec: 18,
        singleMessagePerCandidate: true
      }
    };
  }

  getCandidates(filter = 'all') {
    const rawList = database.listCandidatesForConfirmation();
    const result = [];
    const seenPhones = new Set();

    for (const apt of rawList) {
      const resolvedPhone = typeof database.resolvePhoneNumber === 'function'
        ? database.resolvePhoneNumber(apt.phone_number, apt.jid)
        : apt.phone_number;

      const dateLabel = scheduler.getDateLabel(apt.date);
      const time12h = scheduler.formatTime12h(apt.time_slot);
      const isFailed = apt.confirmation_status === 'failed';
      const isSent = !isFailed && Boolean(apt.confirmation_sent_at || apt.confirmation_status === 'sent');
      const status = isFailed ? 'failed' : (isSent ? 'sent' : 'pending');

      const isDuplicateInList = seenPhones.has(resolvedPhone);
      seenPhones.add(resolvedPhone);

      const item = {
        id: apt.id,
        candidate_name: apt.candidate_name,
        phone_number: resolvedPhone,
        raw_phone: apt.phone_number,
        jid: apt.jid || null,
        position: apt.position,
        date: apt.date,
        dateLabel,
        time_slot: apt.time_slot,
        time12h,
        status: apt.status,
        confirmation_status: status,
        confirmation_sent_at: apt.confirmation_sent_at || null,
        confirmation_variant: apt.confirmation_variant || null,
        confirmation_error: apt.confirmation_error || null,
        is_duplicate: isDuplicateInList,
        message_preview: formatConfirmationMessage(apt.confirmation_variant || 1, apt)
      };

      if (filter === 'pending' && status !== 'pending') continue;
      if (filter === 'sent' && status !== 'sent') continue;
      if (filter === 'failed' && status !== 'failed') continue;
      if (filter === 'unconfirmed' && status === 'sent') continue;

      result.push(item);
    }

    return result;
  }

  calculateAntiBanDelay(minMs = 8000, maxMs = 18000) {
    const baseMin = Math.max(100, Number(minMs));
    const baseMax = Math.max(baseMin, Number(maxMs));
    const range = baseMax - baseMin;
    return baseMin + Math.floor(Math.random() * (range + 1));
  }

  async sendSingle(appointmentId, options = {}) {
    const { variantId = null, dryRun = false, force = false } = options;
    const apt = database.getAppointmentById(appointmentId);
    if (!apt) {
      throw new Error(`Cita con ID ${appointmentId} no encontrada`);
    }

    // Regla estricta: 1 solo mensaje por persona a menos que se fuerce explícitamente
    if (!force && (apt.confirmation_sent_at || apt.confirmation_status === 'sent')) {
      return {
        success: false,
        skipped: true,
        reason: 'El mensaje de confirmación ya fue enviado previamente a este candidato.',
        candidate: apt
      };
    }

    const resolvedPhone = typeof database.resolvePhoneNumber === 'function'
      ? database.resolvePhoneNumber(apt.phone_number, apt.jid)
      : apt.phone_number;

    const chosenVariant = Number(variantId) || apt.confirmation_variant || (Math.floor(Math.random() * 4) + 1);
    const messageText = formatConfirmationMessage(chosenVariant, apt);
    const targetRecipient = apt.jid || resolvedPhone;

    let success = false;
    let error = null;
    let messageId = null;

    if (dryRun) {
      success = true;
      messageId = `DRY_RUN_${Date.now()}`;
    } else {
      const waStatus = whatsappService.getStatus();
      if (waStatus.status !== 'CONNECTED' || !whatsappService.sock) {
        error = `WhatsApp no está conectado (${waStatus.status}). Conecta WhatsApp en el panel para despachar.`;
      } else {
        try {
          await whatsappService.simulateHumanTyping(targetRecipient, messageText);
          const sendRes = await whatsappService.sendMessage(targetRecipient, messageText);
          if (sendRes.success) {
            success = true;
            messageId = sendRes.messageId;
          } else {
            error = sendRes.error;
          }
        } catch (err) {
          error = err.message;
        }
      }
    }

    if (success) {
      database.markConfirmationSent(apt.id, chosenVariant, `Destino: ${targetRecipient} (MsgID: ${messageId || 'OK'})`);
      const updated = database.getAppointmentById(apt.id);
      this.emit('confirmation_sent', {
        appointment_id: apt.id,
        candidate_name: apt.candidate_name,
        phone: resolvedPhone,
        variantId: chosenVariant,
        messageId,
        stats: database.getConfirmationStats()
      });
      return { success: true, appointment: updated, messageId, variantId: chosenVariant };
    } else {
      database.markConfirmationFailed(apt.id, error || 'Fallo desconocido en envío');
      this.emit('confirmation_failed', {
        appointment_id: apt.id,
        candidate_name: apt.candidate_name,
        phone: resolvedPhone,
        error,
        stats: database.getConfirmationStats()
      });
      return { success: false, error, variantId: chosenVariant };
    }
  }

  async startProtocol(options = {}) {
    if (this.isRunning) {
      return { success: false, message: 'El Protocolo de Confirmación ya está en ejecución' };
    }

    const {
      delayMinMs = 8000,
      delayMaxMs = 18000,
      dryRun = false,
      variantRotation = 'sequential' // 'sequential' or 'random'
    } = options;

    if (!dryRun) {
      const waStatus = whatsappService.getStatus();
      if (waStatus.status !== 'CONNECTED' || !whatsappService.sock) {
        return {
          success: false,
          message: `WhatsApp no está conectado (${waStatus.status}). Por favor vincula tu WhatsApp escaneando el código QR en el panel antes de iniciar el protocolo.`
        };
      }
    }

    const candidates = this.getCandidates('unconfirmed');
    const totalPending = candidates.length;

    if (totalPending === 0) {
      return {
        success: false,
        message: 'No hay candidatos pendientes de confirmación. Todos los postulantes activos ya fueron confirmados.'
      };
    }

    this.isRunning = true;
    this.isPaused = false;
    this.activeRunId = `run_${Date.now()}`;
    this.processedPhones.clear();

    this.emit('protocol_started', {
      runId: this.activeRunId,
      totalPending,
      timestamp: new Date().toISOString(),
      stats: database.getConfirmationStats()
    });

    console.log(`[Protocolo Confirmación] 🚀 Iniciando protocolo para ${totalPending} candidato(s) pendientes.`);

    // Ejecutar en segundo plano de manera asíncrona
    (async () => {
      let sentCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < candidates.length; i++) {
        if (!this.isRunning) {
          console.log('[Protocolo Confirmación] 🛑 Protocolo detenido por el usuario.');
          break;
        }

        while (this.isPaused && this.isRunning) {
          await new Promise(r => setTimeout(r, 1000));
        }

        if (!this.isRunning) break;

        const candidate = candidates[i];
        this.currentCandidateId = candidate.id;

        // Doble verificación: comprobar en base de datos si ya se le envió (idempotencia estricta)
        const currentDbApt = database.getAppointmentById(candidate.id);
        if (currentDbApt && (currentDbApt.confirmation_sent_at || currentDbApt.confirmation_status === 'sent')) {
          console.log(`[Protocolo Confirmación] ⏭️ Omitiendo ${candidate.candidate_name}: ya confirmado previamente.`);
          skippedCount++;
          continue;
        }

        // Deduplicación por número telefónico normalizado
        if (this.processedPhones.has(candidate.phone_number)) {
          console.log(`[Protocolo Confirmación] ⏭️ Omitiendo número duplicado en la misma corrida: ${candidate.phone_number}`);
          skippedCount++;
          continue;
        }

        // Selección de variante (rotación 1, 2, 3, 4)
        const variantId = variantRotation === 'random'
          ? (Math.floor(Math.random() * 4) + 1)
          : ((i % 4) + 1);

        // Pausa anti-bloqueo antes de cada envío (excepto el primero si no hubo envíos recientes)
        let pauseMs = 0;
        if (i > 0 || (Date.now() - this.lastSentAt < delayMinMs)) {
          pauseMs = this.calculateAntiBanDelay(delayMinMs, delayMaxMs);
          this.emit('protocol_log', {
            type: 'pause',
            candidate_id: candidate.id,
            candidate_name: candidate.candidate_name,
            pauseMs,
            message: `⏳ Pausa anti-bloqueo de ${(pauseMs / 1000).toFixed(1)}s antes de escribir a ${candidate.candidate_name}...`
          });
          await new Promise(r => setTimeout(r, pauseMs));
        }

        if (!this.isRunning) break;

        this.emit('protocol_log', {
          type: 'sending',
          candidate_id: candidate.id,
          candidate_name: candidate.candidate_name,
          phone: candidate.phone_number,
          variantId,
          message: `✍️ Enviando confirmación (Variante ${variantId}) a ${candidate.candidate_name} (${candidate.phone_number})...`
        });

        const sendResult = await this.sendSingle(candidate.id, { variantId, dryRun });
        this.lastSentAt = Date.now();
        this.processedPhones.add(candidate.phone_number);

        if (sendResult.success) {
          sentCount++;
          this.emit('protocol_log', {
            type: 'sent',
            candidate_id: candidate.id,
            candidate_name: candidate.candidate_name,
            variantId,
            message: `✅ Confirmación entregada con éxito a ${candidate.candidate_name}`
          });
        } else {
          failedCount++;
          this.emit('protocol_log', {
            type: 'failed',
            candidate_id: candidate.id,
            candidate_name: candidate.candidate_name,
            error: sendResult.error,
            message: `❌ Error enviando a ${candidate.candidate_name}: ${sendResult.error}`
          });
        }

        this.emit('protocol_progress', {
          current: i + 1,
          total: totalPending,
          sent: sentCount,
          failed: failedCount,
          skipped: skippedCount,
          percentage: Math.round(((i + 1) / totalPending) * 100),
          stats: database.getConfirmationStats()
        });
      }

      this.isRunning = false;
      this.isPaused = false;
      this.currentCandidateId = null;

      this.emit('protocol_completed', {
        runId: this.activeRunId,
        sent: sentCount,
        failed: failedCount,
        skipped: skippedCount,
        stats: database.getConfirmationStats(),
        timestamp: new Date().toISOString()
      });

      console.log(`[Protocolo Confirmación] 🏁 Protocolo completado: ${sentCount} enviados, ${failedCount} fallidos, ${skippedCount} omitidos.`);
    })().catch(err => {
      console.error('[Protocolo Confirmación] Error fatal en ejecución en segundo plano:', err);
      this.isRunning = false;
      this.isPaused = false;
      this.currentCandidateId = null;
      this.emit('protocol_error', { error: err.message });
    });

    return {
      success: true,
      message: 'Protocolo de confirmación iniciado en segundo plano',
      totalPending,
      runId: this.activeRunId
    };
  }

  pauseProtocol() {
    if (!this.isRunning) return { success: false, message: 'No hay protocolo en ejecución' };
    this.isPaused = true;
    this.emit('protocol_paused', { timestamp: new Date().toISOString() });
    return { success: true, message: 'Protocolo pausado' };
  }

  resumeProtocol() {
    if (!this.isRunning) return { success: false, message: 'No hay protocolo en ejecución' };
    this.isPaused = false;
    this.emit('protocol_resumed', { timestamp: new Date().toISOString() });
    return { success: true, message: 'Protocolo reanudado' };
  }

  stopProtocol() {
    this.isRunning = false;
    this.isPaused = false;
    this.currentCandidateId = null;
    this.emit('protocol_stopped', { timestamp: new Date().toISOString() });
    return { success: true, message: 'Protocolo detenido' };
  }
}

const confirmationProtocol = new ConfirmationProtocolService();

module.exports = {
  CONFIRMATION_VARIANTS,
  ConfirmationProtocolService,
  confirmationProtocol,
  formatConfirmationMessage
};
