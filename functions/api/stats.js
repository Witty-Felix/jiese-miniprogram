// GET /api/stats → 全员打卡统计（ADR-0004）
//   ?detail=1 额外返回每个成员的 dates 数组（日历页用），必须带邀请码校验
// KV 键：checkin:<yyyy-mm-dd>:<昵称>；日期按 Asia/Shanghai
// 返回：{ ok, today, rows: [{ nickname, total, streak, last_date, checked_today, dates? }] }
// no-store：KV list 本就有最终一致延迟，不能再叠加浏览器/中间层缓存，否则「刷新无效果」
// 删除标记（ADR-0007）：list 延迟会让已删键短暂残留，用 get 读 deleted:<昵称> 把已删日期减掉
//
// 鉴权边界：汇总行（total/streak）沿用公开口径，H5 榜单与既有客户端不受影响；
// 细到「哪一天打过卡」的 dates 属于成员级明细，只发给持有邀请码的调用方。

import { shanghaiDate } from './_ima.js';
import { computeRowExcluding, readDeletedDates, parseCheckinKey } from './_stats.js';
import { timingSafeEqualStr } from './admin/_auth.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// 邀请码读取：优先请求头（不进 URL 日志），兼容 query 便于手工排查
function readInviteCode(request, url) {
  return String(request.headers.get('X-Invite-Code') || url.searchParams.get('invite_code') || '');
}

export async function onRequestGet({ request, env }) {
  if (!env.STATS) return json({ ok: false, error: '服务端未配置 STATS' }, 500);

  const url = new URL(request.url);
  const detail = url.searchParams.get('detail') === '1';
  if (detail) {
    if (!env.INVITE_CODE) return json({ ok: false, error: '服务端未配置邀请码' }, 500);
    if (!timingSafeEqualStr(readInviteCode(request, url), env.INVITE_CODE)) {
      return json({ ok: false, error: '邀请码不正确' }, 401);
    }
  }

  const byUser = new Map();
  let cursor;
  do {
    const page = await env.STATS.list({ prefix: 'checkin:', cursor });
    for (const k of page.keys) {
      const parsed = parseCheckinKey(k.name);
      if (!parsed) continue;
      if (!byUser.has(parsed.nickname)) byUser.set(parsed.nickname, new Set());
      byUser.get(parsed.nickname).add(parsed.date);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const today = shanghaiDate();
  const entries = [...byUser.entries()];
  // 每个用户一次 get（仅对名单内用户），据此剔除 list 尚未收敛的已删日期
  const marked = await Promise.all(entries.map(([nickname]) => readDeletedDates(env, nickname)));
  const rows = entries
    .map(([nickname, dates], i) => {
      // computeRowExcluding 会就地扣掉已删日期，之后取出的日期集合即为对外口径
      const row = computeRowExcluding(nickname, dates, marked[i], today);
      if (!row) return null;
      return detail ? { ...row, dates: [...dates].sort() } : row;
    })
    .filter(Boolean)
    .sort((a, b) => b.total - a.total || b.streak - a.streak || a.nickname.localeCompare(b.nickname, 'zh'));

  return json({ ok: true, today, rows });
}
