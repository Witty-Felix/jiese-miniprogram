const { createCheckinClient } = require('../../checkin-client.js');

Page({
  data: {
    loggedIn: false,
    nickname: '',
    inviteCode: '',
    inputNickname: '',
    inputInviteCode: '',
    rememberMe: true,
    remembered: null,
    rememberHint: '',
    image: null,
    audio: null,
    reflection: '',
    uploaded: false,
    pending: false,
    busy: false,
    busyLabel: '',
    error: '',
    success: '',
    duplicatePrompt: false,
    duplicateMessage: '',
  },

  onLoad() {
    const app = getApp();
    this.client = createCheckinClient(wx, { apiBaseUrl: app.globalData.apiBaseUrl });
    this.restoreRemembered();
  },

  // 登录页是否出现「用上次账号进入」，只由本地凭证决定。30 天到期的凭证
  // 已在 client 里作废，这里只把昵称留在输入框，省得重敲一遍。
  restoreRemembered() {
    const saved = this.client.loadRemembered();
    if (saved.status === 'ok') {
      this.setData({
        remembered: { nickname: saved.nickname, inviteCode: saved.invite_code },
        inputNickname: saved.nickname,
        rememberHint: '',
      });
      return;
    }
    if (saved.status === 'expired') {
      this.setData({
        remembered: null,
        inputNickname: saved.nickname,
        rememberHint: '上次记住的登录已满 30 天，补一次邀请码就能继续用。',
      });
      return;
    }
    this.setData({ remembered: null, inputNickname: saved.nickname || '', rememberHint: '' });
  },

  onShow() {
    if (this.client && this.data.loggedIn) this.syncPending(this.data.nickname);
  },

  clearMessage() {
    this.setData({ error: '', success: '' });
  },

  showError(error) {
    this.setData({ error: error?.message || '操作失败，请稍后重试', success: '' });
  },

  // 忙碌时静默拦截；存在待重交登记时阻断当前操作。需要提示时用统一文案，
  // 选择新材料与移除材料共用这一守卫，避免四处重复判断。
  guardBlocked({ notify = false } = {}) {
    if (this.data.busy) return true;
    if (this.data.pending) {
      if (notify) this.showError(new Error('请先重交本次登记，确认结果后再选择新材料'));
      return true;
    }
    return false;
  },

  syncPending(nickname = this.data.nickname) {
    const pending = this.client?.getPending(nickname);
    this.setData({
      pending: Boolean(pending && pending.phase !== 'uploaded'),
      uploaded: Boolean(pending && pending.phase === 'uploaded'),
      ...(pending && !this.data.reflection ? { reflection: pending.reflection || '' } : {}),
    });
  },

  onNicknameInput(event) {
    this.setData({ inputNickname: event.detail.value });
  },

  onInviteCodeInput(event) {
    this.setData({ inputInviteCode: event.detail.value });
  },

  // 登录用 bindtap 从 data 读输入值，不用 form submit：form 事件在部分
  // 运行环境（含预览面板）不触发，bindtap 全平台通用。
  async onLogin() {
    if (this.data.busy) return;
    const nickname = String(this.data.inputNickname || '').trim();
    const invite_code = String(this.data.inputInviteCode || '').trim();
    this.clearMessage();
    if (!nickname || !invite_code) {
      this.showError(new Error('请填写昵称和邀请码'));
      return;
    }
    this.setData({ busy: true, busyLabel: '验证中…' });
    try {
      await this.client.verify({ nickname, invite_code });
      // 会话放内存，日历页靠它取明细；勾了「记住我」才额外落一份本地凭证，
      // 让下次打开能一键进入。两条路径互不影响。
      getApp().globalData.session = { nickname, invite_code };
      this.persistRemembered({ nickname, invite_code });
      this.setData({ loggedIn: true, nickname, inviteCode: invite_code, inputInviteCode: '', rememberHint: '' });
      this.syncPending(nickname);
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

  // 勾着就存，取消勾选就把旧的清掉：开关必须双向生效，否则「取消」等于没关。
  persistRemembered({ nickname, invite_code }) {
    if (this.data.rememberMe && this.client.saveRemembered({ nickname, invite_code })) {
      this.setData({ remembered: { nickname, inviteCode: invite_code } });
      return;
    }
    this.client.clearRemembered();
    this.setData({ remembered: null });
  },

  onRememberChange(event) {
    const values = event?.detail?.value;
    this.setData({ rememberMe: Array.isArray(values) ? values.length > 0 : Boolean(values) });
  },

  // 一键进入：与手动登录同一条 verify 路径，成功就写会话进打卡页。
  async onAutoLogin() {
    if (this.data.busy) return;
    const saved = this.data.remembered;
    if (!saved) return;
    this.clearMessage();
    this.setData({ busy: true, busyLabel: '自动登录中…' });
    try {
      await this.client.verify({ nickname: saved.nickname, invite_code: saved.inviteCode });
      getApp().globalData.session = { nickname: saved.nickname, invite_code: saved.inviteCode };
      this.setData({
        loggedIn: true,
        nickname: saved.nickname,
        inviteCode: saved.inviteCode,
        inputNickname: saved.nickname,
        inputInviteCode: '',
        rememberHint: '',
      });
      this.syncPending(saved.nickname);
    } catch (error) {
      this.handleAutoLoginFailure(error, saved);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

  // 只有服务端明确拒绝才作废凭证；断网或网关返回坏包时凭证仍可能有效，
  // 为一次地铁断网就罚用户重敲一整遍，不值。
  handleAutoLoginFailure(error, saved) {
    const unreachable = error?.code === 'network_error' || error?.code === 'invalid_response';
    if (!unreachable) {
      this.client.clearRemembered();
      this.setData({ remembered: null, inputNickname: saved.nickname, inputInviteCode: '' });
    }
    wx.showModal({
      title: unreachable ? '网络不给力' : '登录信息已失效',
      content: unreachable
        ? '没能连上服务器，记住的登录还在，等网络恢复后再点一次。'
        : '上次记住的邀请码已不能使用，请重新输入。昵称已经帮你填好了。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  // 「切换账号」只丢凭证，不动正在输入的内容之前的账号，直接回到空白表单。
  onSwitchAccount() {
    if (this.data.busy) return;
    this.client.clearRemembered();
    this.setData({ remembered: null, inputNickname: '', inputInviteCode: '', rememberHint: '' });
    this.clearMessage();
  },

  logout() {
    if (this.data.busy) return;
    wx.showModal({
      title: '退出登录',
      content: '退出后会清掉记住的凭证，下次要重新输入昵称和邀请码。',
      confirmText: '退出',
      confirmColor: '#a32d2d',
      success: (res) => {
        if (!res.confirm) return;
        this.client.forgetRemembered();
        getApp().globalData.session = null;
        this.setData({
          loggedIn: false,
          nickname: '',
          inviteCode: '',
          inputNickname: '',
          inputInviteCode: '',
          image: null,
          audio: null,
          reflection: '',
          pending: false,
          uploaded: false,
          remembered: null,
          rememberMe: true,
          rememberHint: '',
        });
        this.clearMessage();
      },
    });
  },

  // 日历页入口：先把会话写进 globalData，页面间不传邀请码到 URL
  openStats() {
    getApp().globalData.session = { nickname: this.data.nickname, invite_code: this.data.inviteCode };
    wx.navigateTo({ url: '/pages/stats/stats' });
  },

  // 相册/相机与聊天选择器共用同一条「选完即上传」路径，只有选择器不同
  async pickImage(chooser, busyLabel) {
    if (this.guardBlocked({ notify: true })) return;
    this.clearMessage();
    this.setData({ busy: true, busyLabel });
    try {
      const image = await chooser();
      // 重新选材料意味着开始新提交；结果未知重交只能继续使用旧回执。
      this.client.clearPending(this.data.nickname);
      this.setData({ image, pending: false, uploaded: false });
      await this.uploadWhenReady();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

  chooseAlbumImage() {
    return this.pickImage(() => this.client.chooseAlbumImage(), '打开相册…');
  },

  chooseImage() {
    return this.pickImage(() => this.client.chooseImageFile(), '选择材料…');
  },

  async chooseAudio() {
    if (this.guardBlocked({ notify: true })) return;
    this.clearMessage();
    this.setData({ busy: true, busyLabel: '选择材料…' });
    try {
      const audio = await this.client.chooseAudioFile();
      this.client.clearPending(this.data.nickname);
      this.setData({ audio, pending: false, uploaded: false });
      await this.uploadWhenReady();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

  async uploadWhenReady() {
    if (!this.data.image || !this.data.audio) return;
    this.setData({ busyLabel: '材料齐备，正在自动上传…' });
    const result = await this.client.uploadMaterials({ nickname: this.data.nickname, invite_code: this.data.inviteCode, image: this.data.image, audio: this.data.audio, confirmDuplicateDay: message => this.askDuplicateDay(message) });
    if (result.status === 'cancelled') { this.showError(new Error(result.error)); return; }
    this.syncPending();
  },

  removeImage() {
    if (this.guardBlocked()) return;
    this.client.clearPending(this.data.nickname);
    this.setData({ image: null, pending: false, uploaded: false });
    this.clearMessage();
  },

  removeAudio() {
    if (this.guardBlocked()) return;
    this.client.clearPending(this.data.nickname);
    this.setData({ audio: null, pending: false, uploaded: false });
    this.clearMessage();
  },

  onReflectionInput(event) {
    this.setData({ reflection: event.detail.value });
  },

  askDuplicateDay(message) {
    this.setData({ duplicatePrompt: true, duplicateMessage: message });
    return new Promise((resolve) => { this.duplicateResolver = resolve; });
  },

  resolveDuplicate(event) {
    const answer = event?.currentTarget?.dataset?.answer === 'true';
    const resolve = this.duplicateResolver;
    this.duplicateResolver = null;
    this.setData({ duplicatePrompt: false });
    resolve?.(answer);
  },

  async submit() {
    if (this.data.busy) return;
    const pending = this.client.getPending(this.data.nickname);
    if (!pending && (!this.data.image || !this.data.audio)) {
      this.showError(new Error('请先选择运动截图和阅读录音'));
      return;
    }
    this.clearMessage();
    this.setData({ busy: true, busyLabel: pending?.phase === 'uploaded' ? '登记打卡…' : pending ? '重交本次登记…' : '准备材料并上传…' });
    try {
      const result = await this.client.submit({
        nickname: this.data.nickname,
        invite_code: this.data.inviteCode,
        reflection: this.data.reflection,
        image: this.data.image,
        audio: this.data.audio,
        confirmDuplicateDay: (message) => this.askDuplicateDay(message),
      });
      if (result.status === 'cancelled') {
        this.showError(new Error(result.error));
        return;
      }
      const already = result.status === 'already';
      const statsPending = result.stats_updated === false;
      this.setData({
        image: null,
        audio: null,
        reflection: '',
        pending: statsPending,
        uploaded: false,
        success: statsPending
          ? '材料已经登记，但统计暂未更新；请重交本次登记以补齐统计，不会重复写入 ima。'
          : (already ? '本次是安全重交：此前已经登记成功，没有重复写入。' : '打卡成功：截图、录音和感悟已登记。'),
        error: '',
      });
    } catch (error) {
      this.syncPending(this.data.nickname);
      this.showError(error);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

});
