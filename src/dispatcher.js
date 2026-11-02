const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const database = require('./database');
const whatsappService = require('./whatsapp');

class MessageDispatcher {
  constructor(options = {}) {
    this.messagesPath = options.messagesPath || path.join(__dirname, '..', '.agents', 'teamwork', 'teamwork_explorer_survey_3', 'proposed_messages.json');
    this.antiBan = {
      minTypingMs: Number(process.env.WA_MIN_TYPING_MS || CONFIG.ANTI_BAN?.MIN_TYPING_MS || 1500),
      maxTypingMs: Number(process.env.WA_MAX_TYPING_MS || CONFIG.ANTI_BAN?.MAX_TYPING_MS || 3500),
      minSendGapMs: Number(process.env.WA_MIN_SEND_GAP_MS || CONFIG.ANTI_BAN?.MIN_SEND_GAP_MS || 1400)
    };
  }

  getStatus() {
    return whatsappService.getStatus();
  }

  loadMessages(customPath = null) {
    const targetPath = customPath || this.messagesPath;
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Proposed messages file not found at: ${targetPath}`);
    }
    const data = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    const messages = [];

    // 1. Schedule Adjustments (Priority 1)
    if (Array.isArray(data.schedule_adjustments)) {
      for (const adj of data.schedule_adjustments) {
        messages.push({
          category: 'SCHEDULE_ADJUSTMENT',
          appointment_id: adj.appointment_id || 122,
          candidate_name: adj.candidate_name,
          destination: adj.primary_target || adj.destination_phone || adj.destination_jid,
          destination_phone: adj.destination_phone,
          destination_jid: adj.destination_jid,
          message_text: adj.message_text,
          metadata: {
            old_slot: adj.old_time_slot,
            new_slot: adj.new_time_slot,
            date: adj.date
          }
        });
      }
    }

    // 2. Registration Reminders (Priority 2)
    if (Array.isArray(data.registration_reminders)) {
      for (const rem of data.registration_reminders) {
        messages.push({
          category: 'REGISTRATION_REMINDER',
          reminder_id: rem.id,
          appointment_id: null,
          candidate_name: null,
          destination: rem.destination || rem.jid,
          destination_phone: rem.destination?.startsWith('505') ? rem.destination : null,
          destination_jid: rem.jid || (rem.destination?.includes('@') ? rem.destination : `${rem.destination}@lid`),
          message_text: rem.message_text,
          metadata: {
            lid: rem.lid,
            step: rem.step,
            selected_position: rem.selected_position
          }
        });
      }
    }

    return messages;
  }

  calculateTypingDelay(text) {
    const { minTypingMs, maxTypingMs } = this.antiBan;
    const base = Math.min(maxTypingMs, Math.max(minTypingMs, String(text || '').length * 10));
    const jitter = Math.floor(Math.random() * 501); // 0-500ms
    return base + jitter;
  }

  calculateSendGap() {
    const { minSendGapMs } = this.antiBan;
    const jitter = Math.floor(Math.random() * 451); // 0-450ms
    return minSendGapMs + jitter;
  }

  async dispatch(options = {}) {
    const messages = this.loadMessages(options.messagesPath);
    const statusObj = this.getStatus();
    const isLiveConnected = statusObj.status === 'CONNECTED' && Boolean(whatsappService.sock);
    const mode = isLiveConnected ? 'LIVE_SOCKET' : 'OFFLINE_ANTI_BAN';

    console.log(`=======================================================`);
    console.log(`🚀 INICIANDO DESPACHO SECUENCIAL ANTI-BAN`);
    console.log(`📡 Modo de Conexión: ${mode} (${statusObj.status})`);
    console.log(`📨 Total de Mensajes a Despachar: ${messages.length}`);
    console.log(`⏱️ Parámetros Anti-Ban: MinGap=${this.antiBan.minSendGapMs}ms (+0-450ms), Typing=${this.antiBan.minTypingMs}-${this.antiBan.maxTypingMs}ms (+0-500ms)`);
    console.log(`=======================================================\n`);

    const telemetry = [];
    const startTime = Date.now();
    let lastSentAt = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgIndex = i + 1;
      const msgStart = Date.now();

      // 1. Minimum Send Gap (except before the first message)
      let gapMs = 0;
      if (lastSentAt > 0) {
        const targetGap = this.calculateSendGap();
        const elapsedSinceLast = Date.now() - lastSentAt;
        if (elapsedSinceLast < targetGap) {
          gapMs = targetGap - elapsedSinceLast;
          await new Promise(r => setTimeout(r, gapMs));
        }
      }

      // 2. Simulated Human Typing
      const typingMs = this.calculateTypingDelay(msg.message_text);
      if (isLiveConnected) {
        await whatsappService.simulateHumanTyping(msg.destination_jid || msg.destination, msg.message_text);
      } else {
        await new Promise(r => setTimeout(r, typingMs));
      }

      // 3. Dispatch Transmission
      let transmissionStatus = 'SENT';
      let error = null;
      let messageId = null;

      if (isLiveConnected) {
        try {
          const res = await whatsappService.sendMessage(msg.destination, msg.message_text);
          if (!res.success) {
            transmissionStatus = 'FAILED';
            error = res.error;
          } else {
            messageId = res.messageId;
          }
        } catch (e) {
          transmissionStatus = 'FAILED';
          error = e.message;
        }
      }

      const msgEnd = Date.now();
      const elapsedTotalMs = msgEnd - msgStart;
      lastSentAt = Date.now();

      // 4. Update appointment notified_at if Juan Alberto Chavarría (adjustment)
      if (msg.category === 'SCHEDULE_ADJUSTMENT') {
        try {
          const juanApt = database.getAppointmentById(122) || database.getAppointmentById(20);
          if (juanApt) {
            database.markNotified(juanApt.id);
            console.log(`[Database] ✅ Actualizado notified_at para cita #${juanApt.id} (${juanApt.candidate_name})`);
          }
        } catch (err) {
          console.warn(`[Database] ⚠️ Error actualizando notified_at:`, err.message);
        }
      }

      // 5. Record Transmission in audit_logs
      const auditDetails = JSON.stringify({
        message_index: msgIndex,
        total_messages: messages.length,
        category: msg.category,
        recipient: msg.destination,
        destination_phone: msg.destination_phone || null,
        destination_jid: msg.destination_jid || null,
        candidate_name: msg.candidate_name || null,
        status: transmissionStatus,
        mode: mode,
        message_id: messageId,
        error: error,
        typing_duration_ms: typingMs,
        send_gap_ms: gapMs,
        total_duration_ms: elapsedTotalMs,
        message_length: msg.message_text.length,
        timestamp: new Date().toISOString()
      });

      try {
        const aptIdForAudit = msg.category === 'SCHEDULE_ADJUSTMENT' ? 122 : null;
        database.logAction('NOTIFICATION_SENT', aptIdForAudit, auditDetails);
      } catch (err) {
        console.error(`[Audit] ❌ Error registrando en audit_logs:`, err.message);
      }

      const record = {
        index: msgIndex,
        category: msg.category,
        recipient: msg.destination,
        candidate_name: msg.candidate_name,
        status: transmissionStatus,
        typing_ms: typingMs,
        gap_ms: gapMs,
        elapsed_ms: elapsedTotalMs,
        timestamp: new Date().toISOString()
      };
      telemetry.push(record);

      const label = msg.category === 'SCHEDULE_ADJUSTMENT' ? '📅 AJUSTE' : '🔔 RECORDATORIO';
      console.log(`[${msgIndex}/${messages.length}] ${label} -> ${msg.destination} (${msg.candidate_name || 'Postulante'}) | Typing: ${typingMs}ms | Gap: ${gapMs}ms | Status: ${transmissionStatus}`);
    }

    const totalDurationMs = Date.now() - startTime;
    console.log(`\n=======================================================`);
    console.log(`✅ DESPACHO SECUENCIAL FINALIZADO CON ÉXITO`);
    console.log(`⏱️ Tiempo Total Transcurrido: ${(totalDurationMs / 1000).toFixed(2)}s`);
    console.log(`📊 Mensajes Transmitidos: ${telemetry.filter(t => t.status === 'SENT').length}/${messages.length}`);
    console.log(`=======================================================`);

    // Guardar sincronización en seed-recovery para asegurar cold starts
    try {
      database.saveToSeedRecovery();
    } catch {}

    const results = {
      summary: {
        timestamp: new Date().toISOString(),
        total_messages: messages.length,
        sent: telemetry.filter(t => t.status === 'SENT').length,
        failed: telemetry.filter(t => t.status === 'FAILED').length,
        mode: mode,
        total_duration_ms: totalDurationMs,
        total_duration_seconds: Number((totalDurationMs / 1000).toFixed(2)),
        avg_typing_ms: Math.round(telemetry.reduce((acc, t) => acc + t.typing_ms, 0) / telemetry.length),
        avg_gap_ms: Math.round(telemetry.slice(1).reduce((acc, t) => acc + t.gap_ms, 0) / Math.max(1, telemetry.length - 1))
      },
      telemetry
    };

    return results;
  }
}

const dispatcher = new MessageDispatcher();

if (require.main === module) {
  dispatcher.dispatch()
    .then(res => {
      const outDir = path.join(__dirname, '..', '.agents', 'teamwork', 'worker_m4');
      if (fs.existsSync(outDir)) {
        fs.writeFileSync(path.join(outDir, 'dispatch_results.json'), JSON.stringify(res, null, 2), 'utf8');
      }
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal dispatch error:', err);
      process.exit(1);
    });
}

module.exports = { MessageDispatcher, dispatcher };
