// 微信小程序聊天媒体选择与读取前置策略。
// 该目录单独使用 CommonJS，便于直接被微信小程序页面 require；不依赖
// Cloudflare Functions 的运行时模块。服务端契约的字节常量在测试中交叉校验。

const UPLOAD_CHANNEL = 'wechat-miniprogram';
const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_SIZE_ERROR = '运动截图超过 30MB';
const AUDIO_SIZE_ERROR = '微信小程序录音不得超过 100 MB';

const FILE_TYPES = Object.freeze({
  image: Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }),
  audio: Object.freeze({ mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac' }),
});

function uploadError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  Object.assign(error, extra);
  return error;
}

function extensionOf(file) {
  const name = String(file?.name || file?.path || '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function mimeTypeOf(file, kind) {
  const extension = extensionOf(file);
  // 录音/图片按扩展名单独限制：扩展名非空但不在该 kind 白名单时直接拒绝，
  // 避免 MIME 白名单短路放行 .mp4/.gif 这类越界文件。无扩展名时仍按 MIME 判定。
  if (extension && !FILE_TYPES[kind]?.[extension]) return null;
  const expected = FILE_TYPES[kind]?.[extension];
  const actual = String(file?.type || '').toLowerCase();
  const supported = Object.values(FILE_TYPES[kind] || {});
  if (supported.includes(actual)) return actual;
  if (kind === 'audio' && actual === 'audio/x-m4a') return 'audio/mp4';
  if (kind === 'audio' && actual === 'audio/x-wav') return 'audio/wav';
  if (!expected) return null;
  if (!actual || actual === 'application/octet-stream' || actual === kind || (kind === 'audio' && actual === 'file')) return expected;
  return actual === expected ? expected : null;
}

function validateSize(tempFile, { maxBytes, invalidMessage, tooLargeMessage }) {
  const size = Number(tempFile?.size);
  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, error: invalidMessage };
  }
  if (size > maxBytes) {
    return { ok: false, error: tooLargeMessage };
  }
  return { ok: true, size };
}

function validateAudioSelection(tempFile) {
  return validateSize(tempFile, {
    maxBytes: AUDIO_MAX_BYTES,
    invalidMessage: '录音大小无效',
    tooLargeMessage: AUDIO_SIZE_ERROR,
  });
}

function validateImageSelection(tempFile) {
  return validateSize(tempFile, {
    maxBytes: IMAGE_MAX_BYTES,
    invalidMessage: '截图大小无效',
    tooLargeMessage: IMAGE_SIZE_ERROR,
  });
}

function validateSelectedFile(tempFile, kind) {
  const sizeResult = kind === 'image' ? validateImageSelection(tempFile) : validateAudioSelection(tempFile);
  if (!sizeResult.ok) {
    return { ...sizeResult, code: sizeResult.error.includes('超过') ? 'too_large' : 'invalid_size' };
  }
  const mime = mimeTypeOf(tempFile, kind);
  if (!mime) {
    return {
      ok: false,
      error: kind === 'image' ? '运动截图类型不支持，仅支持 PNG/JPG/WebP' : '录音类型不支持，仅支持 MP3/M4A/WAV/AAC',
      code: 'unsupported_type',
    };
  }
  return { ok: true, size: sizeResult.size, mime };
}

function normalizeChooseFailure(raw, source = '微信聊天选择器') {
  const message = String(raw?.errMsg || raw?.message || '').toLowerCase();
  if (message.includes('cancel')) {
    return uploadError('cancelled', '已取消选择材料');
  }
  return uploadError('choose_failed', `打开${source}失败，请重试`, { cause: raw });
}

function baseName(filePath) {
  const name = String(filePath || '');
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function chooseMessageFile(wx, kind) {
  return new Promise((resolve, reject) => {
    const options = kind === 'image'
      ? { count: 1, type: 'image' }
      : { count: 1, type: 'file', extension: ['mp3', 'm4a', 'wav', 'aac'] };
    wx.chooseMessageFile({
      ...options,
      success: ({ tempFiles = [] } = {}) => {
        const tempFile = tempFiles[0];
        if (!tempFile || tempFiles.length !== 1) {
          reject(uploadError('cancelled', '未选择材料'));
          return;
        }
        const result = validateSelectedFile(tempFile, kind);
        if (!result.ok) {
          reject(uploadError(result.code, result.error));
          return;
        }
        resolve({ ...tempFile, size: result.size, type: result.mime });
      },
      fail: (error) => reject(normalizeChooseFailure(error)),
    });
  });
}

function chooseImageFile(wx) {
  return chooseMessageFile(wx, 'image');
}

// 相册/相机选择（wx.chooseMedia）：标准小程序能触达「系统」的唯一文件来源，仅限图片。
// chooseMedia 不返回 MIME 与文件名，按临时路径扩展名推导；扩展名缺失时回退 image/jpeg
// （相册只会给图片），随后的 validateSelectedFile 仍做大小与扩展名白名单终检。
function chooseAlbumImage(wx) {
  return new Promise((resolve, reject) => {
    const fail = (raw) => reject(normalizeChooseFailure(raw, '相册/相机'));
    try {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success: ({ tempFiles = [] } = {}) => {
          const tempFile = tempFiles[0];
          if (!tempFile || tempFiles.length !== 1) {
            reject(uploadError('cancelled', '未选择材料'));
            return;
          }
          const path = tempFile.tempFilePath || tempFile.path;
          const selected = {
            path,
            name: baseName(path),
            size: Number(tempFile.size),
            type: mimeTypeOf({ path }, 'image') || 'image/jpeg',
          };
          const result = validateSelectedFile(selected, 'image');
          if (!result.ok) {
            reject(uploadError(result.code, result.error));
            return;
          }
          resolve({ ...selected, size: result.size, type: result.mime });
        },
        fail,
      });
    } catch (cause) {
      fail(cause);
    }
  });
}

function chooseAudioFile(wx) {
  return chooseMessageFile(wx, 'audio');
}

function assertReadByteLength(data, expectedSize, label = '附件') {
  const actualSize = data && typeof data.byteLength === 'number' ? data.byteLength : -1;
  if (actualSize !== expectedSize) {
    throw uploadError('read_size_mismatch', `${label}读取字节数不一致：${actualSize}/${expectedSize}`);
  }
  return data;
}

// 统一读取临时文件的实现：同步 throw 与 fail 回调都归一为 read_failed，
// 读取成功后再按 expectedSize 断言字节数。小程序与打卡客户端共用这一条路径。
function readFileWithSize(wx, filePath, expectedSize, label = '附件') {
  return new Promise((resolve, reject) => {
    const fail = (cause) => reject(uploadError('read_failed', `${label}读取失败，请重新选择`, {
      stage: 'readFile', retryable: true, cause,
    }));
    try {
      wx.getFileSystemManager().readFile({
        filePath,
        success: ({ data }) => {
          try {
            resolve(assertReadByteLength(data, expectedSize, label));
          } catch (error) {
            reject(error);
          }
        },
        fail,
      });
    } catch (cause) {
      fail(cause);
    }
  });
}

function withUploadChannel(payload = {}) {
  return { ...payload, channel: UPLOAD_CHANNEL };
}

module.exports = {
  AUDIO_MAX_BYTES,
  AUDIO_SIZE_ERROR,
  FILE_TYPES,
  IMAGE_MAX_BYTES,
  IMAGE_SIZE_ERROR,
  UPLOAD_CHANNEL,
  assertReadByteLength,
  chooseAlbumImage,
  chooseAudioFile,
  chooseImageFile,
  mimeTypeOf,
  readFileWithSize,
  validateAudioSelection,
  validateImageSelection,
  validateSelectedFile,
  withUploadChannel,
};
