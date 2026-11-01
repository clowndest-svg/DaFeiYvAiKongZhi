import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startTestServer } from './helpers/runtime.js';

const shots = path.resolve('data/browser-verification');
fs.mkdirSync(shots, { recursive: true });

const PRESENCE = {
  gaze: true,
  expression: true,
  breathing: true,
  subtitles: true,
  cameraEnabled: true,
  cameraDailyMax: 5,
  cameraIntervalSeconds: 30,
  micEnabled: true,
  speakReplies: true,
  speakDailyMax: 8,
  quickChips: '哼,好,哇',
  neuroEnabled: true,
  neuroStrength: 0.5,
  forgettingCurve: true,
  sensesEnabled: true,
};

function installedChromium() {
  return ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    .find((file) => fs.existsSync(file));
}

test(
  '真机陪伴视图：假摄像头和假麦克风全程跑通，视线、字幕、递质、大脑、遗忘曲线都要有真读数',
  { timeout: 420000 },
  async (t) => {
    const executable = installedChromium();
    if (!executable) throw new Error('这台机器没有安装 Chrome/Edge，无法做真机验证');
    const cleanups = [];
    const server = await startTestServer({ after: (fn) => cleanups.push(fn) }, {
      settings: {
        companion: { name: '测试鲸鲸' },
        qq: { enabled: false },
        proactive: { enabled: false },
        social: { xhsEnabled: false },
        presence: PRESENCE,
      },
    });
    // 遗忘曲线要有真记忆可画，先塞两条进库。
    for (const content of ['他不喜欢吃香菜', '他周三上午要体检']) {
      const res = await fetch(`${server.base}/api/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: server.base, 'x-bizhi-request': '1' },
        body: JSON.stringify({ layer: 'mid', content, importance: 4 }),
      });
      assert.equal(res.status, 200);
    }

    const context = await chromium.launchPersistentContext(path.join(server.dir, 'browser'), {
      executablePath: executable,
      headless: true,
      viewport: { width: 1440, height: 900 },
      env: { ...process.env, TEMP: server.dir, TMP: server.dir },
      permissions: ['camera', 'microphone'],
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    context.setDefaultTimeout(30000);
    t.after(async () => {
      await context.close();
      for (const cleanup of cleanups) await cleanup();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    const failed = [];
    const speakCalls = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/presence\/speak$/.test(request.url())) speakCalls.push(request.url());
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && !/\/api\/balance/.test(res.url())) failed.push(`${res.status()} ${new URL(res.url()).pathname}`);
    });

    await page.goto(`${server.base}/?view=presence`);
    await page.waitForFunction(() => document.querySelector('#view-presence')?.classList.contains('active'));

    // 立绘与视线跟踪
    assert.equal(await page.getAttribute('#petFigure', 'src'), '/char/normal.png');
    const stage = await page.locator('#petStage').boundingBox();
    assert.ok(stage && stage.width > 200 && stage.height > 200, `立绘舞台要有实际尺寸：${JSON.stringify(stage)}`);
    const lookAt = async (fx, fy) => {
      await page.mouse.move(stage.x + stage.width * fx, stage.y + stage.height * fy);
      return page.evaluate(() => document.querySelector('#petFigure').style.transform || '');
    };
    const topLeft = await lookAt(0.1, 0.15);
    const bottomRight = await lookAt(0.9, 0.9);
    assert.match(topLeft, /translate3d/, '鼠标在舞台里移动要真的改到立绘的变换上');
    assert.doesNotMatch(topLeft, /translate3d\(0px, 0px/, '不能是原地不动的 0');
    const firstX = Number(topLeft.match(/translate3d\((-?[0-9.]+)px/)[1]);
    const secondX = Number(bottomRight.match(/translate3d\((-?[0-9.]+)px/)[1]);
    assert.ok(firstX < 0 && secondX > 0, `往左和往右要真的反向：${firstX} / ${secondX}`);

    // 状态读数：神经递质、大脑、人格锚
    await page.locator('#presenceDiagnostics > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#neuroList .neuro-row').length === 5);
    const widths = await page.evaluate(() => [...document.querySelectorAll('#neuroList .neuro-bar i')].map((node) => node.style.width));
    assert.ok(widths.every((value) => /%$/.test(value)), '五根递质条都要有真实宽度');
    assert.match(await page.textContent('#neuroHint'), /愉悦/);
    await page.waitForFunction(() => /真实连接/.test(document.querySelector('#brainStats')?.innerText || ''));
    const brainText = await page.textContent('#brainStats');
    assert.match(brainText, /说过的话/, '对话节点要显示真实条数');
    assert.match(brainText, /核心档案[\s\S]*\d|无读数/, '读不到就要写无读数');
    assert.match(brainText, /人格锚/, '人格锚要给出可核对的人设文件信息');
    await page.screenshot({ path: path.join(shots, 'presence-desktop.png') });

    // 摄像头：取到真画面，再让她说出来
    await page.click('#camToggleBtn');
    await page.waitForFunction(() => {
      const video = document.querySelector('#camVideo');
      return video && video.videoWidth > 0 && !document.querySelector('#camPip').classList.contains('hidden');
    });
    const devices = await page.evaluate(() => [...document.querySelectorAll('#camDeviceSelect option')].map((o) => o.value));
    assert.ok(devices.length >= 1, '设备下拉要真的列出摄像头');
    const frame = await page.evaluate(() => {
      const video = document.querySelector('#camVideo');
      const canvas = document.querySelector('#camCanvas');
      canvas.getContext('2d').drawImage(video, 0, 0, 16, 16);
      return canvas.toDataURL('image/jpeg', 0.5).length;
    });
    assert.ok(frame > 1200, '这一帧不是黑屏（能画出东西来）');
    await page.click('#camLookBtn');
    await page.waitForFunction(() => /看过了/.test(document.querySelector('#presenceHint')?.textContent || ''), { timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg.assistant').length >= 1);
    assert.ok((await page.textContent('#captionBar')).trim().length > 0, '她说完话字幕要有字');
    const afterLook = await (await fetch(`${server.base}/api/presence/state`)).json();
    assert.equal(afterLook.budget.cameraToday, 1, '看一次要真的记一次额度');
    assert.equal(afterLook.brain.links.look, 1, '「看过」要进真实连接数');
    assert.equal(afterLook.senses.count, 1, '开着的感官记忆要收下这次看到的画面');
    assert.equal(afterLook.senses.items[0].kind, 'sight');
    assert.ok(afterLook.neuro.items.some((item) => item.delta !== 0), '看过新东西之后递质要动一下');

    // 麦克风：完整走「采集 → 16k 重采样 → WAV → 本机识别」
    await page.click('#micBtn');
    await page.waitForFunction(() => /说完了/.test(document.querySelector('#micBtn')?.textContent || ''));
    await page.waitForTimeout(2500);
    await page.click('#micBtn');
    await page.waitForFunction(
      () => /听到了|没听出字|没听清|太短/.test(document.querySelector('#presenceHint')?.textContent || ''),
      { timeout: 90000 },
    );
    const heard = await page.textContent('#presenceHint');
    assert.match(heard, /听到了|没听出字|没听清|太短/, '识别要么给字，要么明说没听清');
    const leftover = fs.existsSync(path.join(server.dir, 'presence-tmp'))
      ? fs.readdirSync(path.join(server.dir, 'presence-tmp'))
      : [];
    assert.deepEqual(leftover, [], '识别完临时文件必须删干净');

    // 她的声音：服务端合成的音频要真能在浏览器里播出来
    await page.click('#quickChips .chip');
    await page.waitForFunction(() => {
      const audio = document.querySelector('#presenceAudio');
      return audio && audio.duration > 0 && !audio.paused;
    }, { timeout: 90000 });
    const audio = await page.evaluate(() => {
      const node = document.querySelector('#presenceAudio');
      return { duration: node.duration, readyState: node.readyState, src: node.currentSrc };
    });
    assert.ok(audio.duration > 0.2, `她念出来的音频要有时长：${JSON.stringify(audio)}`);
    assert.match(audio.src, /\/api\/voice\/audio\?file=/);
    const afterSpeak = await (await fetch(`${server.base}/api/presence/state`)).json();
    assert.ok(afterSpeak.budget.speakToday >= 1, '念过要记在控制台自己的额度上，不能和白日 QQ 语音混在一本账上');

    // 遗忘曲线：点一条真记忆，画布上要真的画出线
    await page.waitForFunction(() => document.querySelectorAll('#forgetList .forget-row').length >= 1);
    await page.click('#forgetList .forget-row');
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#forgetCanvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
      return painted > 2000;
    });

    // 过期之后再来一句：重渲染整屏历史时，她不该把旧话再翻出来念
    await page.waitForTimeout(22000);
    const beforeStale = speakCalls.length;
    await page.click('#quickChips .chip');
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg.assistant').length >= 3, { timeout: 90000 });
    await page.waitForTimeout(6000);
    const replayed = speakCalls.length - beforeStale;
    assert.ok(replayed <= 4, `之前说过的话过期了还被重念：多发了 ${replayed} 次合成`);

    // 刷新页面后不许把历史重念一遍：只有刚说出口的那一句才配发声
    assert.ok(speakCalls.length > 0, '前面几步应该已经念过话了');
    const beforeReload = speakCalls.length;
    await page.goto(`${server.base}/?view=presence`);
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg.assistant').length >= 3);
    await page.waitForTimeout(6000);
    assert.equal(speakCalls.length, beforeReload, `重新打开页面她把历史消息重念了 ${speakCalls.length - beforeReload} 句`);
    console.log('SPEAK_CALLS=' + speakCalls.length);

    // 桌宠小窗：只留立绘和字幕
    await page.goto(`${server.base}/?view=pet`);
    await page.waitForFunction(() => document.body.classList.contains('mode-pet'));
    await page.waitForFunction(() => document.querySelector('#view-presence').classList.contains('active'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.rail')).display), 'none', '小窗不该留导航');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.presence-side')).display), 'none', '小窗不该留读数侧栏');
    assert.ok(await page.evaluate(() => document.querySelector('#petFigure').getBoundingClientRect().height > 200), '立绘要真的占满窗口');
    const petLayout = await page.evaluate(() => ({
      main: document.querySelector('.main').getBoundingClientRect().width,
      app: document.querySelector('.app').getBoundingClientRect().width,
      figure: document.querySelector('#petFigure').getBoundingClientRect().width,
    }));
    assert.ok(petLayout.main >= petLayout.app - 1, '隐藏导航后桌宠主区必须占满应用宽度，不能留在 86px 导航列');
    assert.ok(petLayout.figure > 200, '桌宠立绘宽度也必须可见，只有高度达标不够');
    await page.screenshot({ path: path.join(shots, 'presence-pet.png') });

    // 窄屏不许横向溢出，而且递质条不能被压成 0 宽
    for (const width of [768, 390, 337, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${server.base}/?view=presence`);
      await page.waitForFunction(() => document.querySelector('#view-presence').classList.contains('active'));
      await page.locator('#presenceDiagnostics > summary').click();
      await page.waitForFunction(() => document.querySelectorAll('#neuroList .neuro-row').length === 5);
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        bar: Math.round(document.querySelector('#neuroList .neuro-bar').getBoundingClientRect().width),
        fill: Math.round(document.querySelector('#neuroList .neuro-bar i').getBoundingClientRect().width),
      }));
      assert.equal(layout.overflow, false, `${width}px 窄屏陪伴页出现横向溢出`);
      assert.ok(layout.bar > 60, `${width}px 窄屏下递质条被压成 ${layout.bar}px，等于没画`);
      assert.ok(layout.fill > 0, `${width}px 窄屏下递质条的读数条不见了`);
      await page.screenshot({ path: path.join(shots, `presence-${width}.png`) });
    }

    // 关掉开关的实例必须明确拒绝，而不是静默
    const off = await startTestServer({ after: (fn) => cleanups.push(fn) }, { settings: { presence: { cameraEnabled: false, micEnabled: false } } });
    const refused = await fetch(`${off.base}/api/presence/look`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: off.base, 'x-bizhi-request': '1' },
      body: JSON.stringify({ image: 'data:image/png;base64,aaaa' }),
    });
    assert.equal(refused.status, 403);

    assert.deepEqual(failed, [], `陪伴页里出现了不该有的失败请求：${failed.join(' | ')}`);
    assert.deepEqual(errors, [], `浏览器里有未处理的 JS 错误：${errors.join(' | ')}`);
    console.log(JSON.stringify({
      browser: 'installed Chromium + 假摄像头/假麦克风',
      camera: '1280x720 真帧',
      microphone: heard.slice(0, 20),
      audioSeconds: Math.round(audio.duration * 10) / 10,
      views: ['presence', 'pet', 768, 390, 337],
      screenshots: path.relative(process.cwd(), shots),
    }));
  },
);
