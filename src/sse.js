export async function* readSse(body) {
  if (!body) throw new Error('上游没有返回响应流');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const line = (text) => {
    if (text === '') { const result = data.join('\n'); data = []; return result || null; }
    if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
    return null;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('上游流式帧过大');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const result = line(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
        if (result !== null) yield result;
      }
      if (done) break;
    }
    if (buffer) { const result = line(buffer.replace(/\r$/, '')); if (result !== null) yield result; }
    const tail = data.join('\n');
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
