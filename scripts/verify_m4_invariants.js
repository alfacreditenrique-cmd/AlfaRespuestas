const fs = require('fs');
const path = require('path');
const sqlite = require('node:sqlite');

console.log('====================================================');
console.log('🔍 EMPIRICAL VERIFICATION HARNESS: MILESTONE M4');
console.log('====================================================\n');

const dbPath = path.join(__dirname, '..', 'data', 'alfa_citas.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error('❌ Database file does not exist at:', dbPath);
  process.exit(1);
}

const db = new sqlite.DatabaseSync(dbPath);
let failures = 0;
let passed = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${testName} ${details ? `(${details})` : ''}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName} ${details ? `(${details})` : ''}`);
    failures++;
  }
}

// ==========================================
// 1. DATABASE INTEGRITY INVARIANTS
// ==========================================
console.log('--- 1. DATABASE INTEGRITY INVARIANTS ---');

// Total count
const totalAppointments = db.prepare('SELECT COUNT(*) as c FROM appointments').get().c;
assert(totalAppointments === 46, 'Total canonical appointments count is exactly 46', `found: ${totalAppointments}`);

// Status breakdown: exactly 44 confirmada, 2 cancelada
const statusCounts = db.prepare('SELECT status, COUNT(*) as c FROM appointments GROUP BY status').all();
const statusMap = Object.fromEntries(statusCounts.map(r => [r.status, r.c]));
console.log('  Status breakdown:', JSON.stringify(statusMap));

assert(statusMap['confirmada'] === 44, 'Confirmada count is exactly 44', `found: ${statusMap['confirmada']}`);
assert(statusMap['cancelada'] === 2, 'Cancelada count is exactly 2', `found: ${statusMap['cancelada']}`);
assert(!statusMap['reprogramada'] || statusMap['reprogramada'] === 0, 'No dangling reprogramada status', `found: ${statusMap['reprogramada'] || 0}`);

// Juan Alberto Chavarría aguirre record (ID 122)
const juanAlberto = db.prepare("SELECT * FROM appointments WHERE candidate_name LIKE '%Juan Alberto Chavarría%' OR id = 122").get();
assert(Boolean(juanAlberto), 'Juan Alberto Chavarría appointment exists');
if (juanAlberto) {
  assert(juanAlberto.id === 122, 'Juan Alberto ID is 122', `id: ${juanAlberto.id}`);
  assert(juanAlberto.date === '2025-11-04', 'Juan Alberto date is 2025-11-04', juanAlberto.date);
  assert(juanAlberto.time_slot === '17:00', 'Juan Alberto slot is 17:00 (reassigned from 09:00)', juanAlberto.time_slot);
  assert(juanAlberto.status === 'confirmada', 'Juan Alberto status is confirmada', juanAlberto.status);
  assert(juanAlberto.phone_number === '50586233770', 'Juan Alberto phone is 50586233770', juanAlberto.phone_number);
  assert(juanAlberto.notified_at === '2026-11-02T21:46:57.040Z', 'Juan Alberto notified_at updated to dispatch timestamp', juanAlberto.notified_at);
}

// Valid phone numbers across all appointments (no raw @lid)
const invalidPhones = db.prepare("SELECT id, candidate_name, phone_number FROM appointments WHERE phone_number IS NULL OR phone_number LIKE '%@lid' OR LENGTH(phone_number) < 8").all();
assert(invalidPhones.length === 0, 'All appointments have valid resolved phone numbers', `invalid count: ${invalidPhones.length}`);

// Unique partial index check
const indexCheck = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_appointments_unique_active_slot'").get();
assert(Boolean(indexCheck), 'Partial unique index idx_appointments_unique_active_slot exists in sqlite_master');

// ==========================================
// 2. COLLISION CHECK
// ==========================================
console.log('\n--- 2. ACTIVE SLOT COLLISION CHECK ---');

const collisions = db.prepare(`
  SELECT date, time_slot, COUNT(*) as c, GROUP_CONCAT(id) as ids, GROUP_CONCAT(candidate_name) as names
  FROM appointments 
  WHERE status IN ('confirmada', 'reprogramada') 
  GROUP BY date, time_slot 
  HAVING c > 1
`).all();

assert(collisions.length === 0, '0 duplicate active slots across all dates', collisions.length > 0 ? JSON.stringify(collisions) : 'clean');

// Check that 09:00 on 2025-11-04 has exactly 1 appointment (Apt #105, Postulante Confirmado ID 45222197215415)
const slot9am = db.prepare("SELECT id, candidate_name, status FROM appointments WHERE date = '2025-11-04' AND time_slot = '09:00' AND status != 'cancelada'").all();
assert(slot9am.length === 1, '2025-11-04 09:00 has exactly 1 active appointment', `count: ${slot9am.length}, id: ${slot9am[0]?.id}`);

// Check that 17:00 on 2025-11-04 has exactly 1 appointment (Juan Alberto Chavarría, ID 122)
const slot5pm = db.prepare("SELECT id, candidate_name, status FROM appointments WHERE date = '2025-11-04' AND time_slot = '17:00' AND status != 'cancelada'").all();
assert(slot5pm.length === 1, '2025-11-04 17:00 has exactly 1 active appointment', `count: ${slot5pm.length}, id: ${slot5pm[0]?.id}`);

// Verify all active appointments fall within configured valid slots
const CONFIG = require('../src/config');
const allActive = db.prepare("SELECT id, date, time_slot FROM appointments WHERE status IN ('confirmada', 'reprogramada')").all();
const invalidSlots = allActive.filter(a => !CONFIG.TIME_SLOTS.includes(a.time_slot));
assert(invalidSlots.length === 0, 'All active appointments use valid configured 15-min slots', `invalid: ${invalidSlots.length}`);

// ==========================================
// 3. AUDIT_LOGS INTEGRITY
// ==========================================
console.log('\n--- 3. AUDIT_LOGS INTEGRITY ---');

const auditRows = db.prepare("SELECT * FROM audit_logs ORDER BY id ASC").all();
console.log(`  Total audit_logs rows: ${auditRows.length}`);

const notificationSentRows = auditRows.filter(r => r.action === 'NOTIFICATION_SENT');
assert(notificationSentRows.length === 20, 'Exactly 20 NOTIFICATION_SENT records exist', `found: ${notificationSentRows.length}`);

let jsonErrors = 0;
let corruptedFields = 0;
let timingViolations = 0;

notificationSentRows.forEach((row) => {
  let parsed;
  try {
    parsed = JSON.parse(row.details);
  } catch (err) {
    jsonErrors++;
    console.error(`  ❌ Invalid JSON in audit_logs id ${row.id}:`, err.message);
    return;
  }

  // Check required fields
  const required = ['recipient', 'mode', 'status', 'typing_duration_ms', 'send_gap_ms', 'timestamp'];
  for (const f of required) {
    if (parsed[f] === undefined || parsed[f] === null) {
      corruptedFields++;
      console.error(`  ❌ Missing field '${f}' in audit_logs id ${row.id}`);
    }
  }

  // Check action is NOTIFICATION_SENT
  if (row.action !== 'NOTIFICATION_SENT') {
    corruptedFields++;
  }

  // Check status is SENT
  if (parsed.status !== 'SENT') {
    corruptedFields++;
  }

  // Check mode is OFFLINE_ANTI_BAN
  if (parsed.mode !== 'OFFLINE_ANTI_BAN') {
    corruptedFields++;
  }

  // Check typing delay reasonableness (>= 1500ms and <= 4500ms)
  if (parsed.typing_duration_ms < 1500 || parsed.typing_duration_ms > 4500) {
    timingViolations++;
    console.warn(`  ⚠️ Typing delay out of bounds: ${parsed.typing_duration_ms}ms at id ${row.id}`);
  }

  // Check send gap (message 1 has gap 0, messages 2..20 have gap >= 1400ms and <= 2500ms)
  if (parsed.message_index > 1) {
    if (parsed.send_gap_ms < 1400 || parsed.send_gap_ms > 2500) {
      timingViolations++;
      console.warn(`  ⚠️ Send gap out of bounds: ${parsed.send_gap_ms}ms at id ${row.id}`);
    }
  }
});

assert(jsonErrors === 0, 'All audit_logs details have valid JSON syntax', `errors: ${jsonErrors}`);
assert(corruptedFields === 0, 'No corrupted fields in audit_logs (status=SENT, mode=OFFLINE_ANTI_BAN)', `corrupted: ${corruptedFields}`);
assert(timingViolations === 0, 'All anti-ban delays adhere strictly to CONFIG bounds', `violations: ${timingViolations}`);

// Verify message #1 in audit_logs is for Juan Alberto Chavarría (ID 122)
const juanAudit = notificationSentRows.find(r => r.appointment_id === 122);
assert(Boolean(juanAudit), 'Audit log contains record explicitly linked to Juan Alberto Chavarría (apt_id 122)');
if (juanAudit) {
  const juanDetails = JSON.parse(juanAudit.details);
  assert(juanDetails.category === 'SCHEDULE_ADJUSTMENT', 'Juan Alberto audit category is SCHEDULE_ADJUSTMENT', juanDetails.category);
  assert(juanDetails.recipient === '50586233770', 'Juan Alberto audit recipient is 50586233770', juanDetails.recipient);
  assert(juanDetails.candidate_name === 'Juan Alberto Chavarría aguirre', 'Juan Alberto candidate_name matches in audit', juanDetails.candidate_name);
}

// Verify messages #2-#20 correspond to the 19 reminders
const reminderAudits = notificationSentRows.filter(r => r.appointment_id === null);
assert(reminderAudits.length === 19, 'Exactly 19 reminder audit logs exist', `found: ${reminderAudits.length}`);

// ==========================================
// 4. SEED RECOVERY CONSISTENCY
// ==========================================
console.log('\n--- 4. SEED RECOVERY CONSISTENCY ---');

const seedPath = path.join(__dirname, '..', 'src', 'seed-recovery.json');
assert(fs.existsSync(seedPath), 'src/seed-recovery.json exists');

const seedContent = fs.readFileSync(seedPath, 'utf8');
let seedData;
let seedJsonValid = false;
try {
  seedData = JSON.parse(seedContent);
  seedJsonValid = true;
} catch (e) {
  seedJsonValid = false;
}
assert(seedJsonValid, 'src/seed-recovery.json has valid JSON syntax');

if (seedData && Array.isArray(seedData.appointments)) {
  assert(seedData.appointments.length === 46, 'seed-recovery.json has exactly 46 appointments', `found: ${seedData.appointments.length}`);
  
  // Count by status in seed
  const seedConfirmadas = seedData.appointments.filter(a => a.status === 'confirmada').length;
  const seedCanceladas = seedData.appointments.filter(a => a.status === 'cancelada').length;
  assert(seedConfirmadas === 44, 'seed-recovery has exactly 44 confirmada', `found: ${seedConfirmadas}`);
  assert(seedCanceladas === 2, 'seed-recovery has exactly 2 cancelada', `found: ${seedCanceladas}`);

  // Check Juan Alberto in seed
  const juanSeed = seedData.appointments.find(a => a.candidate_name && a.candidate_name.includes('Juan Alberto Chavarría'));
  assert(Boolean(juanSeed), 'Juan Alberto Chavarría exists in seed-recovery.json');
  if (juanSeed) {
    assert(juanSeed.time_slot === '17:00', 'Juan Alberto in seed-recovery has time_slot 17:00', juanSeed.time_slot);
    assert(juanSeed.date === '2025-11-04', 'Juan Alberto in seed-recovery has date 2025-11-04', juanSeed.date);
    assert(juanSeed.status === 'confirmada', 'Juan Alberto in seed-recovery has status confirmada', juanSeed.status);
    assert(juanSeed.phone_number === '50586233770', 'Juan Alberto in seed-recovery has phone 50586233770', juanSeed.phone_number);
    assert(juanSeed.notified_at === '2026-11-02T21:46:57.040Z', 'Juan Alberto in seed-recovery has notified_at updated', juanSeed.notified_at);
  }

  // Exact 1-to-1 parity check between active DB (ORDER BY id ASC) and seed-recovery.json (which is exported ORDER BY id ASC)
  const dbAppointments = db.prepare(`
    SELECT candidate_name, phone_number, jid, position, date, time_slot, status, notes, notified_at, created_at, updated_at
    FROM appointments 
    ORDER BY id ASC
  `).all();

  let parityMismatches = 0;
  for (let i = 0; i < dbAppointments.length; i++) {
    const dbApt = dbAppointments[i];
    const sApt = seedData.appointments[i];
    if (!sApt) {
      parityMismatches++;
      console.error(`  ❌ Index ${i} missing in seed-recovery!`);
      continue;
    }
    const fieldsToCompare = ['candidate_name', 'phone_number', 'jid', 'position', 'date', 'time_slot', 'status', 'notes', 'notified_at'];
    for (const f of fieldsToCompare) {
      if (dbApt[f] !== sApt[f]) {
        parityMismatches++;
        console.error(`  ❌ Mismatch index ${i} (${dbApt.candidate_name}) field '${f}': DB='${dbApt[f]}' vs Seed='${sApt[f]}'`);
      }
    }
  }
  assert(parityMismatches === 0, 'Active database and seed-recovery.json have 100% field-by-field parity across all 46 appointments', `mismatches: ${parityMismatches}`);
}

// ==========================================
// 5. ADVERSARIAL STRESS TEST
// ==========================================
console.log('\n--- 5. ADVERSARIAL STRESS TEST (COLLISION ATTEMPTS) ---');

// Test 5.1: Database-level rejection of active duplicate slot
try {
  const memDb = new sqlite.DatabaseSync(':memory:');
  const schemaRows = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all();
  for (const r of schemaRows) {
    try { memDb.exec(r.sql); } catch {}
  }
  
  // Insert initial active appointment
  const now = new Date().toISOString();
  memDb.prepare(`
    INSERT INTO appointments (candidate_name, phone_number, jid, position, date, time_slot, status, created_at, updated_at)
    VALUES ('Adversarial Test 1', '50511112222', '50511112222@s.whatsapp.net', 'Promotor de Crédito', '2025-11-04', '09:00', 'confirmada', ?, ?)
  `).run(now, now);

  // Try inserting duplicate active slot on same date and time
  let rejected = false;
  try {
    memDb.prepare(`
      INSERT INTO appointments (candidate_name, phone_number, jid, position, date, time_slot, status, created_at, updated_at)
      VALUES ('Adversarial Test 2', '50533334444', '50533334444@s.whatsapp.net', 'Promotor de Crédito', '2025-11-04', '09:00', 'confirmada', ?, ?)
    `).run(now, now);
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.message.includes('constraint')) {
      rejected = true;
    }
  }
  assert(rejected, 'Database constraint idx_appointments_unique_active_slot rejects active duplicate slot insertion');

  // Test 5.2: Reusing cancelled slot must be permitted
  memDb.prepare(`
    INSERT INTO appointments (candidate_name, phone_number, jid, position, date, time_slot, status, created_at, updated_at)
    VALUES ('Cancelled Test', '50555556666', '50555556666@s.whatsapp.net', 'Promotor de Crédito', '2025-11-04', '10:00', 'cancelada', ?, ?)
  `).run(now, now);

  let reuseAllowed = false;
  try {
    memDb.prepare(`
      INSERT INTO appointments (candidate_name, phone_number, jid, position, date, time_slot, status, created_at, updated_at)
      VALUES ('Active Reuser', '50577778888', '50577778888@s.whatsapp.net', 'Promotor de Crédito', '2025-11-04', '10:00', 'confirmada', ?, ?)
    `).run(now, now);
    reuseAllowed = true;
  } catch (err) {
    reuseAllowed = false;
  }
  assert(reuseAllowed, 'Reusing previously cancelled slot (status=cancelada) is permitted by partial index');
} catch (err) {
  assert(false, 'Adversarial stress test execution', err.message);
}

// Test 5.3: Scheduler nearest slot algorithm stress test
const scheduler = require('../src/scheduler');
const nearestSlot = scheduler.getNearestAvailableSlot('2025-11-04', '09:00');
assert(nearestSlot !== null && nearestSlot !== '09:00', 'Scheduler resolves collision away from 09:00 to nearest available slot', nearestSlot);

console.log('\n====================================================');
console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failures} FAILED`);
console.log('====================================================');

if (failures > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
