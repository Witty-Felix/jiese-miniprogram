import assert from 'node:assert/strict';
import {
  AUDIO_MAX_BYTES,
  AUDIO_SIZE_ERROR,
  UPLOAD_CHANNEL,
  assertReadByteLength,
  chooseAudioFile,
  readFileWithSize,
  validateAudioSelection,
  withUploadChannel,
} from '../miniprogram/upload-policy.js';
import {
  IMAGE_MAX_BYTES as API_IMAGE_MAX_BYTES,
  UPLOAD_CHANNEL as API_UPLOAD_CHANNEL,
  WECHAT_AUDIO_LIMIT_ERROR as API_AUDIO_SIZE_ERROR,
  WECHAT_AUDIO_MAX_BYTES as API_AUDIO_MAX_BYTES,
} from '../functions/api/_upload-contract.js';

assert.equal(AUDIO_MAX_BYTES, API_AUDIO_MAX_BYTES);
assert.equal(AUDIO_SIZE_ERROR, API_AUDIO_SIZE_ERROR);
assert.equal(UPLOAD_CHANNEL, API_UPLOAD_CHANNEL.WECHAT_MINIPROGRAM);
assert.equal(API_IMAGE_MAX_BYTES, 30 * 1024 * 1024);
assert.deepEqual(validateAudioSelection({ size: AUDIO_MAX_BYTES }), { ok: true, size: AUDIO_MAX_BYTES });
assert.deepEqual(validateAudioSelection({ size: AUDIO_MAX_BYTES + 1 }), { ok: false, error: AUDIO_SIZE_ERROR });
assert.deepEqual(validateAudioSelection({ size: 0 }), { ok: false, error: '录音大小无效' });
assert.throws(() => assertReadByteLength(new ArrayBuffer(3), 4, '录音'), /录音读取字节数不一致：3\/4/);
const bytes = new ArrayBuffer(4);
assert.equal(assertReadByteLength(bytes, 4), bytes);
assert.deepEqual(withUploadChannel({ nickname: '成员甲' }), {
  nickname: '成员甲', channel: UPLOAD_CHANNEL,
});


const selected = { path: '/tmp/reading.m4a', name: 'reading.m4a', size: 4 };
let readCalls = 0;
const wx = {
  chooseMessageFile(options) {
    assert.deepEqual(options.extension, ['mp3', 'm4a', 'wav', 'aac']);
    options.success({ tempFiles: [selected] });
  },
  getFileSystemManager() {
    return { readFile({ filePath, success }) {
      assert.equal(filePath, selected.path);
      readCalls += 1;
      success({ data: new ArrayBuffer(4) });
    } };
  },
};
// chooseAndReadAudio 已从生产导出移除，这里按页面实际路径组合 chooseAudioFile + readFileWithSize。
const selectedAudio = await chooseAudioFile(wx);
const data = await readFileWithSize(wx, selectedAudio.path, selectedAudio.size, '录音');
assert.equal(data.byteLength, selected.size);
assert.equal(readCalls, 1);

let oversizeReadCalls = 0;
await assert.rejects(() => chooseAudioFile({
  chooseMessageFile(options) {
    options.success({ tempFiles: [{ path: '/tmp/big.wav', size: AUDIO_MAX_BYTES + 1 }] });
  },
  getFileSystemManager() {
    return { readFile() { oversizeReadCalls += 1; } };
  },
}), /100 MB/);
assert.equal(oversizeReadCalls, 0);

console.log('✓ 小程序 100 MiB 前置校验、readFile 字节断言与通道标识通过');
