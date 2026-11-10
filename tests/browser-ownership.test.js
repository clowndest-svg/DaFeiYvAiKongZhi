// 专用浏览器归属核实的判据。这个函数是"能不能接管这个 Chrome"的唯一闸门，
// 判错方向就是把主人日常浏览器当成自动化窗口来操作，所以正反样本都要钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ownsProfileDir, parseUserDataDir, sameLocation, liveScore } from '../src/browser/cdp.js';

const PROFILE = path.resolve('D:/RuanJian/BiZhi/data/xhs-profile');

test('读得出 --user-data-dir，带引号、相对路径、大小写差异都算同一个目录', () => {
  assert.equal(parseUserDataDir(`chrome.exe --user-data-dir=${PROFILE}`), PROFILE);
  assert.equal(parseUserDataDir(`chrome.exe "--user-data-dir=${PROFILE}"`), PROFILE);
  assert.equal(parseUserDataDir('chrome.exe --user-data-dir=data/xhs-profile').toLowerCase().includes('xhs-profile'), true);
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=${PROFILE.toUpperCase()}`, PROFILE), true, 'Windows 路径大小写不同应当算同一个目录');
});

test('不是本项目专用目录就拒绝接管', () => {
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=C:/Users/me/AppData/Local/Google/Chrome/User Data`, PROFILE), false, '主人日常浏览器被当成自己的窗口');
  assert.equal(ownsProfileDir('chrome.exe --remote-debugging-port=9333', PROFILE), false, '没带数据目录参数不该算通过');
  assert.equal(ownsProfileDir('', PROFILE), false);
  assert.equal(ownsProfileDir(undefined, PROFILE), false);
});

test('前缀像但不是同一个目录的必须拒绝（data/xhs-profile-evil 不是 data/xhs-profile）', () => {
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=${PROFILE}-evil`, PROFILE), false);
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=${PROFILE}/sub`, PROFILE), false);
});

test('参数顺序与相邻参数不影响判定', () => {
  const line = `chrome.exe --enable-automation --user-data-dir=${PROFILE} --no-first-run --window-size=1280,900`;
  assert.equal(ownsProfileDir(line, PROFILE), true);
  assert.equal(ownsProfileDir(`chrome.exe --user-data-dir=${path.resolve(PROFILE, '..')}`, PROFILE), false);
});

// 导航"提交"慢不等于失败：X 在这张网上提交常拖过 30 秒，实测把已经跳过去的页报成"操作超时"。
test('导航超时后要看地址，不许拿 CDP 有没有回话当成功', () => {
  assert.equal(sameLocation('https://x.com/home', 'https://x.com/home'), true);
  assert.equal(sameLocation('https://x.com/home/', 'https://x.com/home'), true, '浏览器补的斜杠不该算没到');
  assert.equal(sameLocation('https://X.com/example_owner#top', 'https://x.com/example_owner'), true, '大小写和 hash 不该算没到');
  assert.equal(sameLocation('https://x.com/home?show=following', 'https://x.com/home'), false, '查询串不同就是另一个页');
  assert.equal(sameLocation('https://x.com/i/flow/login', 'https://x.com/home'), false, '还停在登录页不能算成功');
  assert.equal(sameLocation('', 'https://x.com/home'), false, '读不到地址等于没到，不许当成跳转成功');
  assert.equal(sameLocation('about:blank', 'https://x.com/home'), false);
});

test('标签页被丢弃时导航要重连再跳一次，只跳一次', () => {
  const cdp = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'src', 'browser', 'cdp.js'), 'utf8');
  const nav = /async navigate\(url[\s\S]*?\r?\n  }/.exec(cdp);
  assert.ok(nav, '找不到 navigate()');
  assert.ok(nav[0].includes('sameLocation(where, url)'), '没核对地址就把"提交慢"当成失败（或反过来把没跳过去当成成功）');
  const retries = (nav[0].match(/await this\.send\('Page\.navigate'/g) || []).length;
  assert.equal(retries, 2, `导航应当最多跳两次，实际出现 ${retries} 次：一次都不重试会被丢弃的页卡死，多次会放大故障`);
  assert.ok(nav[0].includes('await this.attach()'), '重连之前没重新挑一个答话的标签页');
  assert.ok(nav[0].includes("timeoutMs: 4000"), '读地址也要有短超时：卡死的页会让每次导航多等 20 秒');
});

test('浏览器弹原生对话框要自动应答，不然标签页被冻住、导航永远不提交', () => {
  const cdp = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'src', 'browser', 'cdp.js'), 'utf8');
  assert.ok(cdp.includes('Page.javascriptDialogOpening'), '没监听对话框事件：X 的 beforeunload 弹窗会把这一页卡死');
  assert.ok(cdp.includes('Page.handleJavaScriptDialog'), '没应答对话框');
  assert.ok(/accept:\s*true/.test(cdp), '应答时没选"离开"');
  assert.ok(cdp.includes("logger.info('浏览器弹了原生对话框"), '自动跳过要说一声，不然页面行为变了没人知道原因');
  // 事件必须在"没有 id 就直接 return"之前处理，否则对话框永远收不到
  const handler = cdp.indexOf('Page.javascriptDialogOpening');
  const bail = cdp.indexOf("if (!message.id) return;");
  assert.ok(handler > 0 && bail > handler, '对话框处理排在了事件丢弃之后：等于没写');
});

test('接管时逐个标签页试，谁答话用谁，别一把抓第一个', () => {
  const cdp = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'src', 'browser', 'cdp.js'), 'utf8');
  const attach = /async attach\(\)[\s\S]*?\r?\n  }/.exec(cdp);
  assert.ok(attach, '找不到 attach()');
  assert.match(attach[0], /for \(const page of candidates\)/, '没有逐个候选试连：一次抓错页就全线超时');
  assert.match(attach[0], /await this\.tryConnect\(page\)/, '候选页没走答话检查');
  assert.match(attach[0], /\/json\/new/, '所有页都不答话时没给自己开一个新标签页');
  const connect = /async tryConnect\(page\)[\s\S]*?\r?\n  }/.exec(cdp);
  assert.ok(connect, '找不到 tryConnect()');
  assert.match(connect[0], /this\.send\('Page\.enable', \{\}, 6000\)/, '没先用一句话说"你在不在"：被丢弃的后台页会把指令吞掉');
  assert.match(connect[0], /return false/, '这个页不答话时要能换下一个');
  // 真机量到的 8 个 target：3 个 about:blank + 一个卡住的旧页，活的只有开着站点的那个
  const targets = [
    { url: 'about:blank' },
    { url: 'https://x.com/example_owner' },
    { url: 'about:blank' },
    { url: 'chrome://omnibox-popup.top-chrome/' },
    { url: 'about:blank' },
  ];
  const ranked = [...targets].sort((a, b) => liveScore(b) - liveScore(a));
  assert.equal(ranked[0].url, 'https://x.com/example_owner', '没把开着站点的页排在最前');
  assert.ok(liveScore({ url: 'about:blank' }) < liveScore({ url: 'chrome://omnibox-popup.top-chrome/' }), '空白页该排在别的非站点页后面');
});
