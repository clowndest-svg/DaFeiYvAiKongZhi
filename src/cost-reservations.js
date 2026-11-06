import crypto from 'node:crypto';
import { addCost, getDb } from './db.js';
import { shanghaiDayKey } from './util.js';

const ready = new WeakSet();
function dbReady() {
  const db = getDb();
  if (!ready.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS cost_reservations (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
      estimate REAL NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS cost_reservations_day ON cost_reservations(day,state);`);
    ready.add(db);
  }
  return db;
}
export function reserveCost({ model, kind = 'chat', estimate = 0 }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  dbReady().prepare('INSERT INTO cost_reservations VALUES (?,?,?,?,?,?,?,?)')
    .run(id, shanghaiDayKey(), model, kind, Math.max(0, Number(estimate) || 0), 'reserved', now, now);
  return id;
}
export function uncertainCost(id, rejected = false) {
  dbReady().prepare("UPDATE cost_reservations SET state=?,updated_at=? WHERE id=? AND state='reserved'")
    .run(rejected ? 'rejected' : 'unknown', Date.now(), id);
}
export function settleCost(id, cost) {
  const db = dbReady();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT state FROM cost_reservations WHERE id=?').get(id);
    if (!row) throw new Error('费用预留不存在');
    if (row.state === 'settled') { db.exec('COMMIT'); return false; }
    if (row.state === 'rejected') throw new Error('已拒绝的请求不能结算');
    addCost(cost);
    db.prepare("UPDATE cost_reservations SET state='settled',updated_at=? WHERE id=?").run(Date.now(), id);
    db.exec('COMMIT');
    return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function recoverCostReservations() {
  dbReady().prepare("UPDATE cost_reservations SET state='unknown',updated_at=? WHERE state='reserved'").run(Date.now());
}
export function costReservationStatus() {
  const db = dbReady();
  const pending = db.prepare("SELECT coalesce(sum(estimate),0) AS estimate,count(*) AS count FROM cost_reservations WHERE day=? AND state IN ('reserved','unknown')").get(shanghaiDayKey());
  const unknown = db.prepare("SELECT id,day,model,kind,estimate,created_at FROM cost_reservations WHERE state='unknown' ORDER BY created_at LIMIT 100").all();
  return { pendingEstimateCny: pending.estimate, pendingCount: pending.count, unknown };
}
export function resolveCostReservation(id, actualCostCny) {
  if (typeof actualCostCny !== 'number' || !Number.isFinite(actualCostCny) || actualCostCny < 0 || actualCostCny > 1000) throw new Error('请输入核对后的实际费用（0–1000 元）');
  const row = dbReady().prepare("SELECT * FROM cost_reservations WHERE id=? AND state='unknown'").get(String(id));
  if (!row) throw new Error('费用记录不存在或已核对');
  return settleCost(id, { model: row.model, kind: `${row.kind}:manual-reconciliation`, costCny: actualCostCny });
}
