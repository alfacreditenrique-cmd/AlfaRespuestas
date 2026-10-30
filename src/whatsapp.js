const {
  default: makeWASocket,
  useMultiFileAuthState,
  initAuthCreds,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isLidUser,
  Browsers
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
    this.status = 'DISCONNECTED'; // DISCONNECTED, QR_READY, CONNECTING, CONNECTED, PAUSED, CONFLICT, RESTRICTED
    this.qrDataUrl = null;
    this.qrRaw = null;
    this.pairingCode = null;
    this.connectionInfo = null;
    this.lastDisconnectReason = null;
    this.paused = false;
    this.needsFreshRegistration = false;
    this.listeners = new Set();
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.reconnectTimer = null;
    this.sendQueue = Promise.resolve();
    this.lastSentAt = 0;
    this.recentIncoming = new Map();
    this.lastMsgKeys = new Map();
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
      pairingCode: this.pairingCode,
      connectionInfo: this.connectionInfo,
      paused: this.paused,
      lastDisconnectReason: this.lastDisconnectReason,
      antiBanActive: true
    };
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;
  }

  // Pausar o reanudar el bot para evitar bloqueos o responder manualmente
  async setPaused(paused) {
    this.paused = Boolean(paused);
    this.clearReconnectTimer();
    if (this.paused) {
      await this.disconnect();
      this.status = 'PAUSED';
      this.lastDisconnectReason = 'Bot en pausa manual (Modo Seguro Anti-Bloqueo activo).';
      this.emitEvent('status_change', this.getStatus());
    } else {
      this.lastDisconnectReason = null;
      this.reconnectAttempts = 0;
      await this.start();
    }
    return this.getStatus();
  }

  // Solicitar código de vinculación de 8 dígitos por número telefónico (alternativa segura al QR)
  async requestPairingCode(phoneNumber) {
    const digits = CONFIG.normalizePhone(phoneNumber);
    if (!digits || digits.length < 8 || digits.length > 15) {
      throw new Error('Ingrese un número de teléfono válido (ej: 50575534509).');
    }
    if (this.status === 'CONNECTED') {
      throw new Error('WhatsApp ya se encuentra conectado y vinculado.');
    }

    this.paused = false;
    this.clearReconnectTimer();

    // Si hay un socket simulado en pruebas (sin WebSocket real), usarlo directamente
    const isMockSocket = this.sock && typeof this.sock.requestPairingCode === 'function' && !this.sock.ws;
    if (!isMockSocket) {
      const hasStaleLoginCreds = Boolean(this.sock?.authState?.creds?.me);
      if (!this.sock || this.status !== 'QR_READY' || hasStaleLoginCreds) {
        await this.start({ freshRegistration: true });
      }
      // Esperar a que el handshake de registro esté listo (evento qr o estado QR_READY)
      if (this.status !== 'QR_READY') {
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            off();
            resolve();
          }, 6000);
          const off = this.onEvent((type, data) => {
            if (type === 'qr' || (type === 'status_change' && (data?.status === 'QR_READY' || data?.status === 'DISCONNECTED'))) {
              clearTimeout(timeout);
              off();
              resolve();
            }
          });
        });
      }
    }

    if (!this.sock || typeof this.sock.requestPairingCode !== 'function') {
      throw new Error('El socket de WhatsApp aún se está inicializando. Intente de nuevo en 3 segundos.');
    }
    const rawCode = await this.sock.requestPairingCode(digits);
    const formatted = rawCode && rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
    this.pairingCode = formatted;
    this.emitEvent('pairing_code', { pairingCode: formatted, phoneNumber: digits });
    this.emitEvent('status_change', this.getStatus());
    return formatted;
  }

  // Inicializar socket de Baileys
  async start(options = {}) {
    this.clearReconnectTimer();
    if (this.paused) {
      this.status = 'PAUSED';
      this.emitEvent('status_change', this.getStatus());
      return;
    }
    try {
      if (this.sock) {
        const prevSock = this.sock;
        this.sock = null;
        try { await prevSock.end(); } catch {}
      }

      if (!fs.existsSync(CONFIG.AUTH_DIR)) {
        fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
      const useFresh = Boolean(options.freshRegistration || this.needsFreshRegistration);
      if (useFresh && typeof initAuthCreds === 'function') {
        state.creds = initAuthCreds();
        this.needsFreshRegistration = false;
      } else if (state.creds?.me && !state.creds?.account) {
        // Credencial incompleta de un intento previo de pairingCode sin concluir
        delete state.creds.me;
      }

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

      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        // Anti-Ban: desactivar descarga masiva de historial y presencia 24/7, usar firma estándar de navegador
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        browser: Browsers && typeof Browsers.ubuntu === 'function' ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 60000
      });
      this.sock = sock;

      // Guardar credenciales al actualizarse (solo si tienen identidad me para no corromper creds.json en disco)
      sock.ev.on('creds.update', () => {
        if (state.creds?.me?.id) {
          saveCreds();
        }
      });

      // Evento de conexión
      sock.ev.on('connection.update', async (update) => {
        if (this.sock !== sock) return;
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
          this.sock = null;
          this.qrDataUrl = null;
          this.connectionInfo = null;

          if (this.paused) {
            this.status = 'PAUSED';
            this.emitEvent('status_change', this.getStatus());
            return;
          }

          // 0) Reinicio requerido por WhatsApp tras emparejar exitosamente (515 restartRequired)
          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            this.reconnectAttempts = 0;
            this.needsFreshRegistration = false;
            await this.start();
            return;
          }

          // 1) Conflicto de sesión (440): otra instancia (ej. PC local vs Render) tiene abierta la misma sesión.
          // NUNCA reconectar en bucle porque la guerra de reconexiones provoca el bloqueo inmediato del número.
          if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
            this.status = 'CONFLICT';
            this.pairingCode = null;
            this.lastDisconnectReason = 'Sesión abierta en otro servidor o PC al mismo tiempo (Código 440). Reconexión detenida automáticamente para evitar bloqueo de WhatsApp.';
            console.warn('⚠️ [Anti-Ban]', this.lastDisconnectReason);
            this.emitEvent('status_change', this.getStatus());
            return;
          }

          // 2) Cuenta restringida o bloqueada temporalmente por WhatsApp (403 / 405)
          if (statusCode === 403 || statusCode === 405) {
            this.status = 'RESTRICTED';
            this.pairingCode = null;
            this.lastDisconnectReason = `WhatsApp restringió temporalmente la conexión (Código ${statusCode}). Se detuvo el bot para proteger el número. Usa el enlace web /agendar mientras se restablece.`;
            console.warn('🛑 [Anti-Ban]', this.lastDisconnectReason);
            this.emitEvent('status_change', this.getStatus());
            return;
          }

          // 3) Sesión cerrada desde el teléfono (401 loggedOut)
          if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
            this.status = 'DISCONNECTED';
            this.pairingCode = null;
            this.needsFreshRegistration = true;
            this.lastDisconnectReason = 'Sesión previa cerrada. Escanea el código QR o vincula con Código de 8 dígitos.';
            console.log('ℹ️ [WhatsApp]', this.lastDisconnectReason);
            this.emitEvent('status_change', this.getStatus());
            if (!useFresh) {
              setTimeout(() => {
                if (!this.paused) this.start({ freshRegistration: true });
              }, 800).unref();
            }
            return;
          }

          // 4) Desconexión de red normal: reconectar con backoff exponencial + jitter hasta el límite seguro
          const maxAttempts = CONFIG.ANTI_BAN?.MAX_RECONNECT_ATTEMPTS || 5;
          if (this.reconnectAttempts < maxAttempts) {
            this.status = 'DISCONNECTED';
            this.emitEvent('status_change', this.getStatus());
            this.reconnect();
          } else {
            this.status = 'DISCONNECTED';
            this.lastDisconnectReason = `Se alcanzó el límite seguro de ${maxAttempts} intentos de reconexión para proteger la cuenta.`;
            this.emitEvent('status_change', this.getStatus());
          }
        } else if (connection === 'open') {
          this.status = 'CONNECTED';
          this.qrDataUrl = null;
          this.pairingCode = null;
          this.lastDisconnectReason = null;
          this.needsFreshRegistration = false;
          this.reconnectAttempts = 0;
          this.connectionInfo = {
            id: sock?.user?.id || 'whatsapp_user',
            name: sock?.user?.name || 'AlfaCredit Bot'
          };
          this.emitEvent('status_change', this.getStatus());
          console.log('✅ Conexión con WhatsApp establecida exitosamente (Escudo Anti-Bloqueo activo).');
        }
      });

      // Historial recibido al vincular: mapear contactos y reconstruir citas desde los tickets que el bot ya envió
      this.sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
        try {
          if (Array.isArray(contacts)) {
            for (const c of contacts) {
              const lid = c.lid || (c.id && c.id.endsWith('@lid') ? c.id : null);
              const phone = c.jid ? c.jid.split('@')[0] : (c.id && c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : null);
              if (lid && phone && /^\d{8,11}$/.test(phone)) {
                database.savePhoneMapping(lid, phone, 'history_sync');
              }
            }
          }
        } catch (e) {
          console.error('[Phone Mapping] Error procesando contactos de historial:', e.message);
        }

        try {
          this.recoverFromHistory(messages);
        } catch (e) {
          console.error('[Recuperación] Error procesando historial:', e.message);
        }
      });

      // Ingestión de contactos para mapeo LID <-> Teléfono
      this.sock.ev.on('contacts.upsert', (contacts) => {
        try {
          if (Array.isArray(contacts)) {
            for (const c of contacts) {
              const lid = c.lid || (c.id && c.id.endsWith('@lid') ? c.id : null);
              const phone = c.jid ? c.jid.split('@')[0] : (c.id && c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : null);
              if (lid && phone && /^\d{8,11}$/.test(phone)) {
                database.savePhoneMapping(lid, phone, 'contacts.upsert');
              }
            }
          }
        } catch (e) {
          console.error('[Phone Mapping] Error en contacts.upsert:', e.message);
        }
      });

      this.sock.ev.on('contacts.update', (updates) => {
        try {
          if (Array.isArray(updates)) {
            for (const c of updates) {
              const lid = c.lid || (c.id && c.id.endsWith('@lid') ? c.id : null);
              const phone = c.jid ? c.jid.split('@')[0] : (c.id && c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : null);
              if (lid && phone && /^\d{8,11}$/.test(phone)) {
                database.savePhoneMapping(lid, phone, 'contacts.update');
              }
            }
          }
        } catch (e) {
          console.error('[Phone Mapping] Error en contacts.update:', e.message);
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

  // Reintento de conexión con backoff exponencial + jitter aleatorio (Anti-Ban)
  reconnect() {
    if (this.isReconnecting || this.paused) return;
    this.isReconnecting = true;
    const baseDelay = Math.min(60000, 5000 * Math.pow(1.8, this.reconnectAttempts++));
    const jitter = Math.floor(Math.random() * 2500);
    const delay = baseDelay + jitter;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.isReconnecting = false;
      if (!this.paused) await this.start();
    }, delay);
  }

  // Cola de envío con espaciado mínimo entre mensajes y simulación humana ("Escribiendo...")
  enqueueSend(taskFn) {
    const run = async () => {
      const minGap = CONFIG.ANTI_BAN?.MIN_SEND_GAP_MS ?? 1400;
      const elapsed = Date.now() - this.lastSentAt;
      if (this.lastSentAt > 0 && elapsed < minGap) {
        const waitMs = (minGap - elapsed) + Math.floor(Math.random() * 450);
        await new Promise(r => setTimeout(r, waitMs));
      }
      const res = await taskFn();
      this.lastSentAt = Date.now();
      return res;
    };
    this.sendQueue = this.sendQueue.then(run, run);
    return this.sendQueue;
  }

  // Simular lectura y escritura humana antes de enviar mensaje por socket real
  async simulateHumanTyping(jid, text, msgKey = null) {
    if (!this.sock) return;
    const minTyping = CONFIG.ANTI_BAN?.MIN_TYPING_MS ?? 1500;
    const maxTyping = CONFIG.ANTI_BAN?.MAX_TYPING_MS ?? 3500;
    if (maxTyping <= 0) return;

    try {
      if (msgKey && typeof this.sock.readMessages === 'function') {
        await this.sock.readMessages([msgKey]).catch(() => {});
      }
      if (typeof this.sock.sendPresenceUpdate === 'function') {
        await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      }
      const typingMs = Math.min(maxTyping, Math.max(minTyping, String(text || '').length * 10)) + Math.floor(Math.random() * 500);
      await new Promise(r => setTimeout(r, typingMs));
      if (typeof this.sock.sendPresenceUpdate === 'function') {
        await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
      }
    } catch {}
  }

  // Enviar mensaje a un número telefónico o JID
  async sendMessage(destination, text) {
    if (this.paused) {
      return { success: false, error: 'El bot de WhatsApp está en Modo Pausa (Anti-Bloqueo)' };
    }
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

      return await this.enqueueSend(async () => {
        await this.simulateHumanTyping(targetJid, text);
        console.log(`[WhatsApp] 📤 sendMessage hacia ${targetJid}...`);
        const result = await this.sock.sendMessage(targetJid, { text });
        console.log(`[WhatsApp] ✅ sendMessage exitoso a ${targetJid} (ID: ${result?.key?.id})`);
        return { success: true, messageId: result?.key?.id };
      });
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
      if (this.paused) return;

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
      if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

      const text = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.documentMessage?.caption ||
        m.videoMessage?.caption ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.templateButtonReplyMessage?.selectedId ||
        ''
      ).trim();

      if (!text) return;

      // Anti-Ban: ignorar ráfagas duplicadas idénticas del mismo remitente en ventana corta cuando el socket está activo
      const now = Date.now();
      const burstWindow = CONFIG.ANTI_BAN?.DUPLICATE_BURST_MS ?? 4000;
      if (this.sock && burstWindow > 0) {
        const prev = this.recentIncoming.get(chatId);
        if (prev && prev.text === text.toLowerCase() && (now - prev.ts) < burstWindow) {
          console.log(`[Anti-Ban] ⏳ Ignorando mensaje duplicado en ráfaga de ${replyJid}`);
          return;
        }
        this.recentIncoming.set(chatId, { text: text.toLowerCase(), ts: now });
      }
      this.lastMsgKeys.set(replyJid, msg.key);

      console.log(`[WhatsApp] 📩 Mensaje entrante de ${replyJid}: "${text}"`);

      // Normalización de texto y eliminación de diacríticos para coincidencia robusta
      const lowerText = text.toLowerCase();
      const normalizedText = text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();

      // =========================================================================
      // REQUISITO R2: Detección y Redirección de Consultas de Crédito / Préstamos
      // =========================================================================
      const creditKeywords = /\b(credito|creditos|prestamo|prestamos|prestame|presten|prestenme|financiamiento|financiar|financiarme|prestar|prestarme|empeno|empenar|tasa|tasas|interes|intereses|cuota|cuotas)\b/i;
      const employmentKeywords = /\b(vacante|vacantes|plaza|plazas|empleo|empleos|trabajo|trabajar|trabajando|laboral|laborales|postular|postularme|postularse|postulacion|postulaciones|postulante|postulantes|entrevista|entrevistas|cv|curriculum|curriculo|hoja de vida|hojas de vida|rrhh|recursos humanos|oficial de credito|promotor de credito|desembolsador de credito|desembolsador|contratacion|reclutamiento|seleccion|aplicar|aplicacion)\b/i;

      const isCreditInquiry = creditKeywords.test(normalizedText) && !employmentKeywords.test(normalizedText);

      if (isCreditInquiry) {
        console.log(`[WhatsApp] 🚫 Consulta de crédito interceptada de ${replyJid}: "${text}". Redirigiendo a Call Center.`);
        database.clearChatState(chatId);

        const creditNotice =
          `👋 ¡Hola! Gracias por comunicarte con *${CONFIG.COMPANY_NAME}*.\n\n` +
          `ℹ️ Te informamos que este canal de WhatsApp está dedicado *exclusivamente al proceso de selección y entrevistas de trabajo* (Recursos Humanos).\n\n` +
          `💰 Si deseas solicitar o consultar información sobre *créditos, préstamos o financiamiento*, por favor comunícate directamente con nuestro Call Center de Atención al Cliente a través del siguiente enlace:\n` +
          `👉 ${CONFIG.CALL_CENTER_URL || 'https://wa.me/50558096263'}\n\n` +
          `💼 Si estás interesado(a) en formar parte de nuestro equipo y postularte a una vacante laboral, por favor responde con la palabra *"EMPLEO"* o *"VACANTES"*.`;

        await this.reply(replyJid, creditNotice);
        return;
      }

      // Intentar extraer teléfono real si WhatsApp lo comparte en metadatos
      let extractedPhone = null;
      if (!isLid) {
        extractedPhone = chatId;
      } else if (msg.key.senderPn) {
        extractedPhone = msg.key.senderPn.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        database.savePhoneMapping(chatId, extractedPhone, 'senderPn');
      } else if (msg.key.participantPn) {
        extractedPhone = msg.key.participantPn.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        database.savePhoneMapping(chatId, extractedPhone, 'participantPn');
      }

      let state = database.getChatState(chatId);

      // Comandos explícitos de reinicio / cancelación / menú
      const explicitResetWords = ['cancelar', 'menu', 'inicio', 'volver', 'empezar', 'reiniciar', 'reprogramar'];
      const isExplicitReset = explicitResetWords.includes(lowerText) || explicitResetWords.includes(normalizedText);

      // =========================================================================
      // REQUISITO R1: Manejo de Intenciones de Consulta y Agendamiento
      // =========================================================================
      const inquiryKeywords = /\b(info|informacion|que necesito|requisitos|requisito|consulta|duda|ayuda|detalles|vacante|vacantes|plaza|plazas|empleo|empleos|trabajo|postular|postularme|postulacion)\b/i;
      const schedulingKeywords = /\b(agendar|agenda|reagendar|reprogramar|cita|citas|turno|turnos)\b/i;
      const isGeneralInquiryOrScheduling = inquiryKeywords.test(normalizedText) || schedulingKeywords.test(normalizedText);

      // Si el usuario envía comando explícito de reinicio, o si estaba en un estado intermedio
      // (AWAITING_DATE, AWAITING_NAME, AWAITING_PHONE) y envía una intención de consulta o agendamiento,
      // se reinicia el estado para permitirle volver al menú principal o reprogramar.
      if (isExplicitReset || (state && state.step !== 'AWAITING_POSITION' && isGeneralInquiryOrScheduling)) {
        database.clearChatState(chatId);
        state = null;
      }

      // Si no hay estado activo, verificar si ya tiene cita o enviar bienvenida
      if (!state || state.step === 'IDLE' || state.step === 'CONFIRMED') {
        const existingAppointment = database.getAppointmentByPhone(chatId) || (extractedPhone ? database.getAppointmentByPhone(extractedPhone) : null);
        const rescheduleWords = ['reprogramar', 'reagendar', 'cambiar', 'cambiar cita', 'nueva cita', 'otra cita', 'reiniciar', 'agendar', 'agenda'];
        const isRescheduleIntent = rescheduleWords.includes(lowerText) ||
          rescheduleWords.includes(normalizedText) ||
          /\b(reprogramar|reagendar|cambiar\s+cita|nueva\s+cita|otra\s+cita|reiniciar|agendar|agenda)\b/i.test(normalizedText);

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

        if (typeof database.savePhoneMapping === 'function') {
          database.savePhoneMapping(chatId, digits, 'user_input');
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
      const priorAppointment = database.getAppointmentByPhone(phoneNumber) || database.getAppointmentByPhone(chatId);

      // Verificar disponibilidad del slot (evitar colisiones concurrentes)
      let finalSlot = state.selected_time;
      let slotNotice = '';
      if (database.isSlotTaken(state.selected_date, finalSlot, priorAppointment?.id)) {
        const originalSlot12h = scheduler.formatTime12h(finalSlot);
        finalSlot = scheduler.getNextAvailableSlot(state.selected_date) ||
          (priorAppointment && priorAppointment.date === state.selected_date ? priorAppointment.time_slot : null);
        if (!finalSlot) {
          await this.reply(replyJid, `Lo sentimos, ese turno acaba de ser ocupado y no quedan más cupos en esa fecha. Por favor escribe "REINICIAR" para elegir otra fecha.`);
          return;
        }
        const newSlot12h = scheduler.formatTime12h(finalSlot);
        slotNotice = `⚠️ *Nota:* El turno de las ${originalSlot12h} fue tomado hace un instante. Te hemos asignado el siguiente turno inmediato disponible: *${newSlot12h}*.\n\n`;
      }

      // Si ya existía una cita activa previa de este mismo postulante, liberarla
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

      // Si es usuario LID, asegurar mapeo persistente
      if (typeof database.savePhoneMapping === 'function' && phoneNumber) {
        if (replyJid && replyJid.endsWith('@lid')) {
          database.savePhoneMapping(replyJid, phoneNumber, 'appointment_confirmed');
        } else if (chatId && chatId.length > 12) {
          database.savePhoneMapping(chatId, phoneNumber, 'appointment_confirmed');
        }
      }

      // Notificar en tiempo real al panel web con número normalizado
      const normalizedApt = {
        ...appointment,
        phone_number: typeof database.resolvePhoneNumber === 'function'
          ? database.resolvePhoneNumber(appointment.phone_number, appointment.jid)
          : appointment.phone_number
      };
      this.emitEvent('new_appointment', normalizedApt);

      // Enviar ticket formal
      const ticket = scheduler.generateTicket(appointment);
      const successMsg = `🎉 *¡ENHORABUENA! TU ENTREVISTA HA SIDO AGENDADA CON ÉXITO*\n\n` + slotNotice + ticket;

      await this.reply(replyJid, successMsg);
      database.markNotified(appointment.id);

      // Respaldo inmediato por WhatsApp al Administrador (solo si está explícitamente habilitado, para evitar bloqueos por spam)
      if (CONFIG.ADMIN_PHONE && CONFIG.ENABLE_ADMIN_WA_BACKUP) {
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
      if (CONFIG.ADMIN_PHONE && CONFIG.ENABLE_ADMIN_WA_BACKUP) {
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
    const msgKey = this.lastMsgKeys.get(jid) || null;
    this.lastMsgKeys.delete(jid);
    try {
      await this.enqueueSend(async () => {
        await this.simulateHumanTyping(jid, text, msgKey);
        console.log(`[WhatsApp] 📤 Respondiendo a ${jid}...`);
        const res = await this.sock.sendMessage(jid, { text });
        console.log(`[WhatsApp] ✅ Respuesta enviada exitosamente a ${jid} (msgId: ${res?.key?.id})`);
      });
    } catch (e) {
      console.error(`[WhatsApp] ❌ Error enviando respuesta a ${jid}:`, e.message);
    }
  }

  // Cerrar conexión
  async disconnect() {
    this.clearReconnectTimer();
    if (this.sock) {
      const prevSock = this.sock;
      this.sock = null;
      try {
        await prevSock.end();
      } catch {}
    }
    this.status = this.paused ? 'PAUSED' : 'DISCONNECTED';
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.connectionInfo = null;
    this.emitEvent('status_change', this.getStatus());
  }
}

// Singleton
const whatsappService = new WhatsAppService();
module.exports = whatsappService;

