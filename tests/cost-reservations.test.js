import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveCost, uncertainCost, settleCost, recoverCostReservations, costReservationStatus, resolveCostReservation } from '../src/cost-reservations.js';
import { costSummary, closeDb } from '../src/db.js';
import { readCostState } from '../src/budget.js';
import { saveSettings } from '../src/config.js';
test.after(closeDb);

test('预留计入预算；结算与费用入账同事务且重复结算不重复收费', () => {
  saveSettings({ cost: { maxDailyCostCny: 0.05 } });
  const id = reserveCost({ model: 'test', kind: 'test', estimate: 0.06 });
  assert.equal(costReservationStatus().pendingCount, 1);
  assert.equal(readCostState().level, 'stop');
  assert.equal(costSummary(1).todayCostCny, 0);
  settleCost(id, { model: 'test', costCny: 0.01 });
  assert.equal(settleCost(id, { model: 'test', costCny: 0.01 }), false);
  assert.equal(costSummary(1).todayCostCny, 0.01);
  assert.equal(costReservationStatus().pendingCount, 0);
});

test('崩溃恢复和网络结果未知都保留预留，只有明确 HTTP 拒绝才释放', () => {
  const a = reserveCost({ model: 'test', estimate: 0.02 });
  const b = reserveCost({ model: 'test', estimate: 0.03 });
  const c = reserveCost({ model: 'test', estimate: 0.04 });
  uncertainCost(b);
  uncertainCost(c, true);
  closeDb();
  recoverCostReservations();
  const status = costReservationStatus();
  assert.equal(status.pendingCount, 2);
  assert.equal(status.pendingEstimateCny, 0.05);
  assert.ok(status.unknown.some(row => row.id === a));
  assert.throws(() => resolveCostReservation(a, -1), /实际费用/);
  resolveCostReservation(a, 0.015);
  assert.throws(() => resolveCostReservation(a, 0), /已核对/);
  assert.equal(costReservationStatus().pendingCount, 1);
  assert.equal(costSummary(1).todayCostCny, 0.025);
});
