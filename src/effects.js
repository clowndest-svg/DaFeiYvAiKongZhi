import { getDb, kvGetJson, kvSetJson } from './db.js';
import { nowIso } from './util.js';

export class DeliveryUnknownError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'DeliveryUnknownError';
    this.code = 'DELIVERY_UNKNOWN';
    this.status = 409;
  }
}

export function beginEffect(key) {
  const value = JSON.stringify({ status: 'sending', at: nowIso() });
  const changed = getDb().prepare(`INSERT INTO kv(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE json_extract(kv.value,'$.status')='failed'`).run(key, value).changes;
  const state = kvGetJson(key, {});
  if (changed) return { started: true };
  if (state.status === 'sent') return { started: false, receipt: state.receipt || {} };
  throw new DeliveryUnknownError('上一次发送仍在处理或结果未知，请先在平台核实，不要重复发送');
}

export function finishEffect(key, receipt) {
  kvSetJson(key, { status: 'sent', receipt, at: nowIso() });
}

export function failEffect(key, error) {
  kvSetJson(key, { status: error?.code === 'DELIVERY_UNKNOWN' ? 'unknown' : 'failed', error: String(error?.message || error).slice(0, 200), at: nowIso() });
}
