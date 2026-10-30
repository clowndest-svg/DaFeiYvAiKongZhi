import { AsyncLocalStorage } from 'node:async_hooks';

export class SerialQueue {
  constructor({ maxWaiting = 20, waitMs = 30000 } = {}) {
    this.maxWaiting = maxWaiting;
    this.waitMs = waitMs;
    this.queues = new Map();
    this.context = new AsyncLocalStorage();
  }
  get busy() { return this.queues.size > 0; }
  async acquire(key, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.context.getStore()?.has(key)) return () => {};
    let queue = this.queues.get(key);
    if (!queue) { queue = []; this.queues.set(key, queue); }
    else {
      if (queue.length >= this.maxWaiting) throw Object.assign(new Error('操作排队已满，请稍后再试'), { status: 409 });
      await new Promise((resolve, reject) => {
        const entry = { resolve: () => { cleanup(); resolve(); } };
        const fail = (error) => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); cleanup(); reject(error); };
        const onAbort = () => fail(signal.reason);
        const timer = setTimeout(() => fail(Object.assign(new Error('操作等待超时，请稍后再试'), { status: 409 })), this.waitMs);
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(entry);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) next.resolve(); else this.queues.delete(key);
    };
  }
  async run(key, fn, options = {}) {
    const release = await this.acquire(key, options);
    const held = new Set(this.context.getStore() || []); held.add(key);
    try { return await this.context.run(held, fn); } finally { release(); }
  }
}

export const conversationQueue = new SerialQueue();
