import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { collectOpencodeModelUsage } from '../lib/opencode-model-usage.mjs';

const zstdAvailable = typeof zlib.zstdCompressSync === 'function';

async function fakeHome(t) {
  const base = await fs.realpath(os.tmpdir());
  const home = await fs.mkdtemp(path.join(base, 'quota-go-model-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(home)), base);
    await fs.rm(home, { recursive: true, force: true });
  });
  return home;
}

function messageId(number) {
  return '10000000-0000-4000-8000-' + number.toString(16).padStart(12, '0');
}

function message({
  id, provider = 'opencode-go', model = 'model-alpha', tokens = 20, kind = 'model'
}) {
  return JSON.stringify({
    type: 'assistant/message',
    time: 1795290000000,
    data: {
      message: { id: messageId(id), source: { kind, provider, model, replayState: null }, text: '合成消息' },
      usage: { totalTokens: tokens }
    }
  }) + '\n';
}

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text));
}

async function writeJournal(home, session, bytes, filename = 'session.v4.jsonl.zstd') {
  const dir = path.join(home, '.dsh', 'sessions', session);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, filename);
  await fs.writeFile(file, bytes);
  return file;
}

test('Go 模型用量跨帧读取分段 JSONL，按精确来源聚合、跨版本去重', { skip: !zstdAvailable }, async (t) => {
  const home = await fakeHome(t);
  const first = Buffer.from(message({ id: 10, tokens: 20 }));
  const split = first.indexOf(Buffer.from('合')) + 1;
  await writeJournal(home, 'original', Buffer.concat([
    frame(first.subarray(0, split)),
    frame(first.subarray(split)),
    frame(
      message({ id: 11, model: 'provider/model-beta:preview', tokens: 40 }) +
      message({ id: 12, provider: 'opencode-go-personal', tokens: 30 }) +
      message({ id: 13, model: 'unknown', tokens: 7 }) +
      message({ id: 14, provider: ' opencode-go', tokens: 900 }) +
      message({ id: 15, provider: 'deepseek-account', tokens: 800 }) +
      message({ id: 16, tokens: -5 }) +
      message({ id: 17, tokens: '5' }) +
      message({ id: 18, tokens: Number.MAX_SAFE_INTEGER + 1 }) +
      message({ id: 19, kind: 'manual', tokens: 600 })
    )
  ]));
  await writeJournal(home, path.join('nested', 'fork'), frame(
    message({ id: 10, tokens: 20 }).replace(messageId(10), messageId(10).toUpperCase()) +
    message({ id: 20, tokens: 10 })
  ), 'session.v3.jsonl.zstd');
  await writeJournal(home, 'ignored', frame(message({ id: 21, tokens: 700 })), 'events.jsonl.zstd');

  assert.deepEqual(await collectOpencodeModelUsage({ home }), {
    status: 'ok',
    partial: false,
    providers: [
      {
        provider: 'opencode-go',
        totalTokens: 77,
        unknownTokens: 7,
        models: [
          { name: 'provider/model-beta:preview', tokens: 40, requests: 1 },
          { name: 'model-alpha', tokens: 30, requests: 2 }
        ]
      },
      {
        provider: 'opencode-go-personal',
        totalTokens: 30,
        unknownTokens: 0,
        models: [{ name: 'model-alpha', tokens: 30, requests: 1 }]
      }
    ]
  });
});

test('Go 模型用量保留早期有效帧，跳过坏行和消息 ID 冲突', { skip: !zstdAvailable }, async (t) => {
  const home = await fakeHome(t);
  await writeJournal(home, 'original', Buffer.concat([
    frame(
      message({ id: 1, tokens: 15 }) +
      '{"broken"\n' +
      message({ id: 2, model: '', tokens: 25 }) +
      message({ id: 3, tokens: 400 })
    ),
    frame(message({ id: 4, tokens: 900 })).subarray(0, 14)
  ]));
  await writeJournal(home, 'fork', frame(
    message({ id: 2, model: 'known/model', tokens: 25 }) +
    message({ id: 3, provider: 'opencode-go-two', tokens: 400 })
  ));

  assert.deepEqual(await collectOpencodeModelUsage({ home }), {
    status: 'ok',
    partial: true,
    providers: [{
      provider: 'opencode-go',
      totalTokens: 40,
      unknownTokens: 0,
      models: [
        { name: 'known/model', tokens: 25, requests: 1 },
        { name: 'model-alpha', tokens: 15, requests: 1 }
      ]
    }]
  });
});

test('Go 模型用量缓存能察觉追加、替换和删除', { skip: !zstdAvailable }, async (t) => {
  const home = await fakeHome(t);
  const file = await writeJournal(home, 'changing', frame(message({ id: 1, tokens: 15 })));
  const total = async () => (await collectOpencodeModelUsage({ home })).providers[0]?.totalTokens;
  assert.equal(await total(), 15);
  assert.equal(await total(), 15);

  await fs.appendFile(file, frame(message({ id: 2, tokens: 30 })));
  assert.equal(await total(), 45);
  await writeJournal(home, 'changing', frame(message({ id: 3, tokens: 61 })));
  assert.equal(await total(), 61);
  await fs.unlink(file);
  assert.deepEqual(await collectOpencodeModelUsage({ home }), { status: 'unavailable', partial: false, providers: [] });
});

test('Go 模型用量忽略指向外部合成目录的链接', { skip: !zstdAvailable }, async (t) => {
  const home = await fakeHome(t);
  const target = await fakeHome(t);
  const file = await writeJournal(target, 'external', frame(message({ id: 1 })));
  const sessions = path.join(home, '.dsh', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  await fs.symlink(path.dirname(file), path.join(sessions, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await collectOpencodeModelUsage({ home }), { status: 'unavailable', partial: false, providers: [] });
});

test('未配置日志返回可降级状态', async (t) => {
  const home = await fakeHome(t);
  assert.deepEqual(await collectOpencodeModelUsage({ home }), {
    status: zstdAvailable ? 'unavailable' : 'unsupported',
    partial: false,
    providers: []
  });
});

test('缺少原生 ZSTD 解码时可降级', async (t) => {
  const home = await fakeHome(t);
  if (typeof zlib.zstdDecompressSync === 'function') {
    t.mock.method(zlib, 'zstdDecompressSync', () => {});
    zlib.zstdDecompressSync = undefined;
  }
  assert.deepEqual(await collectOpencodeModelUsage({ home }), {
    status: 'unsupported',
    partial: false,
    providers: []
  });
});
