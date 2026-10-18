// 微信小程序打卡客户端。
// 这里把选择、API 契约、COS 单次 PUT 和结果未知重交收在一个可测试的
// 公共边界；页面只负责输入状态和提示，不另造一套上传/重试协议。

const {
  AUDIO_MAX_BYTES,
  UPLOAD_CHANNEL,
  chooseAlbumImage,
  chooseAudioFile,
  chooseImageFile,
  readFileWithSize,
  validateSelectedFile,
  withUploadChannel,
} = require('./upload-policy.js');
const { PRODUCTION_API_BASE_URL } = require('./config.js');

// 生产 API 基址只保留 config.js 一个真值来源，此处沿用旧导出名以免破坏调用方。
const DEFAULT_API_BASE_URL = PRODUCTION_API_BASE_URL;
const PENDING_PREFIX = 'jiese-miniprogram-pending-v1';
const PENDING_VERSION = 1;
const REFLECTION_MAX = 2000;

// 「记住我」凭证：昵称 + 邀请码明文存本机，30 天硬过期。
// 邀请码是团队共享口令而非个人密码，且每次自动登录仍会 verify 一次，
// 服务端拒绝即失效；因此不做本地加密（密钥同在本地，加密只是障眼法）。
const REMEMBER_KEY = 'jiese-miniprogram-remember-v1';
const NICKNAME_HINT_KEY = 'jiese-miniprogram-nickname-v1';
const REMEMBER_VERSION = 1;
const REMEMBER_DAYS = 30;
const DAY_MS = 24 * 3600e3;

class CheckinError extends Error {
  constructor(message, { code = 'checkin_error', stage, retryable, status, cause } = {}) {
    super(message);
    this.name = 'CheckinError';
    this.code = code;
    if (stage !== undefined) this.stage = stage;
    if (retryable !== undefined) this.retryable = retryable;
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

function makeError(message, options) {
  return new CheckinError(message, options);
}

function todayDate(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}

function parseJsonData(data) {
  if (data && typeof data === 'object') return data;
  if (typeof data === 'string' && data.trim()) {
    try { return JSON.parse(data); } catch { return null; }
  }
  return null;
}

function pendingKey(nickname) {
  return `${PENDING_PREFIX}:${nickname}`;
}

function defaultStorage(wx) {
  return {
    get(key) { return wx.getStorageSync(key); },
    set(key, value) { wx.setStorageSync(key, value); },
    remove(key) { wx.removeStorageSync(key); },
  };
}

function requestWithWx(wx, options) {
  return new Promise((resolve, reject) => {
    try {
      wx.request({ ...options, success: resolve, fail: reject });
    } catch (error) {
      reject(error);
    }
  });
}

function apiError(data, httpStatus) {
  const message = data?.error || '请求失败，请稍后重试';
  return makeError(message, {
    code: data?.stage || 'api_error',
    stage: data?.stage,
    retryable: data?.retryable,
    status: data?.status,
    cause: httpStatus ? { httpStatus } : undefined,
  });
}

function unknownResult(httpStatus, cause) {
  const suffix = httpStatus ? `（HTTP ${httpStatus}）` : '';
  return {
    ok: false,
    stage: 'result_unknown',
    retryable: true,
    error: `没有收到登记结果${suffix}，服务端可能已经登记。请点「重交本次登记」再试一次`,
    _httpStatus: httpStatus,
    _cause: cause,
  };
}

function validateClientSelection(file, kind) {
  const result = validateSelectedFile(file, kind);
  if (!result.ok) {
    throw makeError(result.error, { code: result.code || 'invalid_file', retryable: false });
  }
  return { ...file, size: result.size, type: result.mime };
}

// prepare 回执 + 本地字节数 → 检查点/重交使用的媒体回执。
function toMediaReceipt(prepared, size) {
  return { media_id: prepared.media_id, cos_key: prepared.cos_key, size };
}

// 复用 upload-policy 的统一读取实现（read_failed 语义与消息逐字保持）。
function readSelectedFile(wx, selected, label) {
  return readFileWithSize(wx, selected.path, selected.size, label);
}

async function putCos(wx, item, bytes, contentType) {
  let response;
  try {
    response = await requestWithWx(wx, {
      url: item.cos_url,
      method: 'PUT',
      header: {
        Authorization: item.authorization,
        'x-cos-security-token': item.token,
        'Content-Type': contentType,
        // 显式声明 Content-Length：该值与读取后断言的 byteLength 一致，并与服务端
        // 预签名 content-length 面匹配；保留以防御 chunked/高性能模式下的头行为差异（真机已验收）。
        'Content-Length': String(bytes.byteLength),
      },
      data: bytes,
      responseType: 'text',
    });
  } catch (cause) {
    throw makeError('材料直传网络错误，请重试', {
      code: 'upload_failed', stage: 'cos_upload', retryable: true, cause,
    });
  }
  const status = Number(response?.statusCode || 0);
  if (status >= 200 && status < 300) return true;
  throw makeError(`材料直传失败（HTTP ${status || '未知'}），请重试`, {
    code: 'upload_failed', stage: 'cos_upload', retryable: true, status,
  });
}

function createCheckinClient(wx, options = {}) {
  if (!wx || typeof wx.request !== 'function') {
    throw new TypeError('createCheckinClient 需要微信 wx API');
  }
  const apiBaseUrl = String(options.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const storage = options.storage || defaultStorage(wx);
  const now = options.now || (() => Date.now());

  async function requestApi(path, data, { unknownOnFailure = false, method = 'POST', header } = {}) {
    let response;
    try {
      response = await requestWithWx(wx, {
        url: `${apiBaseUrl}${path}`,
        method,
        header: header || { 'Content-Type': 'application/json' },
        data,
        dataType: 'json',
      });
    } catch (cause) {
      if (unknownOnFailure) return unknownResult(undefined, cause);
      throw makeError('网络错误，请检查网络后重试', { code: 'network_error', retryable: true, cause });
    }
    const dataObject = parseJsonData(response?.data);
    if (!dataObject) {
      const httpStatus = Number(response?.statusCode);
      // finalize 场景下只有 5xx / 无状态码才可能是「结果未知」；4xx 明确是客户端错误，
      // 直接抛普通错误，避免引导用户对必然失败的请求重交。
      const clientError = httpStatus >= 400 && httpStatus < 500;
      if (clientError || !unknownOnFailure) {
        throw makeError('服务器返回无法解析的响应，请重试', {
          code: 'invalid_response', retryable: true, status: response?.statusCode, cause: response,
        });
      }
      return unknownResult(response?.statusCode, response);
    }
    return { ...dataObject, _httpStatus: response?.statusCode };
  }

  async function verify(credentials) {
    const data = await requestApi('/api/verify', credentials);
    if (!data.ok) throw apiError(data, data._httpStatus);
    return data;
  }

  async function prepare(payload) {
    const data = await requestApi('/api/prepare', payload);
    if (!data.ok) throw apiError(data, data._httpStatus);
    return data;
  }

  async function finalize(payload) {
    return requestApi('/api/finalize', payload, { unknownOnFailure: true });
  }

  // 日历页数据：detail=1 才会返回每个成员的 dates，且必须带邀请码。
  // 邀请码走请求头而非 URL —— 免得挤进访问日志。
  async function fetchStats(inviteCode) {
    const code = String(inviteCode || '').trim();
    if (!code) throw makeError('缺少邀请码，请返回重新登录', { code: 'missing_credentials', retryable: false });
    const data = await requestApi('/api/stats?detail=1', undefined, {
      method: 'GET',
      header: { 'X-Invite-Code': code },
    });
    if (!data.ok) throw apiError(data, data._httpStatus);
    return data;
  }

  // 管理模式（ADR-0006）：密码只在页面内存中保留，随每次删除请求携带，
  // 不落 storage —— 与 H5 的 sessionStorage 同一边界。
  async function adminVerify(adminPassword) {
    const data = await requestApi('/api/admin/verify', { admin_password: adminPassword });
    if (!data.ok) throw apiError(data, data._httpStatus);
    return data;
  }

  async function deleteCheckin({ adminPassword, operator, nickname, date, all = false } = {}) {
    const payload = {
      admin_password: adminPassword,
      operator,
      nickname,
      ...(all ? { all: true } : { date }),
    };
    const data = await requestApi('/api/admin/checkin', payload, { method: 'DELETE' });
    if (!data.ok) throw apiError(data, data._httpStatus);
    return data;
  }

  function getPending(nickname) {
    if (!nickname) return null;
    let value;
    try { value = storage.get(pendingKey(nickname)); } catch { return null; }
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { value = null; }
    }
    if (!value || value.version !== PENDING_VERSION || value.channel !== UPLOAD_CHANNEL || !value.submission_id) {
      if (value) { try { storage.remove(pendingKey(nickname)); } catch { /* best effort */ } }
      return null;
    }
    if (value.date !== todayDate(now())) {
      try { storage.remove(pendingKey(nickname)); } catch { /* best effort */ }
      return null;
    }
    return value;
  }

  function savePending(record) {
    try {
      storage.set(pendingKey(record.nickname), JSON.stringify(record));
    } catch (cause) {
      throw makeError('无法保存重交检查点，未登记本次打卡。请保持页面打开并重试', {
        code: 'checkpoint_failed', stage: 'checkpoint', retryable: false, cause,
      });
    }
  }

  function clearPending(nickname) {
    if (!nickname) return;
    try { storage.remove(pendingKey(nickname)); } catch { /* best effort */ }
  }

  // 昵称单独存一份：30 天过期或凭证被清后，登录页仍能预填昵称，少敲一次。
  function saveNicknameHint(nickname) {
    try { storage.set(NICKNAME_HINT_KEY, nickname); } catch { /* best effort */ }
  }

  function loadNicknameHint() {
    try {
      const value = storage.get(NICKNAME_HINT_KEY);
      return typeof value === 'string' ? value.trim() : '';
    } catch { return ''; }
  }

  // 返回 { status: 'ok' | 'expired' | 'none', nickname, invite_code }
  // expired 表示已满 30 天：邀请码当场作废，昵称留给页面预填。
  function loadRemembered() {
    let value;
    try { value = storage.get(REMEMBER_KEY); } catch { return { status: 'none', nickname: '', invite_code: '' }; }
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { value = null; }
    }
    if (!value || value.version !== REMEMBER_VERSION) {
      return { status: 'none', nickname: loadNicknameHint(), invite_code: '' };
    }
    const nickname = String(value.nickname || '').trim();
    const inviteCode = String(value.invite_code || '').trim();
    if (!nickname || !inviteCode) {
      return { status: 'none', nickname: loadNicknameHint(), invite_code: '' };
    }
    const savedAt = Number(value.saved_at) || 0;
    if (!savedAt || now() - savedAt > REMEMBER_DAYS * DAY_MS) {
      clearRemembered();
      return { status: 'expired', nickname, invite_code: '' };
    }
    return { status: 'ok', nickname, invite_code: inviteCode };
  }

  // 30 天从首次保存起算，不随每次进入续期：这是安全闸，天天用也不该无限延长。
  function saveRemembered({ nickname, invite_code } = {}) {
    const cleanNickname = String(nickname || '').trim();
    const inviteCode = String(invite_code || '').trim();
    if (!cleanNickname || !inviteCode) return false;
    try {
      storage.set(REMEMBER_KEY, JSON.stringify({
        version: REMEMBER_VERSION,
        nickname: cleanNickname,
        invite_code: inviteCode,
        saved_at: now(),
      }));
      saveNicknameHint(cleanNickname);
      return true;
    } catch { return false; }
  }

  function clearRemembered() {
    try { storage.remove(REMEMBER_KEY); } catch { /* best effort */ }
  }

  // 退出登录 = 彻底退出：凭证与昵称提示一起清掉，下次从空白开始。
  function forgetRemembered() {
    clearRemembered();
    try { storage.remove(NICKNAME_HINT_KEY); } catch { /* best effort */ }
  }

  async function finishSubmission({ nickname, invite_code, reflection, checkpoint, confirmDuplicateDay }) {
    const fixedReflection = String(reflection || '').trim().slice(0, REFLECTION_MAX);
    const base = {
      nickname,
      invite_code,
      channel: UPLOAD_CHANNEL,
      submission_id: checkpoint.submission_id,
      reflection: fixedReflection,
      image: checkpoint.image,
      audio: checkpoint.audio,
      ...(checkpoint.allow_duplicate_day ? { allow_duplicate_day: true } : {}),
    };
    let result = await finalize(base);
    // 仅当本次尚未确认过重复日时才弹二次确认；已确认仍收到 duplicate_day 说明
    // 服务端拒绝，落入下方普通错误路径，不再重复打扰用户。
    if (!result.ok && result.status === 'duplicate_day' && !checkpoint.allow_duplicate_day) {
      const confirmed = typeof confirmDuplicateDay === 'function'
        ? await confirmDuplicateDay(result.error || '你今天已经打过卡了，确认要再登记一次吗？')
        : false;
      if (!confirmed) return { ok: false, status: 'cancelled', error: '已取消：今天的打卡记录保持不变。' };
      checkpoint.allow_duplicate_day = true;
      savePending(checkpoint);
      result = await finalize({ ...base, allow_duplicate_day: true });
    }
    if (!result.ok) {
      if (result.retryable === false) clearPending(nickname);
      throw makeError(result.error || '登记失败，请稍后重试', {
        code: result.stage || (result.status === 'duplicate_day' ? 'duplicate_day' : 'finalize_failed'),
        stage: result.stage,
        retryable: result.retryable,
        status: result.status,
        cause: result._cause,
      });
    }
    // ima 已登记但统计占位未补齐时必须保留检查点：下一次 finalize 会命中
    // already 分支，只补写 KV，不会再次触碰 ima。清理检查点意味着这条补救路径丢失。
    if (result.stats_updated !== false) clearPending(nickname);
    return result;
  }

  async function uploadMaterials({ nickname, invite_code, reflection = '', image, audio, confirmDuplicateDay } = {}) {
    const cleanNickname = String(nickname || '').trim();
    const inviteCode = String(invite_code || '').trim();
    if (!cleanNickname || !inviteCode) {
      throw makeError('请填写昵称和邀请码', { code: 'missing_credentials', retryable: false });
    }

    const pending = getPending(cleanNickname);
    if (pending) return { ok: true, status: pending.phase === 'uploaded' ? 'uploaded' : 'pending', checkpoint: pending };

    if (!image || !audio) {
      throw makeError('请先选择运动截图和阅读录音', { code: 'missing_material', retryable: false });
    }
    const selectedImage = validateClientSelection(image, 'image');
    const selectedAudio = validateClientSelection(audio, 'audio');

    const prepared = await prepare(withUploadChannel({
      nickname: cleanNickname,
      invite_code: inviteCode,
      image: { size: selectedImage.size, type: selectedImage.type },
      audio: { size: selectedAudio.size, type: selectedAudio.type },
    }));

    let confirmedDuplicateDay = false;
    if (prepared.already_today) {
      const confirmed = typeof confirmDuplicateDay === 'function'
        ? await confirmDuplicateDay('你今天已经打过卡了，确认要再登记一次吗？')
        : false;
      if (!confirmed) return { ok: false, status: 'cancelled', error: '已取消：今天的打卡记录保持不变。' };
      confirmedDuplicateDay = true;
    }

    // 临时路径只在当前小程序生命周期中有效：prepare 成功后立即读出，
    // 字节长度通过断言后才能进入两次单对象 PUT。
    const [imageBytes, audioBytes] = await Promise.all([
      readSelectedFile(wx, selectedImage, '截图'),
      readSelectedFile(wx, selectedAudio, '录音'),
    ]);
    await Promise.all([
      putCos(wx, prepared.image, imageBytes, selectedImage.type),
      putCos(wx, prepared.audio, audioBytes, selectedAudio.type),
    ]);

    const checkpoint = {
      version: PENDING_VERSION,
      phase: 'uploaded',
      nickname: cleanNickname,
      date: prepared.date || todayDate(now()),
      channel: UPLOAD_CHANNEL,
      submission_id: prepared.submission_id,
      reflection: String(reflection || '').trim().slice(0, REFLECTION_MAX),
      image: toMediaReceipt(prepared.image, selectedImage.size),
      audio: toMediaReceipt(prepared.audio, selectedAudio.size),
      ...(confirmedDuplicateDay ? { allow_duplicate_day: true } : {}),
    };
    // 材料已全部到 COS，先落检查点，再发 finalize；否则结果未知时无法安全重交。
    savePending(checkpoint);
    return { ok: true, status: 'uploaded', checkpoint };
  }

  async function submit(options = {}) {
    const nickname = String(options.nickname || '').trim();
    const inviteCode = String(options.invite_code || '').trim();
    if (!nickname || !inviteCode) throw makeError('请填写昵称和邀请码', { code: 'missing_credentials', retryable: false });
    let checkpoint = getPending(nickname);
    if (!checkpoint) {
      const result = await uploadMaterials(options);
      if (result.status === 'cancelled') return result;
      checkpoint = result.checkpoint;
    }
    // Uploaded-only receipts allow reflection editing; after finalize starts,
    // retries must keep the frozen payload, including legacy phase-less receipts.
    if (checkpoint.phase === 'uploaded') {
      checkpoint = { ...checkpoint, phase: 'finalizing', reflection: String(options.reflection || '').trim().slice(0, REFLECTION_MAX) };
      savePending(checkpoint);
    }
    return finishSubmission({ nickname, invite_code: inviteCode, reflection: checkpoint.reflection, checkpoint, confirmDuplicateDay: options.confirmDuplicateDay });
  }

  return {
    apiBaseUrl,
    adminVerify,
    chooseAlbumImage: () => chooseAlbumImage(wx),
    chooseAudioFile: () => chooseAudioFile(wx),
    chooseImageFile: () => chooseImageFile(wx),
    clearPending,
    clearRemembered,
    forgetRemembered,
    deleteCheckin,
    fetchStats,
    getPending,
    loadNicknameHint,
    loadRemembered,
    saveRemembered,
    uploadMaterials,
    submit,
    verify,
  };
}

module.exports = {
  AUDIO_MAX_BYTES,
  DEFAULT_API_BASE_URL,
  PENDING_PREFIX,
  REMEMBER_DAYS,
  REMEMBER_KEY,
  UPLOAD_CHANNEL,
  CheckinError,
  createCheckinClient,
  todayDate,
};
