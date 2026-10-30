import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { ensureDir } from './util.js';

export function writeXhsWeekly(report, topics = [], stats = {}, now = new Date()) {
  ensureDir(paths.weekly);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
  const file = path.join(paths.weekly, `XHSWEEK-${day}.md`);
  const lines = [
    `# 小红书周记 · ${day}`,
    '',
    `统计周期：${stats.period || '近 7 日'}（读于 ${stats.at || now.toISOString()}）`,
    '',
    `曝光 ${stats.views || '-'} ｜ 观看 ${stats.reads || '-'} ｜ 封面点击率 ${stats.coverRate || '-'}`,
    `点赞 ${stats.likes || '-'} ｜ 评论 ${stats.comments || '-'} ｜ 收藏 ${stats.collects || '-'} ｜ 分享 ${stats.shares || '-'}`,
    `新增关注 ${stats.newFollowers || '-'} ｜ 掉粉 ${stats.lostFollowers || '-'} ｜ 净涨粉 ${stats.netFollowers || '-'} ｜ 主页访客 ${stats.visitors || '-'} ｜ 粉丝 ${stats.followers || '-'}`,
    '',
    '## 她的小结',
    '',
    String(report || '').trim(),
    '',
  ];
  if (topics.length) {
    lines.push('## 下周想拍的选题', '');
    for (const topic of topics) {
      lines.push(`- ${topic.title}`);
      if (topic.why) lines.push(`  - 为什么：${topic.why}`);
      if (topic.need) lines.push(`  - 要准备：${topic.need}`);
    }
    lines.push('');
  }
  lines.push('> 数据是从创作中心首页真实读出来的；这份小结由 AI 生成，发布内容请按平台要求标注。');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}
