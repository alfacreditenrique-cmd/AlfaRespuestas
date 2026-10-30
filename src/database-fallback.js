const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

/**
 * Adaptador de Base de Datos Compatible (In-Memory / JSON) para entornos Serverless
 * (como Vercel con Node < 22.5 donde node:sqlite / DatabaseSync no está disponible nativamente).
 * Emula la interfaz completa de DatabaseSync de Node.js (exec, prepare -> { run, get, all }).
 */
class FallbackDatabaseSync {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.appointments = [];
    this.chat_states = [];
    this.audit_logs = [];
    this.interview_dates = [];
    this.phone_mappings = [];
    this.lastAppointmentId = 0;
    this.lastAuditLogId = 0;

    this.initDefaultData();
  }

  initDefaultData() {
    // 1. Cargar interview_dates por defecto
    const now = new Date().toISOString();
    for (const d of CONFIG.DATES) {
      this.interview_dates.push({
        id: d.id,
        label: d.label,
        short: d.short || '',
        is_active: 1,
        created_at: now
      });
    }

    // 2. Cargar phone_mappings conocidos
    const knownMappings = {
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
      '251982140993783': '50585136655',
      '13744147030196': '50587099189',
      '57256796233770': '50586233770',
      '153725536583712': '50587411241',
      '278490125480035': '50588990011',
      '87424344531017': '50589436869',
      '267417582313521': '50582667129',
      '262237986025598': '50558328676',
      '155473739288712': '50578358674',
      '142679233003740': '50587443032',
      '80079849816117': '50589246391',
      '123656420245589': '50588272121',
      '92457844879515': '50582066598',
      '212803298263138': '50586069625',
      '237602456256678': '50557196182',
      '272632142377156': '50588776655'
    };
    for (const [lid, phone] of Object.entries(knownMappings)) {
      this.phone_mappings.push({ lid, phone_number: phone, source: 'seed', updated_at: now });
    }

    // 3. Sembrar automáticamente desde seed-recovery.json si existe
    const seedCandidates = [
      path.join(__dirname, 'seed-recovery.json'),
      path.join(process.cwd(), 'src', 'seed-recovery.json'),
      path.join(process.cwd(), 'seed-recovery.json')
    ];
    for (const seedPath of seedCandidates) {
      if (fs.existsSync(seedPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
          if (Array.isArray(raw.appointments)) {
            for (const a of raw.appointments) {
              const id = ++this.lastAppointmentId;
              this.appointments.push({
                id,
                candidate_name: a.candidate_name,
                phone_number: a.phone_number,
                jid: a.jid || null,
                position: a.position,
                date: a.date,
                time_slot: a.time_slot,
                status: a.status || 'confirmada',
                notes: a.notes || '',
                notified_at: a.notified_at || now,
                created_at: a.created_at || now,
                updated_at: a.updated_at || now
              });
            }
          }
          if (Array.isArray(raw.chat_states)) {
            for (const s of raw.chat_states) {
              this.chat_states.push({
                phone_number: s.phone_number,
                step: s.step || 'IDLE',
                selected_position: s.selected_position || null,
                selected_date: s.selected_date || null,
                selected_time: s.selected_time || null,
                candidate_name: s.candidate_name || null,
                jid: s.jid || null,
                updated_at: now
              });
            }
          }
          break;
        } catch (e) {
          console.warn('⚠️ Error sembrando FallbackDatabaseSync:', e.message);
        }
      }
    }
  }

  exec(sql) {
    if (!sql || typeof sql !== 'string') return;
    const clean = sql.trim();

    // Comprobaciones de borrado para pruebas unitarias
    if (clean.includes('DELETE FROM appointments')) {
      this.appointments = [];
      this.lastAppointmentId = 0;
    }
    if (clean.includes('DELETE FROM chat_states')) {
      this.chat_states = [];
    }
    if (clean.includes('DELETE FROM audit_logs')) {
      this.audit_logs = [];
      this.lastAuditLogId = 0;
    }
    if (clean.includes('DELETE FROM phone_mappings')) {
      this.phone_mappings = [];
    }
    if (clean.includes('DELETE FROM interview_dates WHERE id NOT IN')) {
      const match = clean.match(/id NOT IN \(([^)]+)\)/i);
      if (match) {
        const allowed = match[1].split(',').map(s => s.replace(/['"\s]/g, ''));
        this.interview_dates = this.interview_dates.filter(d => allowed.includes(d.id));
      }
    } else if (clean.includes('DELETE FROM interview_dates')) {
      this.interview_dates = [];
    }

    if (clean.includes("UPDATE interview_dates SET label = 'Miércoles 4 de Noviembre'")) {
      const d = this.interview_dates.find(x => x.id === '2025-11-04');
      if (d) d.label = 'Miércoles 4 de Noviembre';
    }
    if (clean.includes("UPDATE interview_dates SET label = 'Jueves 5 de Noviembre'")) {
      const d = this.interview_dates.find(x => x.id === '2025-11-05');
      if (d) d.label = 'Jueves 5 de Noviembre';
    }
  }

  close() {
    // no-op para base en memoria
  }

  prepare(sql) {
    const s = sql.trim().replace(/\s+/g, ' ');
    const self = this;

    // --- INTERVIEW DATES ---
    if (s.startsWith('SELECT COUNT(*) as count FROM interview_dates')) {
      return {
        get: () => ({ count: self.interview_dates.length })
      };
    }
    if (s.startsWith('SELECT * FROM interview_dates WHERE is_active = 1 ORDER BY id ASC')) {
      return {
        all: () => self.interview_dates.filter(d => d.is_active === 1).map(d => ({ ...d }))
      };
    }
    if (s.startsWith('SELECT * FROM interview_dates ORDER BY id ASC')) {
      return {
        all: () => [...self.interview_dates].sort((a, b) => a.id.localeCompare(b.id)).map(d => ({ ...d }))
      };
    }
    if (s.startsWith('SELECT * FROM interview_dates WHERE id = ?')) {
      return {
        get: (id) => {
          const found = self.interview_dates.find(d => d.id === String(id).trim());
          return found ? { ...found } : undefined;
        }
      };
    }
    if (s.includes('INSERT OR IGNORE INTO interview_dates')) {
      return {
        run: (id, label, short, created_at) => {
          const exists = self.interview_dates.some(d => d.id === id);
          if (!exists) {
            self.interview_dates.push({ id, label, short: short || '', is_active: 1, created_at });
            return { changes: 1 };
          }
          return { changes: 0 };
        }
      };
    }
    if (s.includes('INSERT INTO interview_dates') && s.includes('ON CONFLICT(id)')) {
      return {
        run: (id, label, short, created_at) => {
          const idx = self.interview_dates.findIndex(d => d.id === id);
          if (idx !== -1) {
            self.interview_dates[idx].label = label;
            self.interview_dates[idx].short = short;
            self.interview_dates[idx].is_active = 1;
            return { changes: 1 };
          }
          self.interview_dates.push({ id, label, short, is_active: 1, created_at });
          return { changes: 1 };
        }
      };
    }
    if (s.startsWith('UPDATE interview_dates SET is_active = ? WHERE id = ?')) {
      return {
        run: (isActive, id) => {
          const found = self.interview_dates.find(d => d.id === id);
          if (found) {
            found.is_active = isActive;
            return { changes: 1 };
          }
          return { changes: 0 };
        }
      };
    }
    if (s.startsWith('UPDATE interview_dates SET label = ?, short = ?, is_active = ? WHERE id = ?')) {
      return {
        run: (label, short, isActive, id) => {
          const found = self.interview_dates.find(d => d.id === id);
          if (found) {
            found.label = label;
            found.short = short;
            found.is_active = isActive;
            return { changes: 1 };
          }
          return { changes: 0 };
        }
      };
    }

    // --- PHONE MAPPINGS ---
    if (s.includes('INSERT OR IGNORE INTO phone_mappings')) {
      return {
        run: (lid, phone, updated_at) => {
          if (!self.phone_mappings.some(m => m.lid === lid)) {
            self.phone_mappings.push({ lid, phone_number: phone, source: 'seed', updated_at });
            return { changes: 1 };
          }
          return { changes: 0 };
        }
      };
    }
    if (s.includes('INSERT INTO phone_mappings') && s.includes('ON CONFLICT(lid)')) {
      return {
        run: (lid, phone, source, updated_at) => {
          const idx = self.phone_mappings.findIndex(m => m.lid === lid);
          if (idx !== -1) {
            self.phone_mappings[idx].phone_number = phone;
            self.phone_mappings[idx].source = source;
            self.phone_mappings[idx].updated_at = updated_at;
          } else {
            self.phone_mappings.push({ lid, phone_number: phone, source, updated_at });
          }
          return { changes: 1 };
        }
      };
    }
    if (s.startsWith('SELECT phone_number FROM phone_mappings WHERE lid = ? OR lid = ? LIMIT 1')) {
      return {
        get: (lid1, lid2) => {
          const m = self.phone_mappings.find(x => x.lid === lid1 || x.lid === lid2);
          return m ? { phone_number: m.phone_number } : undefined;
        }
      };
    }
    if (s.startsWith('SELECT lid FROM phone_mappings WHERE phone_number = ? LIMIT 1')) {
      return {
        get: (phone) => {
          const m = self.phone_mappings.find(x => x.phone_number === phone);
          return m ? { lid: m.lid } : undefined;
        }
      };
    }

    // --- AUDIT LOGS ---
    if (s.startsWith('INSERT INTO audit_logs')) {
      return {
        run: (action, appointment_id, details, created_at) => {
          const id = ++self.lastAuditLogId;
          self.audit_logs.push({ id, action, appointment_id: appointment_id || null, details, created_at });
          return { changes: 1, lastInsertRowid: id };
        }
      };
    }

    // --- CHAT STATES ---
    if (s.startsWith('SELECT * FROM chat_states WHERE phone_number = ?')) {
      return {
        get: (phone) => {
          const found = self.chat_states.find(c => c.phone_number === phone);
          return found ? { ...found } : undefined;
        }
      };
    }
    if (s.startsWith('DELETE FROM chat_states WHERE phone_number = ?')) {
      return {
        run: (phone) => {
          const len = self.chat_states.length;
          self.chat_states = self.chat_states.filter(c => c.phone_number !== phone);
          return { changes: len - self.chat_states.length };
        }
      };
    }
    if (s.includes('INSERT INTO chat_states') || s.includes('INSERT OR IGNORE INTO chat_states')) {
      return {
        run: (phone, step, pos, date, time, name, jid, updated_at) => {
          const idx = self.chat_states.findIndex(c => c.phone_number === phone);
          if (idx !== -1) {
            self.chat_states[idx] = { phone_number: phone, step, selected_position: pos, selected_date: date, selected_time: time, candidate_name: name, jid, updated_at };
          } else {
            self.chat_states.push({ phone_number: phone, step, selected_position: pos, selected_date: date, selected_time: time, candidate_name: name, jid, updated_at });
          }
          return { changes: 1 };
        }
      };
    }
    if (s.startsWith('UPDATE chat_states SET step = COALESCE')) {
      return {
        run: (step, pos, date, time, name, jid, updated_at, phone) => {
          const found = self.chat_states.find(c => c.phone_number === phone);
          if (found) {
            if (step !== null) found.step = step;
            if (pos !== null) found.selected_position = pos;
            if (date !== null) found.selected_date = date;
            if (time !== null) found.selected_time = time;
            if (name !== null) found.candidate_name = name;
            if (jid !== null) found.jid = jid;
            found.updated_at = updated_at;
            return { changes: 1 };
          }
          return { changes: 0 };
        }
      };
    }

    // --- APPOINTMENTS ---
    // 1. Inserción estándar createAppointment
    if (s.includes('INSERT INTO appointments') && s.includes("'confirmada'")) {
      return {
        run: (name, phone, jid, position, date, time_slot, notes, created_at, updated_at) => {
          const id = ++self.lastAppointmentId;
          const apt = {
            id,
            candidate_name: name,
            phone_number: phone,
            jid: jid || null,
            position,
            date,
            time_slot,
            status: 'confirmada',
            notes: notes || '',
            notified_at: null,
            created_at,
            updated_at
          };
          self.appointments.push(apt);
          return { changes: 1, lastInsertRowid: id };
        }
      };
    }

    // 2. Inserción recovery syncFromSeedRecovery
    if (s.includes('INSERT INTO appointments') && !s.includes("'confirmada'")) {
      return {
        run: (name, phone, jid, position, date, time_slot, status, notes, notified_at, created_at, updated_at) => {
          const id = ++self.lastAppointmentId;
          const apt = {
            id,
            candidate_name: name,
            phone_number: phone,
            jid: jid || null,
            position,
            date,
            time_slot,
            status: status || 'confirmada',
            notes: notes || '',
            notified_at: notified_at || null,
            created_at,
            updated_at
          };
          self.appointments.push(apt);
          return { changes: 1, lastInsertRowid: id };
        }
      };
    }

    // 3. Obtener por ID
    if (s.startsWith('SELECT * FROM appointments WHERE id = ?')) {
      return {
        get: (id) => {
          const found = self.appointments.find(a => a.id === Number(id));
          return found ? { ...found } : undefined;
        }
      };
    }

    // 4. Verificación de duplicado en syncFromSeedRecovery
    if (s.includes('SELECT id FROM appointments WHERE (jid IS NOT NULL AND ? IS NOT NULL AND jid = ?) OR phone_number = ? OR (candidate_name = ? AND date = ? AND time_slot = ?)')) {
      return {
        get: (j1, j2, phone, name, date, time_slot) => {
          const found = self.appointments.find(a =>
            (a.jid && j2 && a.jid === j2) ||
            (a.phone_number === phone) ||
            (a.candidate_name === name && a.date === date && a.time_slot === time_slot)
          );
          return found ? { id: found.id } : undefined;
        }
      };
    }
    if (s.includes('SELECT id FROM appointments WHERE (jid IS NOT NULL AND ? IS NOT NULL AND jid = ?) OR phone_number = ?')) {
      return {
        get: (j1, j2, phone) => {
          const found = self.appointments.find(a =>
            (a.jid && j2 && a.jid === j2) || (a.phone_number === phone)
          );
          return found ? { id: found.id } : undefined;
        }
      };
    }

    // 5. Búsqueda por teléfono o JID (getAppointmentByPhone)
    if (s.includes('FROM appointments WHERE (') && s.includes("status IN ('confirmada', 'reprogramada') ORDER BY id DESC LIMIT 1")) {
      return {
        get: (normalized, rawDigits, clean, cleanLike, suffix8, rawDigits2, mappedPhone, mp2, mp3, mappedLid, ml2) => {
          const active = self.appointments
            .filter(a => a.status === 'confirmada' || a.status === 'reprogramada')
            .sort((a, b) => b.id - a.id);

          for (const a of active) {
            const p = a.phone_number || '';
            const j = a.jid || '';

            if (p === normalized || p === rawDigits) return { ...a };
            if (j === clean || (cleanLike && j.includes(clean))) return { ...a };
            if (suffix8 && p.endsWith(suffix8)) return { ...a };
            if (rawDigits && rawDigits.endsWith(p)) return { ...a };
            if (mappedPhone && (p === mappedPhone || p.endsWith(mappedPhone))) return { ...a };
            if (mappedLid && j.includes(mappedLid)) return { ...a };
          }
          return undefined;
        }
      };
    }

    // 6. Listado con filtros (listAppointments)
    if (s.startsWith('SELECT * FROM appointments WHERE 1=1')) {
      return {
        all: (...params) => {
          let list = [...self.appointments];
          let paramIdx = 0;

          if (s.includes('AND (candidate_name LIKE ? OR phone_number LIKE ? OR notes LIKE ?)')) {
            const term = (params[paramIdx] || '').replace(/%/g, '').toLowerCase();
            paramIdx += 3;
            if (term) {
              list = list.filter(a =>
                (a.candidate_name && a.candidate_name.toLowerCase().includes(term)) ||
                (a.phone_number && a.phone_number.toLowerCase().includes(term)) ||
                (a.notes && a.notes.toLowerCase().includes(term))
              );
            }
          }

          if (s.includes('AND date = ?')) {
            const dt = params[paramIdx++];
            if (dt) list = list.filter(a => a.date === dt);
          }

          if (s.includes('AND position = ?')) {
            const pos = params[paramIdx++];
            if (pos) list = list.filter(a => a.position === pos);
          }

          if (s.includes('AND status = ?')) {
            const st = params[paramIdx++];
            if (st) list = list.filter(a => a.status === st);
          }

          list.sort((a, b) => {
            const cmpDate = (a.date || '').localeCompare(b.date || '');
            if (cmpDate !== 0) return cmpDate;
            const cmpTime = (a.time_slot || '').localeCompare(b.time_slot || '');
            if (cmpTime !== 0) return cmpTime;
            return a.id - b.id;
          });

          return list.map(a => ({ ...a }));
        }
      };
    }

    // 7. Actualizar cita
    if (s.startsWith('UPDATE appointments SET candidate_name = ?')) {
      return {
        run: (name, phone, jid, position, date, time_slot, status, notes, notified_at, updated_at, id) => {
          const found = self.appointments.find(a => a.id === Number(id));
          if (found) {
            found.candidate_name = name;
            found.phone_number = phone;
            found.jid = jid || null;
            found.position = position;
            found.date = date;
            found.time_slot = time_slot;
            found.status = status;
            found.notes = notes;
            found.notified_at = notified_at;
            found.updated_at = updated_at;
            return { changes: 1 };
          }
          return { changes: 0 };
        }
      };
    }

    // 8. Cancelar cita
    if (s.startsWith('UPDATE appointments SET status = \'cancelada\', notes = ?, updated_at = ? WHERE id = ?')) {
      return {
        run: (notes, updated_at, id) => {
          const found = self.appointments.find(a => a.id === Number(id));
          if (found) {
            found.status = 'cancelada';
            found.notes = notes;
            found.updated_at = updated_at;
            return { changes: 1 };
          }
          return { changes: 0 };
        }
      };
    }

    // 9. Marcar notificado
    if (s.startsWith('UPDATE appointments SET notified_at = ?, updated_at = ? WHERE id = ?')) {
      return {
        run: (notified_at, updated_at, id) => {
          const found = self.appointments.find(a => a.id === Number(id));
          if (found) {
            found.notified_at = notified_at;
            found.updated_at = updated_at;
            return { changes: 1 };
          }
          return { changes: 0 };
        }
      };
    }

    // 10. isSlotTaken
    if (s.includes('SELECT COUNT(*) as count FROM appointments WHERE date = ? AND time_slot = ?')) {
      return {
        get: (date, time_slot, excludeId) => {
          const matches = self.appointments.filter(a =>
            a.date === date &&
            a.time_slot === time_slot &&
            (a.status === 'confirmada' || a.status === 'reprogramada') &&
            (!excludeId || a.id !== Number(excludeId))
          );
          return { count: matches.length };
        }
      };
    }

    // 11. getTakenSlotsForDate
    if (s.startsWith('SELECT time_slot FROM appointments WHERE date = ? AND status IN (\'confirmada\', \'reprogramada\')')) {
      return {
        all: (date) => {
          return self.appointments
            .filter(a => a.date === date && (a.status === 'confirmada' || a.status === 'reprogramada'))
            .map(a => ({ time_slot: a.time_slot }));
        }
      };
    }

    // 12. getStats totales
    if (s.includes('SELECT COUNT(*) as total, SUM(CASE WHEN status = \'confirmada\'')) {
      return {
        get: () => {
          const res = { total: self.appointments.length, confirmed: 0, rescheduled: 0, cancelled: 0, attended: 0 };
          for (const a of self.appointments) {
            if (a.status === 'confirmada') res.confirmed++;
            else if (a.status === 'reprogramada') res.rescheduled++;
            else if (a.status === 'cancelada') res.cancelled++;
            else if (a.status === 'asistio') res.attended++;
          }
          return res;
        }
      };
    }

    // 13. getStats por plaza
    if (s.includes('SELECT position, COUNT(*) as count FROM appointments WHERE status IN (\'confirmada\', \'reprogramada\') GROUP BY position')) {
      return {
        all: () => {
          const map = {};
          for (const a of self.appointments) {
            if (a.status === 'confirmada' || a.status === 'reprogramada') {
              map[a.position] = (map[a.position] || 0) + 1;
            }
          }
          return Object.entries(map).map(([position, count]) => ({ position, count }));
        }
      };
    }

    // 14. resolvePhoneNumber fallback query
    if (s.includes('SELECT phone_number FROM appointments WHERE (jid = ? OR jid LIKE ? OR phone_number = ?)')) {
      return {
        get: (jid, jidLike, phone) => {
          const found = [...self.appointments]
            .reverse()
            .find(a => {
              const p = a.phone_number || '';
              const j = a.jid || '';
              const matchJid = j === jid || (jidLike && j.includes(jid)) || p === phone;
              const validLen = p.length >= 8 && p.length <= 11;
              const notLid = !p.includes('@lid');
              return matchJid && validLen && notLid;
            });
          return found ? { phone_number: found.phone_number } : undefined;
        }
      };
    }

    // 15. saveToSeedRecovery query
    if (s.includes('SELECT candidate_name, phone_number, jid, position, date, time_slot, status, notes, notified_at, created_at, updated_at FROM appointments ORDER BY id ASC')) {
      return {
        all: () => [...self.appointments].sort((a, b) => a.id - b.id).map(a => ({ ...a }))
      };
    }

    // Fallback genérico para cualquier otra consulta no identificada
    return {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => []
    };
  }
}

module.exports = { FallbackDatabaseSync };
