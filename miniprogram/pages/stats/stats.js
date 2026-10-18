// 打卡日历页：汇总（累计/连续/今日）+ GitHub 风格日历 + 全员天数列表。
// 数据来自 GET /api/stats?detail=1（邀请码走请求头）；日历口径由 calendar.js 统一计算。
// 管理删除复用 /api/admin/checkin（ADR-0006），密码只存页面内存，不落 storage。

const { createCheckinClient } = require('../../checkin-client.js');
const { buildCalendar, earliestMonthStart } = require('../../calendar.js');

function toast(title) {
  wx.showToast({ title: title || '操作失败', icon: 'none' });
}

Page({
  data: {
    today: '',
    rows: [],
    selectedNickname: '',
    summary: { total: 0, streak: 0, checkedToday: false, lastDate: '' },
    calendar: null,
    admin: false,
    loading: true,
    error: '',
  },

  onLoad() {
    const app = getApp();
    const session = app.globalData.session || {};
    if (!session.nickname || !session.invite_code) {
      this.setData({ loading: false, error: '登录信息已失效，请返回打卡页重新登录' });
      return;
    }
    this.client = createCheckinClient(wx, { apiBaseUrl: app.globalData.apiBaseUrl });
    this.me = session.nickname;
    this.inviteCode = session.invite_code;
    this.adminPassword = '';
    this.setData({ selectedNickname: session.nickname });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (!this.client) return;
    this.setData({ loading: true, error: '' });
    try {
      const data = await this.client.fetchStats(this.inviteCode);
      this.applyStats(data.rows || [], data.today, this.data.selectedNickname);
    } catch (error) {
      this.setData({ error: error?.message || '统计加载失败，请稍后重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 一次请求的数据同时喂日历与全员列表：切人只重算网格，不再打接口
  applyStats(rows, today, preferred) {
    const want = preferred || this.me;
    const selected = rows.some((r) => r.nickname === want)
      ? want
      : (rows.find((r) => r.nickname === this.me)?.nickname || this.me);
    const row = rows.find((r) => r.nickname === selected) || null;
    const dates = row?.dates || [];
    const calendar = buildCalendar({ dates, today, start: earliestMonthStart(rows, today) });

    const cellIndex = {};
    for (const line of calendar.rows) {
      for (const cell of line.cells) cellIndex[cell.date] = cell;
    }
    this.cellIndex = cellIndex;

    this.setData({
      rows,
      today,
      selectedNickname: selected,
      summary: {
        total: row?.total || 0,
        streak: row?.streak || 0,
        checkedToday: Boolean(row?.checked_today),
        lastDate: row?.last_date || '—',
      },
      calendar,
    });
  },

  onSelectMember(event) {
    const nickname = event.currentTarget.dataset.nickname;
    if (!nickname || nickname === this.data.selectedNickname) return;
    this.applyStats(this.data.rows, this.data.today, nickname);
  },

  onCellTap(event) {
    const date = event.currentTarget.dataset.date;
    const cell = this.cellIndex?.[date];
    if (!cell || !cell.inRange) return;
    if (!this.data.admin) {
      wx.showModal({
        title: date,
        content: cell.checked ? '这天已打卡' : '这天没有打卡记录',
        showCancel: false,
      });
      return;
    }
    if (!cell.checked) {
      toast('这天没有记录');
      return;
    }
    this.deleteDay(date);
  },

  askPassword() {
    return new Promise((resolve) => {
      wx.showModal({
        title: '管理密码',
        editable: true,
        placeholderText: '输入管理员密码',
        success: (res) => resolve(res.confirm ? String(res.content || '').trim() : ''),
        fail: () => resolve(''),
      });
    });
  },

  confirm({ title, content }) {
    return new Promise((resolve) => {
      wx.showModal({
        title,
        content,
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      });
    });
  },

  async toggleAdmin() {
    if (this.data.admin) {
      this.adminPassword = '';
      this.setData({ admin: false });
      toast('已退出管理');
      return;
    }
    const password = await this.askPassword();
    if (!password) return;
    try {
      await this.client.adminVerify(password);
      this.adminPassword = password;
      this.setData({ admin: true });
      toast('管理模式已解锁');
    } catch (error) {
      toast(error?.message || '管理密码不正确');
    }
  },

  async deleteDay(date) {
    const nickname = this.data.selectedNickname;
    const ok = await this.confirm({
      title: '删除这一天',
      content: `确认删除「${nickname}」${date} 的打卡记录？只删统计，ima 里的内容不受影响。`,
    });
    if (!ok) return;
    wx.showLoading({ title: '删除中', mask: true });
    try {
      await this.client.deleteCheckin({
        adminPassword: this.adminPassword,
        operator: this.me,
        nickname,
        date,
      });
      wx.hideLoading();
      toast('已删除');
      await this.load();
    } catch (error) {
      wx.hideLoading();
      toast(error?.message || '删除失败');
    }
  },

  async onClearUser(event) {
    const nickname = event.currentTarget.dataset.nickname;
    if (!nickname) return;
    const ok = await this.confirm({
      title: '整户清空',
      content: `确认清空「${nickname}」的全部打卡统计？该用户将从榜单消失，ima 内容不受影响。`,
    });
    if (!ok) return;
    wx.showLoading({ title: '清空中', mask: true });
    try {
      await this.client.deleteCheckin({
        adminPassword: this.adminPassword,
        operator: this.me,
        nickname,
        all: true,
      });
      wx.hideLoading();
      toast('已清空');
      await this.load();
    } catch (error) {
      wx.hideLoading();
      toast(error?.message || '清空失败');
    }
  },

  refresh() {
    this.load();
  },
});
