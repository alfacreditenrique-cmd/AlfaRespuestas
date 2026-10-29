const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isLidUser
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const database = require('./database');
const scheduler = require('./scheduler');

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.status = 'DISCONNECTED'; // DISCONNECTED, QR_READY, CONNECTING, CONNECTED
    this.qrDataUrl = null;
    this.qrRaw = null;
    this.connectionInfo = null;
    this.listeners = new Set();
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
  }

  // Suscribirse a cambios de estado o eventos
  onEvent(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emitEvent(type, data) {
    for (const listener of this.listeners) {
      try {
        listener(type, data);
      } catch (err) {
        console.error('Error en listener de WhatsAppService:', err);
      }
    }
  }

  getStatus() {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      connectionInfo: this.connectionInfo
    };
  }

  // Inicializar socket de Baileys
  async start() {
    try {
      if (!fs.existsSync(CONFIG.AUTH_DIR)) {
        fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
      let version;
      try {
        const v = await fetchLatestBaileysVersion();
        version = v.version;
      } catch {
        version = [2, 3000, 1043857760];
      }

      this.status = 'CONNECTING';
      this.emitEvent('status_change', this.getStatus());

      const logger = pino({ level: 'silent' });

      this.sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        // Historial completo: al vincular el QR, WhatsApp envía los chats y así se recuperan las citas ya confirmadas
        syncFullHistory: true,
        browser: ['AlfaCredit S.A.', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        defaultQueryTimeoutMs: 60000
      });

      // Guardar credenciales al actualizarse
      this.sock.ev.on('creds.update', saveCreds);

      // Evento de conexión
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrRaw = qr;
          try {
            this.qrDataUrl = await QRCode.toDataURL(qr, {
              margin: 2,
              width: 320,
              color: { dark: '#0f172a', light: '#ffffff' }
            });
            this.status = 'QR_READY';
            this.emitEvent('qr', { qrDataUrl: this.qrDataUrl });
            this.emitEvent('status_change', this.getStatus());
          } catch (e) {
            console.error('Error generando QR DataURL:', e);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          this.status = 'DISCONNECTED';
          this.qrDataUrl = null;
          this.connectionInfo = null;
          this.emitEvent('status_change', this.getStatus());

          if (shouldReconnect) {
            this.reconnect();
          } else {
            console.log('Sesión cerrada permanentemente en WhatsApp. Limpiando credenciales...');
            try {
              fs.rmSync(CONFIG.AUTH_DIR, { recursive: true, force: true });
            } catch {}
            this.reconnect();
          }
        } else if (connection === 'open') {
          this.status = 'CONNECTED';
          this.qrDataUrl = null;
          this.reconnectAttempts = 0;
          this.connectionInfo = {
            id: this.sock?.user?.id || 'whatsapp_user',
            name: this.sock?.user?.name || 'AlfaCredit Bot'
          };
          this.emitEvent('status_change', this.getStatus());
          console.log('✅ Conexión con WhatsApp establecida exitosamente.');
        }
      });

      // Historial recibido al vincular: reconstruir citas desde los tickets que el bot ya envió
      this.sock.ev.on('messaging-history.set', ({ messages }) => {
        try {
          this.recoverFromHistory(messages);
        } catch (e) {
          console.error('[Recuperación] Error procesando historial:', e.message);
        }
      });

      // Mensajes entrantes
      this.sock.ev.on('messages.upsert', async (chatUpdate) => {
        if (chatUpdate.type === 'append') {
          try {
            this.recoverFromHistory(chatUpdate.messages);
          } catch (e) {
            console.error('[Recuperación] Error procesando historial append:', e.message);
          }
          return;
        }
        if (chatUpdate.type !== 'notify') return;

        for (const msg of chatUpdate.messages) {
          if (!msg.message) continue;
          if (msg.key.fromMe) {
            try { this.recoverFromHistory([msg]); } catch {}
            continue;
          }
          await this.handleIncomingMessage(msg);
        }
      });

    } catch (error) {
      console.error('Error iniciando servicio de WhatsApp:', error);
      this.status = 'DISCONNECTED';
      this.emitEvent('status_change', this.getStatus());
    }
  }

  // Reintento de conexión
  reconnect() {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    const delay = Math.min(30000, 3000 * Math.pow(1.5, this.reconnectAttempts++));
    setTimeout(async () => {
      this.isReconnecting = false;
      await this.start();
    }, delay);
  }

  // Enviar mensaje a un número telefónico o JID
  async sendMessage(destination, text) {
    if (this.status !== 'CONNECTED' || !this.sock) {
      return { success: false, error: 'WhatsApp no está conectado actualmente' };
    }

    try {
      let targetJid;
      const cleanDest = String(destination || '').trim();

      if (cleanDest.includes('@')) {
        targetJid = jidNormalizedUser(cleanDest);
      } else if (cleanDest.length > 12 && !cleanDest.startsWith('505') && !cleanDest.startsWith('502')) {
        // LID numérico sin dominio
        targetJid = `${cleanDest}@lid`;
      } else {
        const digits = CONFIG.normalizePhone(cleanDest);
        targetJid = `${digits}@s.whatsapp.net`;
      }

      console.log(`[WhatsApp] 📤 sendMessage hacia ${targetJid}...`);
      const result = await this.sock.sendMessage(targetJid, { text });
      console.log(`[WhatsApp] ✅ sendMessage exitoso a ${targetJid} (ID: ${result?.key?.id})`);
      return { success: true, messageId: result?.key?.id };
    } catch (err) {
      console.error(`[WhatsApp] ❌ Error enviando mensaje a ${destination}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  // Menú formal de selección de plaza
  getPositionsPrompt() {
    return (
      `📌 *Por favor selecciona la plaza a la que deseas postularte:*\n\n` +
      CONFIG.POSITIONS.map(p => `*${p.id}️⃣* ${p.title}`).join('\n') +
      `\n\n✍️ *Responde únicamente con el número de tu opción (1, 2 o 3).*`
    );
  }

  // Menú dinámico de selección de fecha con cupos en tiempo real
  getDatesPrompt() {
    const activeDates = database.getActiveDates();
    let msg = `📅 *Selecciona la fecha disponible para tu entrevista:*\n\n`;

    activeDates.forEach((d, idx) => {
      const remaining = scheduler.getRemainingCount(d.id);
      const nextSlot = scheduler.getNextAvailableSlot(d.id);
      const nextSlot12h = nextSlot ? scheduler.formatTime12h(nextSlot) : null;
      const num = idx + 1;

      msg += `*${num}️⃣* ${d.label}\n`;
      if (remaining === 0) {
        msg += `   ❌ *Agotado* (Sin turnos disponibles)\n`;
      } else {
        msg += `   🕒 Próximo turno disponible: *${nextSlot12h}*\n`;
        msg += `   📊 Cupos disponibles: *${remaining}*\n`;
        if (scheduler.isCriticalRemaining(d.id)) {
          msg += `   ⚠️ *¡ÚLTIMOS CUPOS! Quedan únicamente ${remaining} turnos disponibles.*\n`;
        }
      }
      msg += `\n`;
    });

    const optionsStr = activeDates.map((_, i) => `${i + 1}`).join(' o ');
    msg += `✍️ *Responde con ${optionsStr} para elegir tu fecha.*`;
    return msg;
  }

  // Procesamiento del flujo conversacional
  async handleIncomingMessage(msg) {
    try {
      const fromJid = msg.key.remoteJid;
      if (!fromJid || fromJid.includes('@g.us') || fromJid.includes('@broadcast') || fromJid.includes('newsletter')) {
        return; // Solo chats individuales
      }

      // Normalizar el JID exacto para responder. NUNCA reemplazar @lid por @s.whatsapp.net
      const replyJid = jidNormalizedUser(fromJid);
      const isLid = isLidUser(replyJid);

      // Clave identificadora en la base de datos
      const chatId = replyJid.split('@')[0];

      // Desenvolver mensajes efímeros/temporales y view-once
      let m = msg.message;
      if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
      if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
      if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;

      const text = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.templateButtonReplyMessage?.selectedId ||
        ''
      ).trim();

      if (!text) return;

      console.log(`[WhatsApp] 📩 Mensaje entrante de ${replyJid}: "${text}"`);

      // Intentar extraer teléfono real si WhatsApp lo comparte en metadatos
      let extractedPhone = null;
      if (!isLid) {
        extractedPhone = chatId;
      } else if (msg.key.senderPn) {
        extractedPhone = msg.key.senderPn.split('@')[0].split(':')[0];
      } else if (msg.key.participantPn) {
        extractedPhone = msg.key.participantPn.split('@')[0].split(':')[0];
      }

      const lowerText = text.toLowerCase();
      let state = database.getChatState(chatId);

      // Comandos explícitos de reinicio / cancelación / menú
      const explicitResetWords = ['cancelar', 'menu', 'inicio', 'volver', 'empezar', 'reiniciar', 'reprogramar'];
      const isExplicitReset = explicitResetWords.includes(lowerText);

      if (isExplicitReset) {
        database.clearChatState(chatId);
        state = null;
      }

      // Si no hay estado activo, verificar si ya tiene cita o enviar bienvenida
      if (!state || state.step === 'IDLE' || state.step === 'CONFIRMED') {
        const existingAppointment = database.getAppointmentByPhone(chatId) || (extractedPhone ? database.getAppointmentByPhone(extractedPhone) : null);
        const isRescheduleIntent = ['reprogramar', 'reagendar', 'cambiar', 'cambiar cita', 'nueva cita', 'otra cita', 'reiniciar', 'agendar', 'agenda'].includes(lowerText);

        // Si ya tiene cita activa y escribe una consulta regular (no reprogramación explícita)
        if (existingAppointment && !isRescheduleIntent) {
          const ticket = scheduler.generateTicket(existingAppointment);
          const reply = 
            `👋 Hola *${existingAppointment.candidate_name}*,\n\n` +
            `Ya tienes una entrevista agendada en *${CONFIG.COMPANY_NAME}*:\n\n` +
            ticket + `\n\n` +
            `ℹ️ *¿Deseas reprogramar tu cita?* Responde con la palabra *"REPROGRAMAR"* o *"REINICIAR"* para cambiar de fecha u horario.`;
          
          await this.reply(replyJid, reply);
          return;
        }

        // Si desea reprogramar su cita existente
        if (existingAppointment && isRescheduleIntent) {
          database.saveChatState(chatId, {
            step: 'AWAITING_POSITION',
            candidate_name: existingAppointment.candidate_name,
            jid: replyJid
          });

          const notice =
            `🔄 *REPROGRAMACIÓN DE ENTREVISTA - ${CONFIG.COMPANY_NAME}*\n\n` +
            `Estimado(a) *${existingAppointment.candidate_name}*, procederemos a reprogramar su cita.\n` +
            `Su turno anterior se liberará automáticamente al confirmar la nueva fecha.\n\n` +
            this.getPositionsPrompt();

          await this.reply(replyJid, notice);
          return;
        }

        // Bienvenida estándar para nuevo postulante
        database.saveChatState(chatId, { step: 'AWAITING_POSITION', jid: replyJid });

        const welcomeMsg =
          `👋 ¡Hola! Te damos la bienvenida a *${CONFIG.COMPANY_NAME}*.\n` +
          `Agradecemos tu interés en formar parte de nuestro equipo de trabajo.\n\n` +
          this.getPositionsPrompt();

        await this.reply(replyJid, welcomeMsg);
        return;
      }

      // ==========================================
      // PASO 1: Selección de Plaza (AWAITING_POSITION)
      // ==========================================
      if (state.step === 'AWAITING_POSITION') {
        const position = scheduler.resolvePosition(text);
        if (!position) {
          const warningMsg =
            `⚠️ *Opción no reconocida.* Por favor selecciona una opción válida:\n\n` +
            this.getPositionsPrompt();
          await this.reply(replyJid, warningMsg);
          return;
        }

        database.saveChatState(chatId, {
          step: 'AWAITING_DATE',
          selected_position: position.title,
          jid: replyJid
        });

        const datesMsg =
          `✅ Has seleccionado: *${position.title}*.\n\n` +
          this.getDatesPrompt();

        await this.reply(replyJid, datesMsg);
        return;
      }

      // ==========================================
      // PASO 2: Selección de Fecha (AWAITING_DATE)
      // ==========================================
      if (state.step === 'AWAITING_DATE') {
        const dateObj = scheduler.resolveDate(text);
        if (!dateObj) {
          const warningMsg =
            `⚠️ *Opción no reconocida.* Por favor selecciona una fecha válida:\n\n` +
            this.getDatesPrompt();
          await this.reply(replyJid, warningMsg);
          return;
        }

        const remaining = scheduler.getRemainingCount(dateObj.id);
        if (remaining === 0) {
          const activeDates = database.getActiveDates();
          const otherDate = activeDates.find(d => d.id !== dateObj.id && scheduler.getRemainingCount(d.id) > 0);
          let exhaustedMsg = `❌ Lo sentimos, los cupos para el *${dateObj.label}* se han agotado por completo.\n\n`;
          if (otherDate) {
            exhaustedMsg += `👉 Aún hay cupos disponibles para otras fechas:\n\n` + this.getDatesPrompt();
          } else {
            exhaustedMsg += `Actualmente no contamos con más turnos disponibles en ninguna fecha. Por favor comunícate directamente con Recursos Humanos.`;
            database.clearChatState(chatId);
          }
          await this.reply(replyJid, exhaustedMsg);
          return;
        }

        const nextSlot = scheduler.getNextAvailableSlot(dateObj.id);
        const timeFormatted = scheduler.formatTime12h(nextSlot);

        database.saveChatState(chatId, {
          step: 'AWAITING_NAME',
          selected_date: dateObj.id,
          selected_time: nextSlot,
          jid: replyJid
        });

        let confirmMsg = `🎯 ¡Excelente elección!\n\n`;
        confirmMsg += `Hemos reservado provisionalmente tu turno:\n`;
        confirmMsg += `📅 *Fecha:* ${dateObj.label}\n`;
        confirmMsg += `⏰ *Hora:* ${timeFormatted} (${nextSlot})\n\n`;

        if (scheduler.isCriticalRemaining(dateObj.id)) {
          confirmMsg += `⚠️ *¡ÚLTIMOS CUPOS!* Quedan únicamente *${remaining}* turnos disponibles para el ${dateObj.label}.\n\n`;
        }

        confirmMsg += `✍️ Para finalizar y emitir tu pase formal de entrevista, por favor escribe tu *Nombre Completo* (Nombres y Apellidos):`;

        await this.reply(replyJid, confirmMsg);
        return;
      }

      // ==========================================
      // PASO 3: Nombre Completo (AWAITING_NAME)
      // ==========================================
      if (state.step === 'AWAITING_NAME') {
        const candidateName = text.trim();
        const isValidName = this.isValidCandidateName(candidateName);
        if (!isValidName) {
          const warningMsg =
            `⚠️ *Nombre no reconocido.* Por favor escribe tu Nombre y Apellido completo para tu pase de entrevista:\n\n` +
            `👤 *Ejemplo:* Carlos Roberto Mendoza`;
          await this.reply(replyJid, warningMsg);
          return;
        }

        // Si es usuario LID y no tenemos su número real en metadatos, pedirlo
        if (isLid && !extractedPhone) {
          database.saveChatState(chatId, {
            step: 'AWAITING_PHONE',
            candidate_name: candidateName,
            jid: replyJid
          });

          const askPhoneMsg =
            `📱 ¡Muchas gracias, *${candidateName}*!\n\n` +
            `Como último paso para que Recursos Humanos pueda llamarte para tu entrevista, por favor escribe tu *Número de Teléfono o WhatsApp* (ej: 88888888 o 75534509):`;
          await this.reply(replyJid, askPhoneMsg);
          return;
        }

        // Si ya tenemos el número telefónico, finalizar
        await this.finalizeAppointment({
          chatId,
          replyJid,
          state,
          candidateName,
          phoneNumber: extractedPhone || chatId
        });
        return;
      }

      // ==========================================
      // PASO 4: Captura de teléfono si se requiere (AWAITING_PHONE)
      // ==========================================
      if (state.step === 'AWAITING_PHONE') {
        const digits = text.replace(/[^0-9]/g, '');
        if (digits.length < 8 || digits.length > 15) {
          const warningMsg =
            `⚠️ *Número telefónico no reconocido.* Por favor ingresa un número de teléfono o WhatsApp válido (mínimo 8 dígitos):\n\n` +
            `📱 *Ejemplo:* 88888888 o 75534509`;
          await this.reply(replyJid, warningMsg);
          return;
        }

        await this.finalizeAppointment({
          chatId,
          replyJid,
          state,
          candidateName: state.candidate_name,
          phoneNumber: digits
        });
        return;
      }

    } catch (err) {
      console.error('Error procesando mensaje entrante de WhatsApp:', err);
    }
  }

  // Validación robusta de nombre completo del candidato
  isValidCandidateName(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 5 || trimmed.length > 80) return false;

    const lower = trimmed.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Palabras o frases comunes que no corresponden a un nombre
    const conversationalPhrases = [
      'hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'buen dia',
      'gracias', 'muchas gracias', 'ayuda', 'info', 'informacion', 'consulta',
      'duda', 'tengo una duda', 'quiero agendar', 'por favor', 'saludos',
      'ok', 'okay', 'si', 'no', 'entendido', 'bien', 'vale', 'dale', 'reprogramar',
      'reiniciar', 'cancelar', 'menu', 'inicio'
    ];
    if (conversationalPhrases.includes(lower)) return false;

    // Prefijos conversacionales
    if (/^(hola|buenos?\s+d[ií]as?|buenas?\s+tardes?|buenas?\s+noches?|muchas?\s+gracias?|tengo\s+una?\s+duda|quiero\s+saber|saludos)\b/i.test(trimmed)) {
      return false;
    }

    // No debe contener números ni caracteres de URL o símbolos
    if (/[0-9@#$^&*_+=[\]{}|\\/<>~;:`]/.test(trimmed)) return false;

    // Solo letras, espacios, puntos, apóstrofes y guiones
    if (!/^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ' .-]+$/.test(trimmed)) return false;

    // Mínimo 2 palabras (Nombre y Apellido)
    const words = trimmed.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 2) return false;

    // Cada palabra debe contener al menos 2 caracteres o ser conectores permitidos
    for (const word of words) {
      const lettersOnly = word.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑüÜ]/g, '');
      if (lettersOnly.length < 2 && !['de', 'del', 'la', 'las', 'los', 'san', 'y'].includes(word.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  // Finalizar y emitir pase de entrevista
  async finalizeAppointment({ chatId, replyJid, state, candidateName, phoneNumber }) {
    try {
      // Verificar disponibilidad del slot (evitar colisiones concurrentes)
      let finalSlot = state.selected_time;
      let slotNotice = '';
      if (database.isSlotTaken(state.selected_date, finalSlot)) {
        const originalSlot12h = scheduler.formatTime12h(finalSlot);
        finalSlot = scheduler.getNextAvailableSlot(state.selected_date);
        if (!finalSlot) {
          await this.reply(replyJid, `Lo sentimos, ese turno acaba de ser ocupado y no quedan más cupos en esa fecha. Por favor escribe "REINICIAR" para elegir otra fecha.`);
          return;
        }
        const newSlot12h = scheduler.formatTime12h(finalSlot);
        slotNotice = `⚠️ *Nota:* El turno de las ${originalSlot12h} fue tomado hace un instante. Te hemos asignado el siguiente turno inmediato disponible: *${newSlot12h}*.\n\n`;
      }

      // Si ya existía una cita activa previa de este mismo postulante, liberarla
      const priorAppointment = database.getAppointmentByPhone(phoneNumber) || database.getAppointmentByPhone(chatId);
      if (priorAppointment) {
        database.cancelAppointment(priorAppointment.id, 'Reprogramada automáticamente por nueva solicitud vía WhatsApp bot');
      }

      // Crear la cita en Base de Datos con jid
      const appointment = database.createAppointment({
        candidate_name: candidateName,
        phone_number: phoneNumber,
        jid: replyJid,
        position: state.selected_position,
        date: state.selected_date,
        time_slot: finalSlot,
        notes: priorAppointment ? `Reprogramada desde cita previa #${priorAppointment.id}` : 'Agendado automáticamente vía WhatsApp bot'
      });

      // Limpiar estado
      database.clearChatState(chatId);

      // Notificar en tiempo real al panel web
      this.emitEvent('new_appointment', appointment);

      // Enviar ticket formal
      const ticket = scheduler.generateTicket(appointment);
      const successMsg = `🎉 *¡ENHORABUENA! TU ENTREVISTA HA SIDO AGENDADA CON ÉXITO*\n\n` + slotNotice + ticket;

      await this.reply(replyJid, successMsg);
      database.markNotified(appointment.id);

      // Respaldo inmediato por WhatsApp al Administrador
      if (CONFIG.ADMIN_PHONE) {
        try {
          const adminNotice =
            `💾 *RESPALDO AUTOMÁTICO DE CITA - ALFACREDIT S.A.*\n` +
            `══════════════════════════════\n` +
            `👤 *Postulante:* ${appointment.candidate_name}\n` +
            `📱 *Teléfono:* ${appointment.phone_number}\n` +
            `💼 *Plaza:* ${appointment.position}\n` +
            `📅 *Fecha:* ${scheduler.getDateLabel(appointment.date)}\n` +
            `⏰ *Hora:* ${scheduler.formatTime12h(appointment.time_slot)}\n` +
            `🆔 *ID Registro:* #${appointment.id}\n` +
            `══════════════════════════════\n` +
            `✅ *Copia guardada en el sistema de respaldo.*`;
          await this.sendMessage(CONFIG.ADMIN_PHONE, adminNotice);
        } catch (e) {
          console.warn('[WhatsApp] Error enviando respaldo al administrador:', e.message);
        }
      }

    } catch (err) {
      console.error('[WhatsApp] Error agendando cita:', err.message);
      await this.reply(replyJid, `⚠️ Ocurrió un inconveniente al registrar tu cita (${err.message}). Por favor responde con *"REINICIAR"* para volver a seleccionar tu turno.`);
    }
  }

  // Reconstruye citas a partir de los tickets/avisos que el bot envió (historial de WhatsApp).
  // Idempotente: no duplica citas que ya existen para ese chat o teléfono.
  recoverFromHistory(messages = []) {
    const getText = (m) => {
      let x = m.message || {};
      x = x.ephemeralMessage?.message || x;
      return x.conversation || x.extendedTextMessage?.text || '';
    };

    // Último estado conocido por chat, en orden cronológico
    const chats = new Map();
    const sorted = [...messages].sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
    for (const m of sorted) {
      const jid = m.key?.remoteJid ? jidNormalizedUser(m.key.remoteJid) : '';
      if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
      const text = getText(m);
      if (!text) continue;
      const chat = chats.get(jid) || { phone: null, apt: null };

      if (!m.key.fromMe) {
        const pn = (m.key?.senderPn || m.key?.participantPn || '').split('@')[0].split(':')[0];
        if (pn) chat.phone = pn;
        // Teléfono que el postulante escribió cuando el bot se lo pidió
        const digits = text.replace(/\D/g, '');
        if (/^[\d\s+\-()]+$/.test(text.trim()) && digits.length >= 8 && digits.length <= 15) chat.phone = digits;
      } else if (text.includes('NOTIFICACIÓN DE CANCELACIÓN')) {
        chat.apt = null;
      } else if (text.includes('CITA CONFIRMADA') || text.includes('AVISO DE ACTUALIZACIÓN')) {
        const name = (text.match(/\*Postulante:\*\s*(.+)/) || text.match(/Estimado\(a\)\s*\*(.+?)\*/) || [])[1];
        const position = (text.match(/\*Plaza:\*\s*(.+)/) || [])[1];
        const label = (text.match(/\*Fecha:\*\s*(.+)/) || [])[1];
        const time = (text.match(/\*Hora:\*.*\((\d{2}:\d{2})\)/) || [])[1];
        const date = label && this.resolveDateLabel(label.trim());
        if (name && position && date && time) {
          chat.apt = { candidate_name: name.trim(), position: position.trim(), date, time_slot: time };
        }
      }
      chats.set(jid, chat);
    }

    const recovered = [];
    for (const [jid, chat] of chats) {
      if (!chat.apt) continue;
      const phone = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : (chat.phone || jid.split('@')[0]);
      if (database.getAppointmentByPhone(jid) || database.getAppointmentByPhone(phone)) continue;
      try {
        const shared = database.isSlotTaken(chat.apt.date, chat.apt.time_slot);
        const apt = database.createAppointment({
          ...chat.apt,
          phone_number: phone,
          jid,
          recovery: true,
          notes: 'Recuperada del historial de WhatsApp' + (shared ? ' ⚠️ TURNO COMPARTIDO CON OTRA CITA, REVISAR' : '')
        });
        recovered.push(apt);
        this.emitEvent('new_appointment', apt);
      } catch (e) {
        console.error(`[Recuperación] No se pudo recuperar la cita de ${jid}:`, e.message);
      }
    }

    if (recovered.length) {
      console.log(`♻️ [Recuperación] ${recovered.length} cita(s) restauradas desde el historial de WhatsApp.`);
      if (CONFIG.ADMIN_PHONE) {
        this.sendMessage(CONFIG.ADMIN_PHONE,
          `♻️ *RECUPERACIÓN AUTOMÁTICA - ${CONFIG.COMPANY_NAME}*\n\n` +
          `Se restauraron *${recovered.length}* cita(s) desde el historial de WhatsApp:\n\n` +
          recovered.map(a => `• ${a.candidate_name} - ${scheduler.getDateLabel(a.date)} ${scheduler.formatTime12h(a.time_slot)}`).join('\n')
        ).catch(() => {});
      }
    }
    return recovered;
  }

  // Convierte "Jueves 6 de Noviembre" en el id de fecha; si la fecha no existe (agregada en el panel y perdida), la recrea
  resolveDateLabel(label) {
    const all = database.listDates();
    const found = all.find(d => d.label.toLowerCase() === label.toLowerCase());
    if (found) return found.id;
    const m = label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/(\d{1,2})\s+de\s+([a-z]+)/);
    const month = m ? MONTHS_ES.indexOf(m[2]) + 1 : 0;
    if (!month) return null;
    const year = (CONFIG.DATES[0]?.id || '2025').slice(0, 4);
    const id = `${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!all.find(d => d.id === id)) database.addDate({ id, label });
    return id;
  }

  async reply(jid, text) {
    if (!this.sock) {
      console.warn('[WhatsApp] No hay socket activo para responder.');
      return;
    }
    try {
      console.log(`[WhatsApp] 📤 Respondiendo a ${jid}...`);
      const res = await this.sock.sendMessage(jid, { text });
      console.log(`[WhatsApp] ✅ Respuesta enviada exitosamente a ${jid} (msgId: ${res?.key?.id})`);
    } catch (e) {
      console.error(`[WhatsApp] ❌ Error enviando respuesta a ${jid}:`, e.message);
    }
  }

  // Cerrar conexión
  async disconnect() {
    if (this.sock) {
      try {
        await this.sock.end();
      } catch {}
      this.sock = null;
    }
    this.status = 'DISCONNECTED';
    this.qrDataUrl = null;
    this.emitEvent('status_change', this.getStatus());
  }
}

// Singleton
const whatsappService = new WhatsAppService();
module.exports = whatsappService;
