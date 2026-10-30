import { getQzoneCookie, calcGtk } from '../src/channels/qzone.js';

const c = getQzoneCookie();
const gtk = calcGtk(c.pSkey || c.skey);
const p = new URLSearchParams({
  uin: c.uin,
  scope: '1',
  view: '1',
  daylist: '',
  uinlist: c.uin,
  gid: '',
  flag: '1',
  filter: 'all',
  applist: 'all',
  refresh: '1',
  aisortEndTime: '0',
  aisortOffset: '0',
  getAisort: '0',
  aisortBeginTime: '0',
  pagenum: '1',
  firstGetGroup: '0',
  icServerTime: '0',
  mixnocache: '0',
  scene: '0',
  begintime: '',
  dayspac: '30',
  sidomain: 'qzonestyle.gtimg.cn',
  useutf8: '1',
  outputhtmlfeed: '1',
  rd: String(Math.random()),
  usertime: String(Date.now()),
  windowId: String(Math.random()),
  g_tk: String(gtk),
  format: 'json',
  count: '20',
});
const res = await fetch(
  'https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?' + p,
  {
    headers: {
      Cookie: c.cookie,
      Referer: `https://user.qzone.qq.com/${c.uin}/main`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36',
    },
  },
);
let text = await res.text();
text = text
  .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\\//g, '/');
const i = text.indexOf('name="feed_data"');
console.log(text.slice(i, i + 3200));
