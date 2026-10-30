import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DeepSeek } from '../src/llm.js';
import { getDb, closeDb } from '../src/db.js';

let mode = 'complete', calls = 0;
const server = http.createServer((_req, res) => {
  calls += 1;
  if (mode === 'json') { res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'fake',choices:[{message:{content:'在的'}}],usage:{prompt_tokens:10,completion_tokens:2}}));return; }
  if (mode === 'bad') { res.writeHead(400); res.end('bad request'); return; }
  res.setHeader('Content-Type', 'text/event-stream');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '你好' } }] }) + '\r\n\r\n');
  if (mode === 'complete') res.end('data: [DONE]');
  else if (mode === 'partial') res.end();
  else { res.on('close', () => {}); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const llm = new DeepSeek({ apiKey: 'test', baseUrl: `http://127.0.0.1:${server.address().port}` });
test.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); closeDb(); });

test('普通请求成本只入账一次',async()=>{
 mode='json';const before=getDb().prepare('SELECT COUNT(*) n FROM costs').get().n;
 await llm.chat([{role:'user',content:'测试'}]);
 assert.equal(getDb().prepare('SELECT COUNT(*) n FROM costs').get().n-before,1);
});

test('尾部 DONE 无换行也正常结束，完整中文不丢', async () => {
  mode='complete';
  const events = []; for await (const e of llm.stream([{ role: 'user', content: '测试' }])) events.push(e);
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).content, '你好');
});
test('半截流不能当成功，仍记估算成本', async () => {
  mode = 'partial';
  await assert.rejects(async () => { for await (const e of llm.stream([{ role: 'user', content: '测试' }])) {} }, /正常结束/);
  assert.ok(getDb().prepare("SELECT COUNT(*) n FROM costs WHERE kind LIKE '%partial%estimated%'").get().n > 0);
});
test('400 不重试，主动取消可及时结束等待流', async () => {
  mode = 'bad'; const before = calls;
  await assert.rejects(() => llm.chat([{ role: 'user', content: '测试' }]), /400/); assert.equal(calls - before, 1);
  mode = 'waiting'; const controller = new AbortController();
  await assert.rejects(async () => { for await (const e of llm.stream([{ role: 'user', content: '测试' }], { signal: controller.signal })) controller.abort(); }, /abort/i);
});
