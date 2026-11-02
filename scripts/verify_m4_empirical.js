#!/usr/bin/env node
/**
 * scripts/verify_m4_empirical.js
 * Independent empirical verification script for Milestone 4 WhatsApp Dispatch.
 * Author: teamwork_challenger_m4_1
 */

const fs = require('fs');
const path = require('path');
const sqlite = require('node:sqlite');

function runVerification() {
  console.log('===============================================================');
  console.log('🔬 EMPIRICAL VERIFICATION HARNESS — MILESTONE 4 DISPATCH');
  console.log('===============================================================\n');

  let passedAll = true;
  const failureReasons = [];

  // 1. Load Files
  const dbPath = path.join(__dirname, '..', 'data', 'alfa_citas.sqlite');
  const proposedPath = path.join(__dirname, '..', '.agents', 'teamwork', 'teamwork_explorer_survey_3', 'proposed_messages.json');
  const resultsPath = path.join(__dirname, '..', '.agents', 'teamwork', 'worker_m4', 'dispatch_results.json');

  if (!fs.existsSync(dbPath)) throw new Error(`DB not found: ${dbPath}`);
  if (!fs.existsSync(proposedPath)) throw new Error(`Proposed messages not found: ${proposedPath}`);
  if (!fs.existsSync(resultsPath)) throw new Error(`Dispatch results not found: ${resultsPath}`);

  const db = new sqlite.DatabaseSync(dbPath);
  const proposedData = JSON.parse(fs.readFileSync(proposedPath, 'utf8'));
  const dispatchResults = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

  // --------------------------------------------------------------------------
  // Check 1: 1-to-1 Correspondence of audit_logs with proposed_messages.json
  // --------------------------------------------------------------------------
  console.log('--- CHECK 1: audit_logs 1-to-1 Correspondence with proposed_messages.json ---');
  const auditLogs = db.prepare(`SELECT * FROM audit_logs WHERE action = 'NOTIFICATION_SENT' ORDER BY id ASC`).all();
  console.log(`Observed NOTIFICATION_SENT entries in audit_logs: ${auditLogs.length}`);

  const approvedAdjustments = proposedData.schedule_adjustments || [];
  const approvedReminders = proposedData.registration_reminders || [];
  const totalApproved = approvedAdjustments.length + approvedReminders.length;
  console.log(`Approved messages in proposed_messages.json: ${totalApproved} (Adjustments: ${approvedAdjustments.length}, Reminders: ${approvedReminders.length})`);

  if (auditLogs.length !== totalApproved) {
    passedAll = false;
    failureReasons.push(`Audit logs count (${auditLogs.length}) does not match approved messages count (${totalApproved})`);
  }

  // Parse audit log details
  const parsedAudit = auditLogs.map(log => {
    let details = {};
    try {
      details = JSON.parse(log.details);
    } catch (e) {
      details = { raw: log.details };
    }
    return {
      id: log.id,
      appointment_id: log.appointment_id,
      created_at: log.created_at,
      details
    };
  });

  // Verify Schedule Adjustment (Message 1)
  const adjExpected = approvedAdjustments[0];
  const adjAudit = parsedAudit[0];

  console.log(`\nVerifying Message 1 (Schedule Adjustment):`);
  console.log(`  Expected Recipient: ${adjExpected.destination_phone}`);
  console.log(`  Audit Recipient:    ${adjAudit?.details?.recipient}`);
  console.log(`  Expected Candidate: ${adjExpected.candidate_name}`);
  console.log(`  Audit Candidate:    ${adjAudit?.details?.candidate_name}`);
  console.log(`  Audit Apt ID:       ${adjAudit?.appointment_id}`);

  if (!adjAudit || adjAudit.details.recipient !== adjExpected.destination_phone) {
    passedAll = false;
    failureReasons.push(`Message 1 recipient mismatch: expected ${adjExpected.destination_phone}, got ${adjAudit?.details?.recipient}`);
  }
  if (adjAudit?.appointment_id !== 122) {
    passedAll = false;
    failureReasons.push(`Message 1 appointment_id mismatch: expected 122, got ${adjAudit?.appointment_id}`);
  }
  if (adjAudit?.details?.candidate_name !== adjExpected.candidate_name) {
    passedAll = false;
    failureReasons.push(`Message 1 candidate mismatch: expected ${adjExpected.candidate_name}, got ${adjAudit?.details?.candidate_name}`);
  }

  // Verify Registration Reminders (Messages 2 to 20)
  console.log(`\nVerifying Messages 2 to 20 (Registration Reminders):`);
  for (let i = 0; i < approvedReminders.length; i++) {
    const rem = approvedReminders[i];
    const logIdx = i + 1; // index in parsedAudit
    const auditEntry = parsedAudit[logIdx];
    const expectedDest = rem.destination || rem.jid;
    const actualDest = auditEntry?.details?.recipient;

    if (!auditEntry) {
      passedAll = false;
      failureReasons.push(`Missing audit entry for reminder #${rem.id}`);
      continue;
    }

    const matches = actualDest === expectedDest;
    if (!matches) {
      passedAll = false;
      failureReasons.push(`Reminder #${rem.id} destination mismatch: expected ${expectedDest}, got ${actualDest}`);
    }
    console.log(`  [${logIdx + 1}/20] Reminder ID ${rem.id}: Expected=${expectedDest} | Audit=${actualDest} | Status=${auditEntry.details.status} | OK=${matches}`);
  }

  // --------------------------------------------------------------------------
  // Check 2: Mathematical Invariants of Anti-Ban Timing in dispatch_results.json
  // --------------------------------------------------------------------------
  console.log('\n--- CHECK 2: Mathematical Invariants in dispatch_results.json ---');
  const telemetry = dispatchResults.telemetry || [];
  console.log(`Telemetry entries: ${telemetry.length}`);

  if (telemetry.length !== 20) {
    passedAll = false;
    failureReasons.push(`Telemetry count (${telemetry.length}) != 20`);
  }

  // Invariant 2.1: Typing simulation >= 1500ms and <= 4000ms
  console.log('\nChecking Typing Simulation Invariant (1500ms <= typing_ms <= 4000ms):');
  let typingViolations = 0;
  telemetry.forEach((t, idx) => {
    const ok = t.typing_ms >= 1500 && t.typing_ms <= 4000;
    if (!ok) {
      typingViolations++;
      passedAll = false;
      failureReasons.push(`Message ${idx + 1} typing_ms ${t.typing_ms} violates [1500, 4000]ms`);
    }
  });
  console.log(`  Typing Violations: ${typingViolations} / ${telemetry.length}`);

  // Invariant 2.2: Inter-send gaps >= 1400ms
  console.log('\nChecking Inter-Send Gap Invariant:');
  console.log('  Note: Message 1 is the initial message (gap = 0). Messages 2..20 have gaps between consecutive sends.');
  let gapViolations = 0;
  for (let i = 1; i < telemetry.length; i++) {
    const t = telemetry[i];
    const ok = t.gap_ms >= 1400;
    if (!ok) {
      gapViolations++;
      passedAll = false;
      failureReasons.push(`Message ${t.index} gap_ms ${t.gap_ms} < 1400ms`);
    }
    console.log(`  Message ${t.index}: gap_ms = ${t.gap_ms} (>= 1400ms: ${ok})`);
  }
  console.log(`  Gap Violations: ${gapViolations} / ${telemetry.length - 1}`);

  // Invariant 2.3: Strictly monotonically increasing timestamps
  console.log('\nChecking Strictly Monotonic Timestamps Invariant:');
  let monotonicityViolations = 0;
  for (let i = 0; i < telemetry.length; i++) {
    const currentTs = new Date(telemetry[i].timestamp).getTime();
    if (isNaN(currentTs)) {
      monotonicityViolations++;
      passedAll = false;
      failureReasons.push(`Message ${i + 1} timestamp invalid: ${telemetry[i].timestamp}`);
      continue;
    }
    if (i > 0) {
      const prevTs = new Date(telemetry[i - 1].timestamp).getTime();
      const deltaMs = currentTs - prevTs;
      const isMonotonic = deltaMs > 0;
      if (!isMonotonic) {
        monotonicityViolations++;
        passedAll = false;
        failureReasons.push(`Message ${i + 1} timestamp not strictly greater than message ${i} (delta = ${deltaMs}ms)`);
      }
      console.log(`  Msg ${i} -> Msg ${i + 1}: Delta = ${deltaMs}ms (Monotonic: ${isMonotonic})`);
    } else {
      console.log(`  Msg 1: Started at ${telemetry[0].timestamp}`);
    }
  }
  console.log(`  Monotonicity Violations: ${monotonicityViolations}`);

  // --------------------------------------------------------------------------
  // Check 3: Juan Alberto Chavarría aguirre (#122) notified_at in DB
  // --------------------------------------------------------------------------
  console.log('\n--- CHECK 3: Candidate #122 notified_at in Database ---');
  const apt122 = db.prepare('SELECT id, candidate_name, time_slot, status, notified_at, updated_at FROM appointments WHERE id = 122').get();
  console.log('  Appointment #122 Row:', apt122);

  const juanAuditLog = auditLogs.find(l => l.appointment_id === 122);
  console.log('  Audit Log Row for #122: id =', juanAuditLog?.id, ', created_at =', juanAuditLog?.created_at);

  let notifiedOk = false;
  if (!apt122) {
    passedAll = false;
    failureReasons.push('Appointment #122 not found in appointments table');
  } else if (!apt122.notified_at) {
    passedAll = false;
    failureReasons.push('Appointment #122 has null or empty notified_at');
  } else {
    // Compare timestamps
    const aptTime = new Date(apt122.notified_at).getTime();
    const auditTime = new Date(juanAuditLog.created_at).getTime();
    const diffMs = Math.abs(aptTime - auditTime);
    console.log(`  Timestamp difference between appointment.notified_at and audit_logs.created_at: ${diffMs} ms`);
    // Both operations happen within the same millisecond or fraction of second
    if (diffMs <= 1000) {
      notifiedOk = true;
      console.log(`  ✅ Candidate #122 notified_at matches audit log within ${diffMs}ms tolerance.`);
    } else {
      passedAll = false;
      failureReasons.push(`Candidate #122 notified_at (${apt122.notified_at}) differs from audit log (${juanAuditLog.created_at}) by ${diffMs}ms`);
    }
  }

  // --------------------------------------------------------------------------
  // Summary & Empirical Verdict
  // --------------------------------------------------------------------------
  console.log('\n===============================================================');
  console.log('📊 FINAL EMPIRICAL SUMMARY & VERDICT');
  console.log('===============================================================');
  console.log(`Check 1 (audit_logs 1-to-1 match): ${auditLogs.length === 20 && approvedReminders.length === 19 ? 'PASS' : 'FAIL'}`);
  console.log(`Check 2.1 (Typing 1500-4000ms):    ${typingViolations === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`Check 2.2 (Gap >= 1400ms):         ${gapViolations === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`Check 2.3 (Strictly Monotonic):    ${monotonicityViolations === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`Check 3 (Juan Alberto #122):       ${notifiedOk ? 'PASS' : 'FAIL'}`);
  console.log('---------------------------------------------------------------');
  if (passedAll) {
    console.log('VERDICT: APPROVE');
  } else {
    console.log('VERDICT: CHALLENGE');
    console.log('Reasons:');
    failureReasons.forEach(r => console.log(`  - ${r}`));
  }
  console.log('===============================================================\n');

  return { passedAll, failureReasons };
}

if (require.main === module) {
  try {
    const res = runVerification();
    process.exit(res.passedAll ? 0 : 1);
  } catch (e) {
    console.error('Fatal in verification runner:', e);
    process.exit(1);
  }
}

module.exports = { runVerification };
