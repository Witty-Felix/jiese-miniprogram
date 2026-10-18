const assert = require('node:assert/strict');
const {
  AUDIO_MAX_BYTES,
  AUDIO_SIZE_ERROR,
  UPLOAD_CHANNEL,
  assertReadByteLength,
  mimeTypeOf,
  validateAudioSelection,
  withUploadChannel,
} = require('../miniprogram/upload-policy.js');

assert.equal(AUDIO_MAX_BYTES, 100 * 1024 * 1024);
assert.deepEqual(validateAudioSelection({ size: AUDIO_MAX_BYTES }), { ok: true, size: AUDIO_MAX_BYTES });
assert.deepEqual(validateAudioSelection({ size: AUDIO_MAX_BYTES + 1 }), { ok: false, error: AUDIO_SIZE_ERROR });
assert.deepEqual(validateAudioSelection({ size: 0 }), { ok: false, error: '录音大小无效' });
assert.throws(() => assertReadByteLength(new ArrayBuffer(3), 4, '录音'), /录音读取字节数不一致：3\/4/);
const bytes = new ArrayBuffer(4);
assert.equal(assertReadByteLength(bytes, 4), bytes);
assert.deepEqual(withUploadChannel({ nickname: '成员甲' }), {
  nickname: '成员甲', channel: UPLOAD_CHANNEL,
});
// 扩展名预检：越界扩展名即便 MIME 命中白名单也必须拒绝。
assert.equal(mimeTypeOf({ name: 'clip.mp4', type: 'audio/mp4' }, 'audio'), null);
assert.equal(mimeTypeOf({ name: 'photo.gif', type: 'image/jpeg' }, 'image'), null);
// 无扩展名仍按合法 MIME 放行。
assert.equal(mimeTypeOf({ path: '/tmp/blob', type: 'audio/mp4' }, 'audio'), 'audio/mp4');
console.log('✓ 小程序 100 MiB 前置校验、readFile 字节断言与通道标识通过');