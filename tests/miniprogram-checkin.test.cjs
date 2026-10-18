const assert = require('node:assert/strict');
const {
  AUDIO_MAX_BYTES,
  UPLOAD_CHANNEL,
  createCheckinClient,
} = require('../miniprogram/checkin-client.js');

async function main() {

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TODAY = '2026-10-04';
const NOW = new Date('2026-10-04T12:00:00+08:00').getTime();

function makeStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get(key) { return values.get(key); },
    set(key, value) { values.set(key, value); },
    remove(key) { values.delete(key); },
    value(key) { return values.get(key); },
  };
}

function responseFor(route, body, options) {
  const answer = typeof route === 'function' ? route(body, options) : route;
  if (answer?.throw) throw Object.assign(new Error(answer.throw), { errMsg: answer.throw });
  if (answer?.fail) throw Object.assign(new Error(answer.fail), { errMsg: answer.fail });
  return answer;
}

function makeWx({ image, audio, bytes = {}, routes = {}, chooseFail = {} } = {}) {
  const calls = { choose: [], reads: [], requests: [], puts: [], uploadFile: 0 };
  const wx = {
    calls,
    chooseMessageFile(options) {
      calls.choose.push(options);
      const selected = options.type === 'image' ? image : audio;
      if (chooseFail[options.type]) {
        options.fail?.({ errMsg: chooseFail[options.type] });
        return;
      }
      options.success?.({ tempFiles: selected ? [selected] : [] });
    },
    getFileSystemManager() {
      return {
        readFile({ filePath, success, fail }) {
          calls.reads.push(filePath);
          const data = bytes[filePath];
          if (data instanceof Error) { fail?.({ errMsg: data.message }); return; }
          success?.({ data });
        },
      };
    },
    request(options) {
      calls.requests.push(options);
      const isCos = options.method === 'PUT';
      if (isCos) {
        calls.puts.push(options);
        const route = routes.cos;
        try {
          const answer = responseFor(route || { statusCode: 200, data: '' }, options, options);
          if (answer?.statusCode >= 200 && answer.statusCode < 300) options.success?.(answer);
          else options.success?.(answer || { statusCode: 500, data: '' });
        } catch (error) { options.fail?.(error); }
        return;
      }
      const path = new URL(options.url).pathname;
      const route = routes[path.replace('/api/', '')];
      try {
        const answer = responseFor(route, options.data, options);
        options.success?.({ statusCode: answer?.httpStatus || 200, data: answer?.raw !== undefined ? answer.raw : answer });
      } catch (error) { options.fail?.(error); }
    },
    uploadFile() { calls.uploadFile += 1; },
  };
  return wx;
}

const image = { path: '/tmp/run.png', name: 'run.png', type: 'image/png', size: 4 };
const audio = { path: '/tmp/reading.m4a', name: 'reading.m4a', type: 'audio/mp4', size: 4 };
const basePrepare = () => ({
  ok: true,
  date: TODAY,
  already_today: false,
  submission_id: UUID,
  channel: UPLOAD_CHANNEL,
  image: { media_id: 'img_1', cos_key: 'uploads/image', cos_url: 'https://cos.test/image', authorization: 'sig-image', token: 'token-image' },
  audio: { media_id: 'soundrecording_1', cos_key: 'uploads/audio', cos_url: 'https://cos.test/audio', authorization: 'sig-audio', token: 'token-audio' },
});

// The native selectors are the public selection seam: one image and one
// extension-filtered ordinary file, with no application-owned staging page.
{
  const wx = makeWx({ image, audio: { ...audio, size: AUDIO_MAX_BYTES } });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  const selectedImage = await client.chooseImageFile();
  const selectedAudio = await client.chooseAudioFile();
  assert.equal(selectedImage.path, image.path);
  assert.equal(selectedAudio.size, AUDIO_MAX_BYTES);
  assert.deepEqual({ count: wx.calls.choose[0].count, type: wx.calls.choose[0].type }, { count: 1, type: 'image' });
  assert.deepEqual({ count: wx.calls.choose[1].count, type: wx.calls.choose[1].type, extension: wx.calls.choose[1].extension }, { count: 1, type: 'file', extension: ['mp3', 'm4a', 'wav', 'aac'] });
  const genericAudioWx = makeWx({ audio: { ...audio, type: 'file' } });
  const genericAudioClient = createCheckinClient(genericAudioWx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  assert.equal((await genericAudioClient.chooseAudioFile()).type, 'audio/mp4');
}

// A complete new submission uses prepare -> readFile -> two signed PUTs ->
// finalize, and never falls back to wx.uploadFile. verify 由页面登录负责，
// submit/uploadMaterials 不再重复调用。
{
  const wx = makeWx({
    image,
    audio,
    bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size) },
    routes: {
      verify: { ok: true, nickname: 'member01' },
      prepare: basePrepare(),
      finalize: { ok: true, status: 'new', date: TODAY, stats_updated: true, folder: 'day' },
    },
  });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  const result = await client.submit({
    nickname: 'member01', invite_code: 'test-code', reflection: '坚持', image, audio,
  });
  assert.equal(result.status, 'new');
  assert.deepEqual(wx.calls.requests.filter((r) => r.method !== 'PUT').map((r) => new URL(r.url).pathname), [
    '/api/prepare', '/api/finalize',
  ]);
  const prepareBody = wx.calls.requests.find((r) => new URL(r.url).pathname === '/api/prepare').data;
  const finalizeBody = wx.calls.requests.find((r) => new URL(r.url).pathname === '/api/finalize').data;
  assert.equal(prepareBody.channel, UPLOAD_CHANNEL);
  assert.equal(finalizeBody.channel, UPLOAD_CHANNEL);
  assert.deepEqual(finalizeBody.image, { media_id: 'img_1', cos_key: 'uploads/image', size: image.size });
  assert.deepEqual(finalizeBody.audio, { media_id: 'soundrecording_1', cos_key: 'uploads/audio', size: audio.size });
  assert.equal(wx.calls.puts.length, 2);
  assert.equal(wx.calls.uploadFile, 0);
  assert.deepEqual(wx.calls.reads, [image.path, audio.path]);
  const imagePut = wx.calls.puts.find((r) => r.url.endsWith('/image'));
  const audioPut = wx.calls.puts.find((r) => r.url.endsWith('/audio'));
  assert.deepEqual({ method: imagePut.method, type: imagePut.header['Content-Type'], length: imagePut.header['Content-Length'], auth: imagePut.header.Authorization, token: imagePut.header['x-cos-security-token'], bytes: imagePut.data.byteLength }, { method: 'PUT', type: 'image/png', length: String(image.size), auth: 'sig-image', token: 'token-image', bytes: image.size });
  assert.deepEqual({ method: audioPut.method, type: audioPut.header['Content-Type'], length: audioPut.header['Content-Length'], auth: audioPut.header.Authorization, token: audioPut.header['x-cos-security-token'], bytes: audioPut.data.byteLength }, { method: 'PUT', type: 'audio/mp4', length: String(audio.size), auth: 'sig-audio', token: 'token-audio', bytes: audio.size });
}

// A readFile byte mismatch aborts before either COS PUT or finalize.
{
  const wx = makeWx({
    image,
    audio,
    bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size - 1) },
    routes: { verify: { ok: true }, prepare: basePrepare(), finalize: { ok: true, status: 'new' } },
  });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  await assert.rejects(
    () => client.submit({ nickname: 'member01', invite_code: 'test-code', image, audio }),
    /读取字节数不一致/,
  );
  assert.equal(wx.calls.puts.length, 0);
  assert.equal(wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/finalize').length, 0);
}

// A lost finalize response saves the exact checkpoint. Retrying uses the same
// submission id, media receipts, channel, and no second prepare/PUT.
{
  let finalizeCalls = 0;
  const storage = makeStorage();
  const wx = makeWx({
    image,
    audio,
    bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size) },
    routes: {
      verify: { ok: true },
      prepare: basePrepare(),
      finalize: () => {
        finalizeCalls += 1;
        return finalizeCalls === 1 ? { fail: 'request:fail timeout' } : { ok: true, status: 'already', date: TODAY, stats_updated: true, folder: 'day' };
      },
    },
  });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage });
  await assert.rejects(
    () => client.submit({ nickname: 'member01', invite_code: 'test-code', reflection: '固定感悟', image, audio }),
    (error) => error.code === 'result_unknown',
  );
  const pending = client.getPending('member01');
  assert.equal(pending.submission_id, UUID);
  assert.equal(pending.channel, UPLOAD_CHANNEL);
  const before = { prepare: wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/prepare').length, puts: wx.calls.puts.length };
  const retry = await client.submit({ nickname: 'member01', invite_code: 'test-code' });
  assert.equal(retry.status, 'already');
  assert.equal(wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/prepare').length, before.prepare);
  assert.equal(wx.calls.puts.length, before.puts);
  assert.equal(client.getPending('member01'), null);
  const finalBodies = wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/finalize').map((r) => r.data);
  assert.equal(finalBodies[0].submission_id, finalBodies[1].submission_id);
  assert.deepEqual(finalBodies[0].image, finalBodies[1].image);
  assert.deepEqual(finalBodies[0].audio, finalBodies[1].audio);
  assert.equal(finalBodies[1].channel, UPLOAD_CHANNEL);
}

// A successful ima registration with stats_updated=false keeps the checkpoint so
// the next safe retry can repair KV through already without another PUT.
{
  let finalizeCalls = 0;
  const storage = makeStorage();
  const wx = makeWx({
    image,
    audio,
    bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size) },
    routes: {
      verify: { ok: true },
      prepare: basePrepare(),
      finalize: () => {
        finalizeCalls += 1;
        return finalizeCalls === 1
          ? { ok: true, status: 'new', date: TODAY, stats_updated: false, folder: 'day' }
          : { ok: true, status: 'already', date: TODAY, stats_updated: true, folder: 'day' };
      },
    },
  });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage });
  const first = await client.submit({ nickname: 'member01', invite_code: 'test-code', image, audio });
  assert.equal(first.stats_updated, false);
  assert.ok(client.getPending('member01'));
  const puts = wx.calls.puts.length;
  const prepares = wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/prepare').length;
  const repaired = await client.submit({ nickname: 'member01', invite_code: 'test-code' });
  assert.equal(repaired.status, 'already');
  assert.equal(wx.calls.puts.length, puts);
  assert.equal(wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/prepare').length, prepares);
  assert.equal(client.getPending('member01'), null);
}
// A user can decline the same-day confirmation before any file is read or
// uploaded; the selected materials remain available for a later attempt.
{
  const wx = makeWx({
    image,
    audio,
    bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size) },
    routes: { verify: { ok: true }, prepare: { ...basePrepare(), already_today: true } },
  });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  const result = await client.submit({
    nickname: 'member01', invite_code: 'test-code', image, audio,
    confirmDuplicateDay: async () => false,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(wx.calls.puts.length, 0);
  assert.equal(wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/finalize').length, 0);
}

// A confirmed duplicate-day response carries allow_duplicate_day on the same
// finalization; it does not prepare or upload twice.
{
  let finalBody;
  const wx = makeWx({
    image,
    audio,
    bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size) },
    routes: {
      verify: { ok: true },
      prepare: { ...basePrepare(), already_today: true },
      finalize: (_body, options) => {
        finalBody = options.data;
        return { ok: true, status: 'new', date: TODAY, stats_updated: true, folder: 'day' };
      },
    },
  });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  const result = await client.submit({
    nickname: 'member01', invite_code: 'test-code', image, audio,
    confirmDuplicateDay: async () => true,
  });
  assert.equal(result.status, 'new');
  assert.equal(finalBody.allow_duplicate_day, true);
  assert.equal(wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/prepare').length, 1);
  assert.equal(wx.calls.puts.length, 2);
}
// A3 回归：prepare 已报 already_today 且用户确认过一次后，若 finalize 仍返回
// duplicate_day，应直接抛错——不再二次弹窗，也不重发 finalize。
{
  let confirmCalls = 0;
  const wx = makeWx({
    image,
    audio,
    bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size) },
    routes: {
      verify: { ok: true },
      prepare: { ...basePrepare(), already_today: true },
      finalize: { ok: false, status: 'duplicate_day', error: '你今天已经打过卡了' },
    },
  });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  await assert.rejects(
    () => client.submit({
      nickname: 'member01', invite_code: 'test-code', image, audio,
      confirmDuplicateDay: async () => { confirmCalls += 1; return true; },
    }),
    (error) => error.status === 'duplicate_day',
  );
  assert.equal(confirmCalls, 1);
  assert.equal(wx.calls.requests.filter((r) => new URL(r.url).pathname === '/api/finalize').length, 1);
}
// Native cancellation has a stable, actionable error and no API call.
{
  const wx = makeWx({ chooseFail: { image: 'chooseMessageFile:fail cancel' } });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  await assert.rejects(() => client.chooseImageFile(), (error) => error.code === 'cancelled');
}

// Unsupported extensions are rejected in the native selection callback before
// any API call can be made.
{
  const wx = makeWx({ audio: { path: '/tmp/reading.ogg', name: 'reading.ogg', type: 'audio/ogg', size: 4 } });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  await assert.rejects(() => client.chooseAudioFile(), (error) => error.code === 'unsupported_type');
  assert.equal(wx.calls.requests.length, 0);
}
// finalize 收到 4xx 非 JSON（如 404 HTML）时是明确的客户端错误，判定为可抛出的
// invalid_response，而不是「结果未知」重交引导。
{
  const wx = makeWx({
    image,
    audio,
    bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size) },
    routes: {
      verify: { ok: true },
      prepare: basePrepare(),
      finalize: { httpStatus: 404, raw: '<html>404 not found</html>' },
    },
  });
  const client = createCheckinClient(wx, { apiBaseUrl: 'https://api.test', now: () => NOW, storage: makeStorage() });
  await assert.rejects(
    () => client.submit({ nickname: 'member01', invite_code: 'test-code', image, audio }),
    (error) => error.code === 'invalid_response' && error.status === 404,
  );
}
// Drive the real page callbacks: completing the second selector starts PUTs,
// but does not finalize until the member explicitly submits their reflection.
{
  const wx = makeWx({ image, audio, bytes: { [image.path]: new ArrayBuffer(image.size), [audio.path]: new ArrayBuffer(audio.size) }, routes: { verify: { ok:true }, prepare: basePrepare(), finalize: { ok:true, status:'new', stats_updated:true } } });
  const client = createCheckinClient(wx, { apiBaseUrl:'https://api.test', now:()=>NOW, storage:makeStorage() });
  let definition;
  global.Page = value => { definition=value; };
  try { require('../miniprogram/pages/checkin/checkin.js'); } finally { delete global.Page; }
  const page={ ...definition, data:{...definition.data, loggedIn:true, nickname:'member01', inviteCode:'test-code'}, client, setData(update){Object.assign(this.data,update);} };
  await page.chooseImage();
  assert.equal(wx.calls.requests.length,0);
  await page.chooseAudio();
  assert.equal(wx.calls.puts.length,2);
  assert.equal(page.data.uploaded,true);
  assert.equal(page.data.pending,false);
  assert.equal(page.data.busy,false);
  assert.equal(wx.calls.requests.filter(r=>new URL(r.url).pathname==='/api/finalize').length,0);
  page.onReflectionInput({ detail:{value:'上传后填写的感悟'} });
  await page.submit();
  const final=wx.calls.requests.find(r=>new URL(r.url).pathname==='/api/finalize');
  assert.equal(final.data.reflection,'上传后填写的感悟');
  assert.equal(wx.calls.puts.length,2);
  assert.equal(wx.calls.requests.filter(r=>new URL(r.url).pathname==='/api/prepare').length,1);
  assert.equal(page.data.uploaded,false);
}
// Uploaded-only checkpoints survive reload; unknown outcomes freeze reflection.
{
  let attempts=0;
  const storage=makeStorage();
  const wx=makeWx({image,audio,bytes:{[image.path]:new ArrayBuffer(4),[audio.path]:new ArrayBuffer(4)},routes:{verify:{ok:true},prepare:basePrepare(),finalize:()=>{if(++attempts===1)return {fail:'request:fail timeout'}; return {ok:true,status:'already',stats_updated:true};}}});
  let client=createCheckinClient(wx,{storage,now:()=>NOW});
  await client.uploadMaterials({nickname:'member01',invite_code:'test-code',image,audio});
  client=createCheckinClient(wx,{storage,now:()=>NOW});
  await assert.rejects(()=>client.submit({nickname:'member01',invite_code:'test-code',reflection:'固定感悟'}),error=>error.code==='result_unknown');
  const result=await client.submit({nickname:'member01',invite_code:'test-code',reflection:'不能覆盖'});
  assert.equal(result.status,'already');
  const finals=wx.calls.requests.filter(r=>new URL(r.url).pathname==='/api/finalize');
  assert.equal(finals[1].data.reflection,'固定感悟');
  assert.equal(wx.calls.puts.length,2);
}
console.log('✓ 微信小程序原生选择、安全提交、结果未知重交与错误闸门通过');

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
