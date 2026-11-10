import test from 'node:test';
import assert from 'node:assert/strict';

const { saveSettings, loadSettings } = await import('../src/config.js');
const { DeepSeek } = await import('../src/llm.js');
const { closeDb } = await import('../src/db.js');

test.after(closeDb);

function stubFetch(payload = { model: 'x', choices: [{ message: { content: '在吗' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    seen.push({ url: String(url), body: options.body ? JSON.parse(String(options.body)) : null });
    return { ok: true, status: 200, async text() { return JSON.stringify(payload); }, async json() { return payload; } };
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test('接口地址和模型名跟着设置走：控制台改完不用重启就换服务商', async () => {
  const { seen, restore } = stubFetch();
  try {
    saveSettings({ model: { ...loadSettings().model, name: 'other-model', apiBase: 'https://example.com/v1/' } });
    const llm = new DeepSeek();
    await llm.chat([{ role: 'user', content: '在吗' }], { kind: 'chat', model: 'other-model', maxTokens: 64 });
    assert.ok(seen[0].url.startsWith('https://example.com/v1/chat/completions'), `请求地址没跟设置走：${seen[0].url}`);
    assert.equal(seen[0].body.model, 'other-model');
  } finally {
    restore();
    saveSettings({ model: { ...loadSettings().model, name: 'deepseek-flash', apiBase: '' } });
  }
});

test('接口地址填坏了就退回 .env 的地址，不会把整个聊天打瘫', async () => {
  const { seen, restore } = stubFetch();
  try {
    saveSettings({ model: { ...loadSettings().model, apiBase: 'not-a-url' } });
    const llm = new DeepSeek({ baseUrl: 'https://fallback.example/v1' });
    await llm.chat([{ role: 'user', content: '在吗' }], { kind: 'chat', maxTokens: 64 });
    assert.ok(seen[0].url.startsWith('https://fallback.example/v1/chat/completions'), `没退回 .env 地址：${seen[0].url}`);
  } finally {
    restore();
    saveSettings({ model: { ...loadSettings().model, apiBase: '' } });
  }
});
