const assert = require('node:assert/strict');
const { buildCalendar, earliestMonthStart, monthStartOf } = require('../miniprogram/calendar.js');
const { chooseAlbumImage, IMAGE_MAX_BYTES } = require('../miniprogram/upload-policy.js');
const { createCheckinClient } = require('../miniprogram/checkin-client.js');

const storage = () => ({ get: () => undefined, set: () => {}, remove: () => {} });

function makeWx(handler) {
  const calls = { requests: [] };
  return {
    calls,
    request(options) {
      calls.requests.push(options);
      try {
        options.success?.(handler(options));
      } catch (error) {
        options.fail?.(error);
      }
    },
  };
}

async function main() {
  /* ---------- 日历网格 ---------- */
  const cal = buildCalendar({
    dates: ['2026-10-15', '2026-10-17'],
    today: '2026-10-17',
    start: '2026-10-01',
  });
  assert.equal(cal.start, '2026-10-01');
  assert.equal(cal.weeks, 3, '10-01（周四）到 10-17（周六）跨 3 个自然周');
  assert.equal(cal.rows.length, 7);
  for (const line of cal.rows) assert.equal(line.cells.length, 3);
  // 网格从所在周的周一（09-28）起算，但 10-01 之前不算入统计范围
  assert.equal(cal.rows[0].cells[0].date, '2026-09-28');
  assert.equal(cal.rows[0].cells[0].state, 'out');
  assert.equal(cal.rows[3].cells[0].date, '2026-10-01');
  assert.equal(cal.rows[3].cells[0].state, 'off');
  const checked = cal.rows.flatMap((l) => l.cells).filter((c) => c.checked).map((c) => c.date);
  assert.deepEqual(checked, ['2026-10-15', '2026-10-17']);
  assert.equal(cal.rows[3].cells[2].date, '2026-10-15');
  assert.equal(cal.rows[3].cells[2].state, 'on');
  assert.equal(cal.rows[5].cells[2].date, '2026-10-17');
  assert.equal(cal.rows[5].cells[2].state, 'on', '周六那格是深绿（打卡）');
  assert.deepEqual(cal.months.map((m) => m.label), ['10月', '', '']);
  // 周数少时放大格子，但不越过卡片可用宽度
  assert.ok(cal.pitch <= 56 && cal.cell > 0);
  assert.equal(cal.contentWidth, 44 + cal.weeks * cal.pitch);

  // 未传 start 时退回今天所在月的 1 号
  assert.equal(buildCalendar({ dates: [], today: '2026-10-17' }).start, '2026-10-01');
  // 跨年长跨度必须缩小到最小间距，靠横向滚动承载
  const long = buildCalendar({ dates: [], today: '2027-10-17', start: '2026-10-01' });
  assert.ok(long.weeks >= 52);
  assert.equal(long.pitch, 20);
  assert.equal(long.cell, 14);

  assert.equal(monthStartOf('2026-10-17'), '2026-10-01');
  assert.equal(earliestMonthStart([{ dates: ['2026-10-15'] }], '2026-11-02'), '2026-10-01');
  assert.equal(earliestMonthStart([], '2026-11-02'), '2026-11-01');

  /* ---------- 相册/相机选择 ---------- */
  const albumFile = await chooseAlbumImage({
    chooseMedia(options) {
      assert.deepEqual(options.sourceType, ['album', 'camera']);
      assert.deepEqual(options.mediaType, ['image']);
      options.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_run.jpg', size: 2048 }] });
    },
  });
  assert.equal(albumFile.path, 'wxfile://tmp_run.jpg');
  assert.equal(albumFile.name, 'tmp_run.jpg');
  assert.equal(albumFile.size, 2048);
  assert.equal(albumFile.type, 'image/jpeg');

  // 无扩展名的临时路径：相册只会给图片，回退 image/jpeg 而不是拒收
  const noExt = await chooseAlbumImage({
    chooseMedia(options) {
      options.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_blob', size: 10 }] });
    },
  });
  assert.equal(noExt.type, 'image/jpeg');

  await assert.rejects(
    chooseAlbumImage({
      chooseMedia(options) { options.success({ tempFiles: [{ tempFilePath: 'wxfile://a.png', size: IMAGE_MAX_BYTES + 1 }] }); },
    }),
    /超过 30MB/,
  );
  await assert.rejects(
    chooseAlbumImage({
      chooseMedia(options) { options.fail({ errMsg: 'chooseMedia:fail cancel' }); },
    }),
    /已取消选择材料/,
  );
  await assert.rejects(chooseAlbumImage({}), /相册/);

  /* ---------- 统计客户端 ---------- */
  const client = createCheckinClient(makeWx((options) => {
    assert.equal(options.method, 'GET');
    assert.ok(options.url.endsWith('/api/stats?detail=1'));
    assert.equal(options.header['X-Invite-Code'], 'CODE-1');
    return {
      statusCode: 200,
      data: {
        ok: true,
        today: '2026-10-17',
        rows: [{ nickname: '成员甲', total: 2, streak: 2, last_date: '2026-10-17', checked_today: true, dates: ['2026-10-15', '2026-10-17'] }],
      },
    };
  }), { apiBaseUrl: 'https://example.com', storage: storage() });

  const stats = await client.fetchStats('CODE-1');
  assert.deepEqual(stats.rows[0].dates, ['2026-10-15', '2026-10-17']);
  await assert.rejects(client.fetchStats(''), /缺少邀请码/);

  const denied = createCheckinClient(makeWx(() => ({
    statusCode: 401,
    data: { ok: false, error: '邀请码不正确' },
  })), { apiBaseUrl: 'https://example.com', storage: storage() });
  await assert.rejects(denied.fetchStats('BAD'), /邀请码不正确/);

  // 管理密码校验与删除请求体
  const adminCalls = [];
  const admin = createCheckinClient(makeWx((options) => {
    adminCalls.push(options);
    return { statusCode: 200, data: { ok: true } };
  }), { apiBaseUrl: 'https://example.com', storage: storage() });

  await admin.adminVerify('pwd');
  assert.equal(adminCalls[0].method, 'POST');
  assert.deepEqual(adminCalls[0].data, { admin_password: 'pwd' });

  await admin.deleteCheckin({ adminPassword: 'pwd', operator: '成员甲', nickname: '成员乙', date: '2026-10-16' });
  assert.equal(adminCalls[1].method, 'DELETE');
  assert.deepEqual(adminCalls[1].data, {
    admin_password: 'pwd', operator: '成员甲', nickname: '成员乙', date: '2026-10-16',
  });

  await admin.deleteCheckin({ adminPassword: 'pwd', operator: '成员甲', nickname: '成员乙', all: true });
  assert.equal(adminCalls[2].data.all, true);
  assert.equal('date' in adminCalls[2].data, false);

  console.log('✓ 打卡日历网格、相册选择与统计/管理客户端通过');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
