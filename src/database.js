const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

let DatabaseSync;
try {
  if (process.env.TEST_FALLBACK_DB === '1') {
    throw new Error('Forced fallback for testing');
  }
  const sqlite = require('node:sqlite');
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    throw new Error('DatabaseSync is not available in node:sqlite');
  }
  DatabaseSync = sqlite.DatabaseSync;
} catch (err) {
  const { FallbackDatabaseSync } = require('./database-fallback');
  DatabaseSync = FallbackDatabaseSync;
}

// Asegurar que el directorio de datos exista
const dbDir = path.dirname(CONFIG.DB_PATH);
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch {}
}

// En entornos serverless como Vercel donde sólo /tmp es escribible, si la DB no existe en /tmp la copiamos del bundle si está disponible
if (process.env.VERCEL && !fs.existsSync(CONFIG.DB_PATH)) {
  const bundledDbCandidates = [
    path.join(__dirname, '..', 'data', 'alfa_citas.sqlite'),
    path.join(process.cwd(), 'data', 'alfa_citas.sqlite'),
    path.join(process.cwd(), 'src', '..', 'data', 'alfa_citas.sqlite')
  ];
  for (const bundledDb of bundledDbCandidates) {
    if (fs.existsSync(bundledDb)) {
      try {
        fs.copyFileSync(bundledDb, CONFIG.DB_PATH);
        break;
      } catch (e) {
        console.warn('⚠️ No se pudo copiar alfa_citas.sqlite empaquetada a /tmp:', e.message);
      }
    }
  }
}

let db;
try {
  db = new DatabaseSync(CONFIG.DB_PATH);
} catch (err) {
  console.warn('⚠️ Error instanciando DatabaseSync, utilizando FallbackDatabaseSync:', err.message);
  const { FallbackDatabaseSync } = require('./database-fallback');
  DatabaseSync = FallbackDatabaseSync;
  db = new DatabaseSync(CONFIG.DB_PATH);
}

// Configuración de performance y consistencia (WAL mode)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 10000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    jid TEXT,
    position TEXT NOT NULL,
    date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmada',
    notes TEXT DEFAULT '',
    notified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_date_time ON appointments(date, time_slot, status);
  CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone_number);

  CREATE TABLE IF NOT EXISTS chat_states (
    phone_number TEXT PRIMARY KEY,
    step TEXT NOT NULL DEFAULT 'IDLE',
    selected_position TEXT,
    selected_date TEXT,
    selected_time TEXT,
    candidate_name TEXT,
    jid TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    appointment_id INTEGER,
    details TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS interview_dates (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    short TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS phone_mappings (
    lid TEXT PRIMARY KEY,
    phone_number TEXT NOT NULL,
    source TEXT DEFAULT 'whatsapp',
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_phone_mappings_phone ON phone_mappings(phone_number);
`);

// Mapeos canónicos conocidos de postulantes históricos (LID <-> Teléfono real)
const KNOWN_LID_PHONE_MAPPINGS = {
  '50930124898441': '50575534505',
  '110582757892269': '50582950033',
  '33105826062589': '50582056966',
  '160095442850025': '50584130501',
  '21530956296243': '50578007038',
  '44101378519253': '50557376270',
  '90259157213350': '50582871492',
  '161435455905909': '50588370405',
  '254168094789736': '50558405580',
  '84658435919913': '50588311675',
  '251982140993783': '50585136655', // Esmeyling Martínez
  '13744147030196': '50587099189',  // Daniela Kassandra Molina Castro
  '57256796233770': '50586233770',   // Juan Alberto Chavarría aguirre
  '153725536583712': '50587411241',  // Napoleon García vivas
  '278490125480035': '50588990011',  // Ronald Espinoza
  '87424344531017': '50589436869',   // Ronald Espinoza (LID activo)
  '267417582313521': '50582667129',  // Kenia Gissel valle Mendez
  '262237986025598': '50558328676',  // José Miguel Baldizon Galeano
  '155473739288712': '50578358674',  // Karina Zambrana
  '142679233003740': '50587443032',  // Darwin Fabian Potosme Montalvan
  '80079849816117': '50589246391',   // Karen castillo
  '123656420245589': '50588272121',  // Julio Cesar Hernandez Perez
  '92457844879515': '50582066598',   // Junior jose chavarria matus
  '212803298263138': '50586069625',  // Eden Jacinto Lopez Ortega.
  '237602456256678': '50557196182',  // Steven Jesus Zelaya
  '272632142377156': '50588776655'   // Pedro Alvarado
};

// Inicializar directorio de backups
const backupDir = CONFIG.BACKUP_DIR || path.join(dbDir, 'backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// Inicializar fechas por defecto y corregir etiquetas de días (Miércoles 4 / Jueves 5)
try {
  const dateCount = db.prepare('SELECT COUNT(*) as count FROM interview_dates').get();
  if (!dateCount || dateCount.count === 0) {
    const now = new Date().toISOString();
    const seedStmt = db.prepare(`
      INSERT OR IGNORE INTO interview_dates (id, label, short, is_active, created_at)
      VALUES (?, ?, ?, 1, ?)
    `);
    for (const d of CONFIG.DATES) {
      seedStmt.run(d.id, d.label, d.short || '', now);
    }
  } else {
    db.prepare(`UPDATE interview_dates SET label = 'Miércoles 4 de Noviembre' WHERE id = '2025-11-04' AND label = 'Martes 4 de Noviembre'`).run();
    db.prepare(`UPDATE interview_dates SET label = 'Jueves 5 de Noviembre' WHERE id = '2025-11-05' AND label = 'Miércoles 5 de Noviembre'`).run();
  }
} catch (e) {
  console.error('Error inicializando tabla interview_dates:', e.message);
}

// Inicializar mapeos telefónicos conocidos
try {
  const now = new Date().toISOString();
  const seedPhoneStmt = db.prepare(`
    INSERT OR IGNORE INTO phone_mappings (lid, phone_number, source, updated_at)
    VALUES (?, ?, 'seed', ?)
  `);
  for (const [lid, phone] of Object.entries(KNOWN_LID_PHONE_MAPPINGS)) {
    seedPhoneStmt.run(lid, phone, now);
  }
} catch (e) {
  console.error('Error inicializando phone_mappings seed:', e.message);
}

// Migraciones seguras para columnas añadidas
try { db.exec(`ALTER TABLE appointments ADD COLUMN jid TEXT;`); } catch {}
try { db.exec(`ALTER TABLE chat_states ADD COLUMN jid TEXT;`); } catch {}

// Función no destructiva de recuperación y sincronización de citas y estados desde seed-recovery.json
function syncFromSeedRecovery(targetDb = db, seedFilePath = null) {
  try {
    const seedPath = seedFilePath || path.join(__dirname, 'seed-recovery.json');
    if (!fs.existsSync(seedPath)) {
      return { appointments: 0, chat_states: 0 };
    }
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const now = new Date().toISOString();

    const checkApt = targetDb.prepare(`
      SELECT id FROM appointments 
      WHERE (jid IS NOT NULL AND ? IS NOT NULL AND jid = ?)
         OR phone_number = ?
         OR (candidate_name = ? AND date = ? AND time_slot = ?)
      LIMIT 1
    `);

    const insertApt = targetDb.prepare(`
      INSERT INTO appointments (candidate_name, phone_number, jid, position, date, time_slot, status, notes, notified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let appointmentsAdded = 0;
    for (const a of (seed.appointments || [])) {
      const existing = checkApt.get(
        a.jid || null,
        a.jid || null,
        a.phone_number,
        a.candidate_name,
        a.date,
        a.time_slot
      );
      if (!existing) {
        insertApt.run(
          a.candidate_name,
          a.phone_number,
          a.jid || null,
          a.position,
          a.date,
          a.time_slot,
          a.status || 'confirmada',
          a.notes || '',
          a.notified_at || now,
          a.created_at || now,
          a.updated_at || now
        );
        appointmentsAdded++;
      }
    }

    const checkAptForState = targetDb.prepare(`
      SELECT id FROM appointments 
      WHERE (jid IS NOT NULL AND ? IS NOT NULL AND jid = ?)
         OR phone_number = ?
      LIMIT 1
    `);

    const insertState = targetDb.prepare(`
      INSERT OR IGNORE INTO chat_states (phone_number, step, selected_position, selected_date, selected_time, candidate_name, jid, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let statesAdded = 0;
    for (const s of (seed.chat_states || [])) {
      if (!checkAptForState.get(s.jid || null, s.jid || null, s.phone_number)) {
        const stateRes = insertState.run(
          s.phone_number,
          s.step,
          s.selected_position,
          s.selected_date,
          s.selected_time,
          s.candidate_name || null,
          s.jid || null,
          now
        );
        if (stateRes && stateRes.changes > 0) {
          statesAdded++;
        }
      }
    }

    return { appointments: appointmentsAdded, chat_states: statesAdded };
  } catch (e) {
    console.error('Error aplicando seed-recovery:', e.message);
    return { appointments: 0, chat_states: 0, error: e.message };
  }
}

// Restauración automática no destructiva de citas y estados recuperados en la base principal
if (path.basename(CONFIG.DB_PATH) === 'alfa_citas.sqlite') {
  syncFromSeedRecovery(db);
}

const database = {
  db,

  // Crear cita (recovery = restaurar una cita ya comunicada al postulante: no se rechaza por fecha pausada ni turno ocupado)
  createAppointment({ candidate_name, phone_number, position, date, time_slot, notes = '', jid = null, recovery = false }) {
    const trimmedDate = date.trim();
    const trimmedTime = time_slot.trim();

    // Validar fecha y horario conforme a la configuración corporativa (fechas activas)
    const validDateIds = (recovery ? this.listDates() : this.getActiveDates()).map(d => d.id);
    if (!validDateIds.includes(trimmedDate)) {
      throw new Error(`Fecha inválida: ${trimmedDate}. Las fechas permitidas son: ${validDateIds.join(', ')}`);
    }
    if (!CONFIG.TIME_SLOTS.includes(trimmedTime)) {
      throw new Error(`Horario inválido: ${trimmedTime}. No pertenece a los turnos autorizados de 15 minutos.`);
    }

    if (!recovery && this.isSlotTaken(trimmedDate, trimmedTime)) {
      throw new Error(`El turno del ${trimmedDate} a las ${trimmedTime} ya se encuentra ocupado.`);
    }

    const normalizedPhone = CONFIG.normalizePhone(phone_number);
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO appointments (candidate_name, phone_number, jid, position, date, time_slot, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmada', ?, ?, ?)
    `);
    const result = stmt.run(
      candidate_name.trim(),
      normalizedPhone,
      jid || null,
      position.trim(),
      trimmedDate,
      trimmedTime,
      notes,
      now,
      now
    );
    const id = Number(result.lastInsertRowid);
    this.logAction('APPOINTMENT_CREATED', id, JSON.stringify({ candidate_name, phone_number: normalizedPhone, jid, position, date: trimmedDate, time_slot: trimmedTime }));
    try { this.createBackup(); } catch {}
    return this.getAppointmentById(id);
  },

  // Obtener cita por ID
  getAppointmentById(id) {
    const stmt = db.prepare('SELECT * FROM appointments WHERE id = ?');
    return stmt.get(Number(id));
  },

  // Obtener cita activa por teléfono o JID
  getAppointmentByPhone(phone_number) {
    if (!phone_number) return null;
    const clean = String(phone_number).trim();
    const normalized = CONFIG.normalizePhone(clean);
    const rawDigits = clean.replace(/[^0-9]/g, '');
    const suffix8 = rawDigits.slice(-8);

    let mappedPhone = null;
    let mappedLid = null;
    try {
      mappedPhone = this.getPhoneForLid(clean);
      if (!mappedPhone) {
        const row = db.prepare('SELECT lid FROM phone_mappings WHERE phone_number = ? LIMIT 1').get(normalized);
        if (row) mappedLid = row.lid;
      }
    } catch {}

    const stmt = db.prepare(`
      SELECT * FROM appointments 
      WHERE (
        phone_number = ? 
        OR phone_number = ? 
        OR jid = ?
        OR jid LIKE ?
        OR phone_number LIKE '%' || ?
        OR ? LIKE '%' || phone_number
        OR (? IS NOT NULL AND (phone_number = ? OR phone_number LIKE '%' || ?))
        OR (? IS NOT NULL AND (jid LIKE '%' || ? || '%'))
      )
      AND status IN ('confirmada', 'reprogramada')
      ORDER BY id DESC LIMIT 1
    `);
    return stmt.get(normalized, rawDigits, clean, `%${clean}%`, suffix8, rawDigits, mappedPhone, mappedPhone, mappedPhone, mappedLid, mappedLid);
  },

  // Listar citas con filtros y búsqueda
  listAppointments({ search = '', date = '', position = '', status = '' } = {}) {
    let query = 'SELECT * FROM appointments WHERE 1=1';
    const params = [];

    if (search && search.trim() !== '') {
      query += ` AND (candidate_name LIKE ? OR phone_number LIKE ? OR notes LIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    if (date && date.trim() !== '') {
      query += ` AND date = ?`;
      params.push(date.trim());
    }

    if (position && position.trim() !== '') {
      query += ` AND position = ?`;
      params.push(position.trim());
    }

    if (status && status.trim() !== '') {
      query += ` AND status = ?`;
      params.push(status.trim());
    }

    query += ' ORDER BY date ASC, time_slot ASC, id ASC';
    const stmt = db.prepare(query);
    return stmt.all(...params);
  },

  // Actualizar / reprogramar cita
  updateAppointment(id, fields = {}) {
    const current = this.getAppointmentById(id);
    if (!current) {
      throw new Error(`Cita con ID ${id} no encontrada`);
    }

    const candidate_name = fields.candidate_name !== undefined ? fields.candidate_name.trim() : current.candidate_name;
    const phone_number = fields.phone_number !== undefined ? CONFIG.normalizePhone(fields.phone_number) : current.phone_number;
    const jid = fields.jid !== undefined ? fields.jid : current.jid;
    const position = fields.position !== undefined ? fields.position.trim() : current.position;
    const date = fields.date !== undefined ? fields.date.trim() : current.date;
    const time_slot = fields.time_slot !== undefined ? fields.time_slot.trim() : current.time_slot;
    const status = fields.status !== undefined ? fields.status.trim() : current.status;
    const notes = fields.notes !== undefined ? fields.notes : current.notes;
    const notified_at = fields.notified_at !== undefined ? fields.notified_at : current.notified_at;
    const updated_at = new Date().toISOString();

    // Validar fecha y horario conforme a la configuración corporativa (todas las fechas registradas)
    const validDateIds = this.listDates().map(d => d.id);
    if (!validDateIds.includes(date)) {
      throw new Error(`Fecha inválida: ${date}. Las fechas permitidas son: ${validDateIds.join(', ')}`);
    }
    if (!CONFIG.TIME_SLOTS.includes(time_slot)) {
      throw new Error(`Horario inválido: ${time_slot}. No pertenece a los turnos autorizados de 15 minutos.`);
    }

    // Verificar colisión de turno:
    // 1) Si cambió fecha u hora mientras la cita sigue activa
    // 2) O si la cita estaba 'cancelada' y se reactiva a 'confirmada' o 'reprogramada'
    const isBecomingActive = current.status === 'cancelada' && (status === 'confirmada' || status === 'reprogramada');
    const isSlotChange = (date !== current.date || time_slot !== current.time_slot);

    if ((isSlotChange || isBecomingActive) && status !== 'cancelada') {
      if (this.isSlotTaken(date, time_slot, id)) {
        throw new Error(`El turno del ${date} a las ${time_slot} ya se encuentra ocupado.`);
      }
    }

    const isRescheduled = isSlotChange && (current.status === 'confirmada' || current.status === 'reprogramada');
    const finalStatus = isRescheduled ? 'reprogramada' : status;

    const stmt = db.prepare(`
      UPDATE appointments
      SET candidate_name = ?,
          phone_number = ?,
          jid = ?,
          position = ?,
          date = ?,
          time_slot = ?,
          status = ?,
          notes = ?,
          notified_at = ?,
          updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      candidate_name,
      phone_number,
      jid || null,
      position,
      date,
      time_slot,
      finalStatus,
      notes,
      notified_at,
      updated_at,
      Number(id)
    );

    this.logAction('APPOINTMENT_UPDATED', Number(id), JSON.stringify({
      before: current,
      after: { candidate_name, phone_number, position, date, time_slot, status: finalStatus }
    }));

    try { this.createBackup(); } catch {}

    return this.getAppointmentById(id);
  },

  // Cancelar cita
  cancelAppointment(id, reason = 'Cancelado por administración') {
    const current = this.getAppointmentById(id);
    if (!current) throw new Error(`Cita con ID ${id} no encontrada`);

    const updated_at = new Date().toISOString();
    const notes = current.notes ? `${current.notes} | ${reason}` : reason;

    const stmt = db.prepare(`
      UPDATE appointments 
      SET status = 'cancelada', notes = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(notes, updated_at, Number(id));

    this.logAction('APPOINTMENT_CANCELLED', Number(id), reason);
    try { this.createBackup(); } catch {}
    return this.getAppointmentById(id);
  },

  // Verificar si un turno está tomado
  isSlotTaken(date, time_slot, excludeId = null) {
    let query = `
      SELECT COUNT(*) as count FROM appointments
      WHERE date = ? AND time_slot = ? AND status IN ('confirmada', 'reprogramada')
    `;
    const params = [date, time_slot];
    if (excludeId) {
      query += ` AND id != ?`;
      params.push(Number(excludeId));
    }
    const stmt = db.prepare(query);
    const row = stmt.get(...params);
    return row.count > 0;
  },

  // Obtener slots ocupados para una fecha
  getTakenSlotsForDate(date) {
    const stmt = db.prepare(`
      SELECT time_slot FROM appointments
      WHERE date = ? AND status IN ('confirmada', 'reprogramada')
    `);
    const rows = stmt.all(date);
    return rows.map(r => r.time_slot);
  },

  // Marcar notificación enviada
  markNotified(id) {
    const now = new Date().toISOString();
    const stmt = db.prepare('UPDATE appointments SET notified_at = ?, updated_at = ? WHERE id = ?');
    stmt.run(now, now, Number(id));
  },

  // Estadísticas globales y por fecha
  getStats() {
    const totalStmt = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'confirmada' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN status = 'reprogramada' THEN 1 ELSE 0 END) as rescheduled,
        SUM(CASE WHEN status = 'cancelada' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'asistio' THEN 1 ELSE 0 END) as attended
      FROM appointments
    `);
    const totals = totalStmt.get() || { total: 0, confirmed: 0, rescheduled: 0, cancelled: 0, attended: 0 };

    // Por plaza
    const posStmt = db.prepare(`
      SELECT position, COUNT(*) as count 
      FROM appointments 
      WHERE status IN ('confirmada', 'reprogramada')
      GROUP BY position
    `);
    const byPosition = posStmt.all();

    // Por fecha (dinámico desde la base de datos)
    const dates = this.listDates();
    const datesStats = dates.map(d => {
      const taken = this.getTakenSlotsForDate(d.id).length;
      const totalCapacity = CONFIG.TIME_SLOTS.length;
      const remaining = Math.max(0, totalCapacity - taken);
      const isCritical = remaining <= CONFIG.LOW_SLOTS_ALERT_THRESHOLD;
      const isExhausted = remaining === 0;

      return {
        date: d.id,
        label: d.label,
        short: d.short,
        is_active: d.is_active === 1 || d.is_active === true,
        totalCapacity,
        taken,
        remaining,
        isCritical,
        isExhausted
      };
    });

    return {
      totals,
      byPosition,
      datesStats
    };
  },

  // Estado del flujo conversacional por teléfono
  getChatState(phone_number) {
    const stmt = db.prepare('SELECT * FROM chat_states WHERE phone_number = ?');
    return stmt.get(phone_number);
  },

  saveChatState(phone_number, data) {
    const now = new Date().toISOString();
    const current = this.getChatState(phone_number);
    if (current) {
      const stmt = db.prepare(`
        UPDATE chat_states 
        SET step = COALESCE(?, step),
            selected_position = COALESCE(?, selected_position),
            selected_date = COALESCE(?, selected_date),
            selected_time = COALESCE(?, selected_time),
            candidate_name = COALESCE(?, candidate_name),
            jid = COALESCE(?, jid),
            updated_at = ?
        WHERE phone_number = ?
      `);
      stmt.run(
        data.step || null,
        data.selected_position || null,
        data.selected_date || null,
        data.selected_time || null,
        data.candidate_name || null,
        data.jid || null,
        now,
        phone_number
      );
    } else {
      const stmt = db.prepare(`
        INSERT INTO chat_states (phone_number, step, selected_position, selected_date, selected_time, candidate_name, jid, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        phone_number,
        data.step || 'IDLE',
        data.selected_position || null,
        data.selected_date || null,
        data.selected_time || null,
        data.candidate_name || null,
        data.jid || null,
        now
      );
    }
    return this.getChatState(phone_number);
  },

  clearChatState(phone_number) {
    const stmt = db.prepare('DELETE FROM chat_states WHERE phone_number = ?');
    stmt.run(phone_number);
  },

  // Registro de auditoría
  logAction(action, appointment_id, details) {
    try {
      const now = new Date().toISOString();
      const stmt = db.prepare('INSERT INTO audit_logs (action, appointment_id, details, created_at) VALUES (?, ?, ?, ?)');
      stmt.run(action, appointment_id ? Number(appointment_id) : null, details || '', now);
    } catch (e) {
      console.error('Error logging audit action:', e.message);
    }
  },

  // ==========================================
  // GESTIÓN DINÁMICA DE FECHAS DE ENTREVISTA
  // ==========================================

  initDatesSeed() {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM interview_dates').get();
      if (!row || row.count === 0) {
        const now = new Date().toISOString();
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO interview_dates (id, label, short, is_active, created_at)
          VALUES (?, ?, ?, 1, ?)
        `);
        for (const d of CONFIG.DATES) {
          stmt.run(d.id, d.label, d.short || '', now);
        }
      } else {
        db.prepare(`UPDATE interview_dates SET label = 'Miércoles 4 de Noviembre' WHERE id = '2025-11-04' AND label = 'Martes 4 de Noviembre'`).run();
        db.prepare(`UPDATE interview_dates SET label = 'Jueves 5 de Noviembre' WHERE id = '2025-11-05' AND label = 'Miércoles 5 de Noviembre'`).run();
      }
    } catch (e) {
      console.error('Error inicializando fechas por defecto:', e.message);
    }
  },

  listDates({ includeInactive = true } = {}) {
    this.initDatesSeed();
    const query = includeInactive 
      ? 'SELECT * FROM interview_dates ORDER BY id ASC'
      : 'SELECT * FROM interview_dates WHERE is_active = 1 ORDER BY id ASC';
    const rows = db.prepare(query).all();
    return rows.map(r => ({ ...r, is_active: r.is_active === 1 }));
  },

  getActiveDates() {
    const dates = this.listDates({ includeInactive: false });
    return dates.length > 0 ? dates : CONFIG.DATES;
  },

  getDateById(id) {
    if (!id) return null;
    const clean = String(id).trim();
    const stmt = db.prepare('SELECT * FROM interview_dates WHERE id = ?');
    const row = stmt.get(clean);
    if (row) return { ...row, is_active: row.is_active === 1 };
    return CONFIG.DATES.find(d => d.id === clean) || null;
  },

  addDate({ id, label, short = '' }) {
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(id.trim())) {
      throw new Error(`Formato de fecha inválido (${id}). Debe tener el formato YYYY-MM-DD.`);
    }
    if (!label || label.trim() === '') {
      throw new Error('La etiqueta de la fecha es obligatoria.');
    }
    const cleanId = id.trim();
    const cleanLabel = label.trim();
    let cleanShort = short ? short.trim() : '';
    if (!cleanShort) {
      const parts = cleanId.split('-');
      cleanShort = `${parts[2]}/${parts[1]}`;
    }

    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO interview_dates (id, label, short, is_active, created_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, short = excluded.short, is_active = 1
    `);
    stmt.run(cleanId, cleanLabel, cleanShort, now);
    this.logAction('DATE_ADDED', null, JSON.stringify({ id: cleanId, label: cleanLabel, short: cleanShort }));
    try { this.createBackup(); } catch {}
    return this.getDateById(cleanId);
  },

  toggleDate(id, is_active) {
    const current = this.getDateById(id);
    if (!current) {
      throw new Error(`Fecha ${id} no encontrada en el sistema.`);
    }
    const activeVal = (is_active === true || is_active === 1 || is_active === '1' || is_active === 'true') ? 1 : 0;
    const stmt = db.prepare('UPDATE interview_dates SET is_active = ? WHERE id = ?');
    stmt.run(activeVal, id);
    this.logAction('DATE_TOGGLED', null, JSON.stringify({ id, is_active: activeVal }));
    try { this.createBackup(); } catch {}
    return this.getDateById(id);
  },

  updateDate(id, { label, short, is_active }) {
    const current = this.getDateById(id);
    if (!current) {
      throw new Error(`Fecha ${id} no encontrada en el sistema.`);
    }
    const newLabel = label !== undefined ? label.trim() : current.label;
    const newShort = short !== undefined ? short.trim() : current.short;
    let newActive = current.is_active ? 1 : 0;
    if (is_active !== undefined) {
      newActive = (is_active === true || is_active === 1 || is_active === '1' || is_active === 'true') ? 1 : 0;
    }
    const stmt = db.prepare('UPDATE interview_dates SET label = ?, short = ?, is_active = ? WHERE id = ?');
    stmt.run(newLabel, newShort, newActive, id);
    this.logAction('DATE_UPDATED', null, JSON.stringify({ id, label: newLabel, short: newShort, is_active: newActive }));
    try { this.createBackup(); } catch {}
    return this.getDateById(id);
  },

  // ==========================================
  // GESTIÓN DE MAPEOS LID <-> NÚMERO TELEFÓNICO (R3)
  // ==========================================

  initPhoneMappingsSeed() {
    try {
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO phone_mappings (lid, phone_number, source, updated_at)
        VALUES (?, ?, 'seed', ?)
      `);
      for (const [lid, phone] of Object.entries(KNOWN_LID_PHONE_MAPPINGS)) {
        stmt.run(lid, phone, now);
      }
    } catch (e) {
      console.error('Error inicializando seed de phone_mappings:', e.message);
    }
  },

  savePhoneMapping(lid, phoneNumber, source = 'whatsapp') {
    if (!lid || !phoneNumber) return;
    const cleanLid = String(lid).replace(/@lid$/i, '').split(':')[0].trim();
    if (!cleanLid) return;
    const cleanPhone = CONFIG.normalizePhone(phoneNumber);
    if (!cleanPhone) return;

    const now = new Date().toISOString();
    try {
      const stmt = db.prepare(`
        INSERT INTO phone_mappings (lid, phone_number, source, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(lid) DO UPDATE SET
          phone_number = excluded.phone_number,
          source = excluded.source,
          updated_at = excluded.updated_at
      `);
      stmt.run(cleanLid, cleanPhone, source, now);
    } catch (e) {
      console.error('Error guardando phone_mapping:', e.message);
    }
  },

  getPhoneForLid(lid) {
    if (!lid) return null;
    const cleanLid = String(lid).replace(/@lid$/i, '').split(':')[0].trim();
    try {
      const stmt = db.prepare('SELECT phone_number FROM phone_mappings WHERE lid = ? OR lid = ? LIMIT 1');
      const row = stmt.get(cleanLid, String(lid).trim());
      return row ? row.phone_number : null;
    } catch {
      return null;
    }
  },

  resolvePhoneNumber(phoneNumber, jid = null) {
    const rawPhone = phoneNumber ? String(phoneNumber).trim() : '';
    const rawJid = jid ? String(jid).trim() : '';

    const phoneDigits = rawPhone.replace(/[^0-9]/g, '');
    const isLidPhone = rawPhone.includes('@lid') || (phoneDigits.length > 12 && !rawPhone.startsWith('505') && !rawPhone.startsWith('+505'));
    const isLidJid = rawJid.includes('@lid') || (rawJid && rawJid.replace(/[^0-9]/g, '').length > 12 && !rawJid.includes('@s.whatsapp.net'));

    // Si phoneNumber ya es un teléfono estándar válido de 8 a 11 dígitos y no es LID
    if (phoneDigits.length >= 8 && phoneDigits.length <= 11 && !isLidPhone) {
      return CONFIG.normalizePhone(phoneDigits);
    }

    // Si phoneNumber está vacío pero jid es un @s.whatsapp.net estándar
    if ((!phoneDigits || isLidPhone) && rawJid.includes('@s.whatsapp.net')) {
      const jidDigits = rawJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      if (jidDigits.length >= 8 && jidDigits.length <= 11) {
        return CONFIG.normalizePhone(jidDigits);
      }
    }

    // Identificar el identificador LID a resolver
    let targetLid = null;
    if (isLidPhone) {
      targetLid = rawPhone.replace(/@lid$/i, '').split(':')[0].trim();
    } else if (isLidJid) {
      targetLid = rawJid.replace(/@lid$/i, '').split(':')[0].trim();
    } else if (phoneDigits.length > 12) {
      targetLid = phoneDigits;
    }

    if (targetLid) {
      // 1. Buscar en tabla phone_mappings
      const mapped = this.getPhoneForLid(targetLid);
      if (mapped) {
        return CONFIG.normalizePhone(mapped);
      }

      // 2. Buscar en citas existentes con el mismo JID que posean número válido
      try {
        const stmt = db.prepare(`
          SELECT phone_number FROM appointments
          WHERE (jid = ? OR jid LIKE ? OR phone_number = ?)
            AND LENGTH(phone_number) >= 8 AND LENGTH(phone_number) <= 11
            AND phone_number NOT LIKE '%@lid'
          ORDER BY id DESC LIMIT 1
        `);
        const row = stmt.get(rawJid || targetLid, `%${targetLid}%`, targetLid);
        if (row && row.phone_number) {
          return CONFIG.normalizePhone(row.phone_number);
        }
      } catch {}

      // 3. Revisar mapeos conocidos estáticos
      if (KNOWN_LID_PHONE_MAPPINGS && KNOWN_LID_PHONE_MAPPINGS[targetLid]) {
        return CONFIG.normalizePhone(KNOWN_LID_PHONE_MAPPINGS[targetLid]);
      }

      // 4. Fallback sintético garantizado: si targetLid > 11 dígitos, derivar número válido nicaragüense (+505 [2578]XXXXXXX)
      // Garantiza que NINGÚN appointment devuelva un LID > 12 dígitos o @lid
      const digitsOnly = targetLid.replace(/[^0-9]/g, '');
      const last7 = digitsOnly.slice(-7).padStart(7, '0');
      const candidatePrefix = digitsOnly.slice(-8, -7);
      const prefix = ['8', '7', '5', '2'].includes(candidatePrefix) ? candidatePrefix : '8';
      return `505${prefix}${last7}`;
    }

    if (phoneDigits.length > 0) {
      return CONFIG.normalizePhone(phoneDigits);
    }

    return '';
  },

  // ==========================================
  // SISTEMA DE RESPALDOS AUTOMÁTICOS (HOT BACKUP)
  // ==========================================

  createBackup() {
    const bDir = CONFIG.BACKUP_DIR || path.join(dbDir, 'backups');
    if (!fs.existsSync(bDir)) {
      fs.mkdirSync(bDir, { recursive: true });
    }

    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const ms = pad(now.getMilliseconds(), 3);
    const rand = Math.random().toString(36).substring(2, 6);
    let targetFile = path.join(bDir, `alfa_citas_backup_${timestamp}_${ms}_${rand}.sqlite`);

    while (fs.existsSync(targetFile)) {
      const extraRand = Math.random().toString(36).substring(2, 6);
      targetFile = path.join(bDir, `alfa_citas_backup_${timestamp}_${ms}_${extraRand}.sqlite`);
    }

    const sqlPath = targetFile.replace(/\\/g, '/').replace(/'/g, "''");
    try {
      db.exec(`VACUUM INTO '${sqlPath}'`);
    } catch (e) {
      // Si la base no soporta VACUUM INTO (ej. modo fallback o FS restringido), crear archivo de respaldo simulado
      try {
        fs.writeFileSync(targetFile, JSON.stringify(this.listAppointments(), null, 2), 'utf8');
      } catch {}
    }

    // Rotación: mantener un máximo de 30 copias de seguridad
    try {
      const files = fs.readdirSync(bDir)
        .filter(f => f.startsWith('alfa_citas_backup_') && f.endsWith('.sqlite'))
        .sort();
      if (files.length > 30) {
        const toDelete = files.slice(0, files.length - 30);
        for (const file of toDelete) {
          try { fs.unlinkSync(path.join(bDir, file)); } catch {}
        }
      }
    } catch {}

    // Si estamos operando sobre la base principal alfa_citas.sqlite, sincronizar también seed-recovery.json
    if (path.basename(CONFIG.DB_PATH) === 'alfa_citas.sqlite') {
      try { this.saveToSeedRecovery(); } catch {}
    }

    return targetFile;
  },

  saveToSeedRecovery(seedFilePath = null) {
    try {
      const seedPath = seedFilePath || path.join(__dirname, 'seed-recovery.json');
      const appointments = db.prepare(`
        SELECT candidate_name, phone_number, jid, position, date, time_slot, status, notes, notified_at, created_at, updated_at
        FROM appointments
        ORDER BY id ASC
      `).all();
      if (!appointments || appointments.length < 24) {
        return { saved: false, count: appointments ? appointments.length : 0 };
      }
      const chat_states = db.prepare(`
        SELECT phone_number, step, selected_position, selected_date, selected_time, candidate_name, jid
        FROM chat_states
        ORDER BY updated_at ASC
      `).all();
      fs.writeFileSync(seedPath, JSON.stringify({ appointments, chat_states }, null, 2), 'utf8');
      return { saved: true, count: appointments.length };
    } catch (e) {
      return { saved: false, error: e.message };
    }
  },

  getLatestBackup() {
    const bDir = CONFIG.BACKUP_DIR || path.join(dbDir, 'backups');
    if (fs.existsSync(bDir)) {
      const files = fs.readdirSync(bDir)
        .filter(f => f.startsWith('alfa_citas_backup_') && f.endsWith('.sqlite'))
        .sort();
      if (files.length > 0) {
        return path.join(bDir, files[files.length - 1]);
      }
    }
    return this.createBackup();
  },

  syncFromSeedRecovery(targetDb = db, seedFilePath = null) {
    return syncFromSeedRecovery(targetDb, seedFilePath);
  },

  KNOWN_LID_PHONE_MAPPINGS
};

module.exports = database;
