import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialQueue } from '../src/serial.js';
import { splitForQQ } from '../src/util.js';

test('互斥锁可重入，等待取消后不阻挡下一任务', async () => {
 const queue = new SerialQueue(); const release = await queue.acquire('one'); const c = new AbortController();
 const waiting = queue.run('one', () => 1, { signal: c.signal }); c.abort(); await assert.rejects(waiting); release();
 assert.equal(await queue.run('one', () => queue.run('one', () => 2)), 2); assert.equal(queue.busy, false);
});
test('超长回复每段受上限约束，结尾不丢', () => {
 const text = '字'.repeat(10000) + '最后的结论'; const chunks = splitForQQ(text, 180);
 assert.ok(chunks.every((part) => part.length <= 180)); assert.equal(chunks.join(''), text);
});
