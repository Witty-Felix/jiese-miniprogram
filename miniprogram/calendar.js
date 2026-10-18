// 打卡日历的纯计算模块：把日期集合排成「周为列、星期为行」的网格。
// 不依赖 wx 与页面生命周期，node:test 可直接验证；页面只负责渲染这份结构。
// 口径：只认 checkin 记录里的 YYYY-MM-DD（Asia/Shanghai 由服务端给出）。

const DAY_MS = 86400000;
const CELL_GAP_RPX = 6;
const MIN_PITCH_RPX = 20;
const MAX_PITCH_RPX = 56;
// 750rpx 屏宽 - 页面左右内边距 56rpx - 卡片内边距 60rpx ≈ 634rpx 可用
const CONTENT_WIDTH_RPX = 634;
// 行首星期标签占位（一/三/五）
const WEEKDAY_LABEL_RPX = 44;
const WEEKDAY_LABELS = ['一', '', '三', '', '五', '', ''];

function parseDay(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

function dayString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date, n) {
  return dayString(parseDay(date) + n * DAY_MS);
}

// 周一 = 0 … 周日 = 6，与中文日历习惯一致
function weekdayIndex(date) {
  return (new Date(parseDay(date)).getUTCDay() + 6) % 7;
}

function monthStartOf(date) {
  return `${String(date).slice(0, 7)}-01`;
}

function monthLabelOf(date) {
  return `${Number(String(date).slice(5, 7))}月`;
}

// 日历起点：最早一条打卡所在月的 1 号；没有记录时退回今天所在月。
// 这样站点从 10 月开始就显示 10 月，之后随数据自然向后生长。
function earliestMonthStart(rows, today) {
  let earliest = '';
  for (const row of rows || []) {
    for (const date of row?.dates || []) {
      if (!earliest || date < earliest) earliest = date;
    }
  }
  return monthStartOf(earliest || today);
}

/**
 * @param {{dates?: string[], today: string, start?: string}} input
 * @returns {{weeks:number,pitch:number,cell:number,start:string,today:string,
 *            months:Array<{key:number,label:string}>,rows:Array<{key:string,label:string,cells:Array}>,
 *            contentWidth:number,scrollLeft:number}}
 */
function buildCalendar({ dates = [], today, start } = {}) {
  if (!today) throw new TypeError('buildCalendar 需要 today');
  const from = start && String(start) <= today ? String(start) : monthStartOf(today);
  const checked = new Set(dates);
  const gridStart = addDays(from, -weekdayIndex(from));
  const gridEnd = addDays(today, 6 - weekdayIndex(today));
  const totalDays = Math.round((parseDay(gridEnd) - parseDay(gridStart)) / DAY_MS) + 1;
  const weeks = Math.max(1, Math.round(totalDays / 7));
  // 周数少时放大格子铺满卡片，周数多时缩小并横向滚动
  const pitch = Math.max(MIN_PITCH_RPX, Math.min(MAX_PITCH_RPX, Math.floor(CONTENT_WIDTH_RPX / weeks)));
  const cell = pitch - CELL_GAP_RPX;

  const months = [];
  const rows = WEEKDAY_LABELS.map((label, i) => ({ key: String(i), label, cells: [] }));
  let lastMonth = '';

  for (let w = 0; w < weeks; w += 1) {
    let firstInRange = '';
    for (let d = 0; d < 7; d += 1) {
      const date = addDays(gridStart, w * 7 + d);
      const inRange = date >= from && date <= today;
      if (inRange && !firstInRange) firstInRange = date;
      rows[d].cells.push({
        date,
        inRange,
        checked: inRange && checked.has(date),
        state: inRange ? (checked.has(date) ? 'on' : 'off') : 'out',
      });
    }
    const labelSource = firstInRange || addDays(gridStart, w * 7);
    const month = monthLabelOf(labelSource);
    months.push({ key: w, label: month === lastMonth ? '' : month });
    if (month !== lastMonth) lastMonth = month;
  }

  const contentWidth = WEEKDAY_LABEL_RPX + weeks * pitch;
  return {
    weeks,
    pitch,
    cell,
    start: from,
    today,
    months,
    rows,
    contentWidth,
    scrollLeft: contentWidth,
  };
}

module.exports = {
  CONTENT_WIDTH_RPX,
  WEEKDAY_LABEL_RPX,
  addDays,
  buildCalendar,
  earliestMonthStart,
  monthStartOf,
  weekdayIndex,
};
