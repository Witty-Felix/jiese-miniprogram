// /api/stats?detail=1 的契约：邀请码门禁 + 每人 dates 明细 + 删除标记扣除 + H5 兼容
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/stats.js';

const KEYS = [
  'checkin:2026-10-15:甲',
  'checkin:2026-10-16:甲',
  'checkin:2026-10-16:乙',
];

const DELETED = { 'deleted:甲': JSON.stringify({ dates: ['2026-10-15'], ts: 1 }) };

function makeEnv() {
  return {
    INVITE_CODE: 'CODE-1',
    STATS: {
      async list({ prefix }) {
        assert.equal(prefix, 'checkin:');
        return { keys: KEYS.map((name) => ({ name })), list_complete: true };
      },
      async get(key) {
        return DELETED[key] ?? null;
      },
    },
  };
}

function request(query = '', headers = {}) {
  return new Request(`https://example.com/api/stats${query}`, { headers });
}

async function body(response) {
  return JSON.parse(await response.text());
}

// 没有邀请码：401，且不泄露任何行
const denied = await onRequestGet({ request: request('?detail=1'), env: makeEnv() });
assert.equal(denied.status, 401);
assert.equal((await body(denied)).ok, false);

// 邀请码正确：返回 dates，且扣除删除标记
const detail = await onRequestGet({
  request: request('?detail=1', { 'X-Invite-Code': 'CODE-1' }),
  env: makeEnv(),
});
assert.equal(detail.status, 200);
const detailData = await body(detail);
const jia = detailData.rows.find((r) => r.nickname === '甲');
const yi = detailData.rows.find((r) => r.nickname === '乙');
assert.deepEqual(jia.dates, ['2026-10-16'], '已删日期不能出现在日历里');
assert.equal(jia.total, 1);
assert.deepEqual(yi.dates, ['2026-10-16']);

// query 形式同样可用（手工排查路径）
const viaQuery = await onRequestGet({ request: request('?detail=1&invite_code=CODE-1'), env: makeEnv() });
assert.equal(viaQuery.status, 200);

// 不带 detail：H5 榜单口径，保持公开且不返回明细
const plain = await onRequestGet({ request: request(), env: makeEnv() });
assert.equal(plain.status, 200);
const plainData = await body(plain);
assert.equal(plainData.rows.length, 2);
assert.equal('dates' in plainData.rows[0], false);

console.log('✓ /api/stats detail 鉴权、日历明细与删除标记扣除通过');
