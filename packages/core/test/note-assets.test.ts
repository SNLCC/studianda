import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { readImageDimensions, Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-note-assets-'));
const token = 'test-token';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** 用 canvas 生成真实可解码的图片（saveNoteAsset 现在会完整解码校验）。 */
async function canvasBytes(
  format: 'png' | 'jpeg' | 'webp',
  color: string
): Promise<Buffer> {
  const canvas = createCanvas(3, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 3, 2);
  if (format === 'png') return Buffer.from(await canvas.encode('png'));
  if (format === 'jpeg') return Buffer.from(await canvas.encode('jpeg'));
  return Buffer.from(await canvas.encode('webp'));
}

const PNG_BYTES = await canvasBytes('png', '#123456');
const JPEG_BYTES = await canvasBytes('jpeg', '#654321');
const WEBP_BYTES = await canvasBytes('webp', '#abcdef');
// 1x1 透明 GIF（GIF89a），再改头成 GIF87a。
const GIF_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);
const GIF87_BYTES = Buffer.concat([Buffer.from('GIF87a'), GIF_BYTES.subarray(6)]);

describe('Store.saveNoteAsset', () => {
  it('PNG data URL 落盘到 note-assets/<sha>.png 并返回 studianda-asset 地址', async () => {
    const store = storeAt('asset-png');
    try {
      const record = await store.saveNoteAsset({ dataUrl: dataUrl('image/png', PNG_BYTES) });
      expect(record.id).toMatch(/^[0-9a-f]{64}$/);
      expect(record.url).toBe(`studianda-asset://note-assets/${record.id}.png`);
      expect(record.mime).toBe('image/png');
      expect(record.sizeBytes).toBe(PNG_BYTES.length);
      // 未给文件名时用默认展示名。
      expect(record.filename).toBe('图片.png');

      const file = path.join(store.dataDir, 'note-assets', `${record.id}.png`);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file)).toEqual(PNG_BYTES);
    } finally {
      store.close();
    }
  });

  it('按 sha256 去重：同内容重复上传返回同一记录且不重写文件', async () => {
    const store = storeAt('asset-dedupe');
    try {
      const first = await store.saveNoteAsset({
        dataUrl: dataUrl('image/png', PNG_BYTES),
        filename: '第一次.png'
      });
      const second = await store.saveNoteAsset({
        dataUrl: dataUrl('image/png', PNG_BYTES),
        filename: '第二次.png'
      });
      expect(second.id).toBe(first.id);
      expect(second.url).toBe(first.url);
      expect(second.sizeBytes).toBe(first.sizeBytes);
      // 展示名跟随本次上传，但资源文件只有一份。
      expect(second.filename).toBe('第二次.png');
      const files = readdirSync(path.join(store.dataDir, 'note-assets'));
      expect(files).toEqual([`${first.id}.png`]);
    } finally {
      store.close();
    }
  });

  it('按 MIME 选择扩展名（jpeg→jpg / gif / webp）', async () => {
    const store = storeAt('asset-ext');
    try {
      const cases: Array<[string, Buffer, string]> = [
        ['image/jpeg', JPEG_BYTES, 'jpg'],
        ['image/gif', GIF_BYTES, 'gif'],
        ['image/webp', WEBP_BYTES, 'webp']
      ];
      for (const [mime, bytes, ext] of cases) {
        const record = await store.saveNoteAsset({ dataUrl: dataUrl(mime, bytes) });
        expect(record.mime).toBe(mime);
        expect(record.url).toBe(`studianda-asset://note-assets/${record.id}.${ext}`);
        expect(existsSync(path.join(store.dataDir, 'note-assets', `${record.id}.${ext}`))).toBe(
          true
        );
      }
      // MIME 大小写不敏感。
      const upper = await store.saveNoteAsset({
        dataUrl: dataUrl('IMAGE/PNG', PNG_BYTES)
      });
      expect(upper.mime).toBe('image/png');
    } finally {
      store.close();
    }
  });

  it('展示文件名去掉路径与控制字符，空值回退默认名', async () => {
    const store = storeAt('asset-filename');
    try {
      const traversal = await store.saveNoteAsset({
        dataUrl: dataUrl('image/png', PNG_BYTES),
        filename: '../../evil\u0000问.png'
      });
      expect(traversal.filename).toBe('evil问.png');

      const windowsPath = await store.saveNoteAsset({
        dataUrl: dataUrl('image/jpeg', JPEG_BYTES),
        filename: 'C:\\Users\\me\\图片 1.jpg'
      });
      expect(windowsPath.filename).toBe('图片 1.jpg');

      const blank = await store.saveNoteAsset({
        dataUrl: dataUrl('image/gif', GIF_BYTES),
        filename: '   '
      });
      expect(blank.filename).toBe('图片.gif');

      const dot = await store.saveNoteAsset({
        dataUrl: dataUrl('image/webp', WEBP_BYTES),
        filename: '..'
      });
      expect(dot.filename).toBe('图片.webp');
    } finally {
      store.close();
    }
  });

  it('拒绝非 png/jpeg/gif/webp、坏 base64 与空内容', async () => {
    const store = storeAt('asset-invalid');
    try {
      await expect(
        store.saveNoteAsset({
          dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`
        })
      ).rejects.toThrow('只支持 png/jpeg/gif/webp');
      await expect(
        store.saveNoteAsset({ dataUrl: 'data:text/plain;base64,aGVsbG8=' })
      ).rejects.toThrow('只支持 png/jpeg/gif/webp');
      await expect(store.saveNoteAsset({ dataUrl: '不是 data url' })).rejects.toThrow(
        '只支持 png/jpeg/gif/webp'
      );
      await expect(
        store.saveNoteAsset({ dataUrl: 'data:image/png;base64,!!!!' })
      ).rejects.toThrow('图片数据不是有效的 base64');
      await expect(
        store.saveNoteAsset({ dataUrl: 'data:image/png;base64,' })
      ).rejects.toThrow('图片数据不是有效的 base64');
    } finally {
      store.close();
    }
  });

  it('解码后超过 2MB 拒绝，恰好 2MB 且可解码时接受', async () => {
    const store = storeAt('asset-size');
    try {
      const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 7);
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', tooLarge) })
      ).rejects.toThrow('图片不能超过 2MB');

      // 真实 PNG + 尾部填充到恰好 2MB：解码器忽略 IEND 之后的字节。
      const exactly = Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024 - PNG_BYTES.length)]);
      expect(exactly.length).toBe(2 * 1024 * 1024);
      const record = await store.saveNoteAsset({ dataUrl: dataUrl('image/png', exactly) });
      expect(record.sizeBytes).toBe(2 * 1024 * 1024);
      expect(readFileSync(path.join(store.dataDir, 'note-assets', `${record.id}.png`)).length).toBe(
        2 * 1024 * 1024
      );
    } finally {
      store.close();
    }
  });

  it('magic bytes + 完整解码校验：伪装、MIME 错配、截断与超大尺寸都拒绝', async () => {
    const store = storeAt('asset-magic');
    try {
      // 声明 png 但内容是 jpeg → 类型不符。
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', JPEG_BYTES) })
      ).rejects.toThrow('图片内容与声明类型不符');
      // 声明 jpeg 但内容是 png → 同样拒绝。
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/jpeg', PNG_BYTES) })
      ).rejects.toThrow('图片内容与声明类型不符');
      // 声明 png 但根本不是图片。
      await expect(
        store.saveNoteAsset({
          dataUrl: dataUrl('image/png', Buffer.from('plain text pretending to be a png'))
        })
      ).rejects.toThrow('图片内容不是有效的 png/jpeg/gif/webp 图片');
      // 声明 webp 但只有 RIFF 没有 WEBP 标记。
      await expect(
        store.saveNoteAsset({
          dataUrl: dataUrl('image/webp', Buffer.from('RIFF0000NOPE'))
        })
      ).rejects.toThrow('图片内容不是有效的 png/jpeg/gif/webp 图片');
      // 截断 PNG：magic 对但解码失败。
      await expect(
        store.saveNoteAsset({
          dataUrl: dataUrl('image/png', PNG_BYTES.subarray(0, Math.floor(PNG_BYTES.length / 2)))
        })
      ).rejects.toThrow('图片无法解码或尺寸无效');
      // PNG 头 + 垃圾数据。
      await expect(
        store.saveNoteAsset({
          dataUrl: dataUrl(
            'image/png',
            Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.alloc(64, 1)])
          )
        })
      ).rejects.toThrow('图片无法解码或尺寸无效');
      // 宽度超过 20000 的合法 PNG：文件头解析阶段就被拒绝（不进入完整解码）。
      const hugeCanvas = createCanvas(20001, 1);
      const hugePng = Buffer.from(await hugeCanvas.encode('png'));
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', hugePng) })
      ).rejects.toThrow('图片尺寸过大或无法识别');

      // GIF87a 也合法。
      const gif87a = await store.saveNoteAsset({
        dataUrl: dataUrl('image/gif', GIF87_BYTES)
      });
      expect(gif87a.url.endsWith('.gif')).toBe(true);
      // 失败用例都没有落盘，目录里只有 gif87a 一份。
      expect(readdirSync(path.join(store.dataDir, 'note-assets'))).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('readImageDimensions 从文件头解析尺寸；伪造超大 PNG 头在解码前被拒绝', async () => {
    // 正常图片：canvas 生成的 png/jpeg/webp 都是 3x2，GIF 是 1x1。
    expect(readImageDimensions(PNG_BYTES)).toEqual({ width: 3, height: 2 });
    expect(readImageDimensions(JPEG_BYTES)).toEqual({ width: 3, height: 2 });
    expect(readImageDimensions(WEBP_BYTES)).toEqual({ width: 3, height: 2 });
    expect(readImageDimensions(GIF_BYTES)).toEqual({ width: 1, height: 1 });
    expect(readImageDimensions(Buffer.from('plain text'))).toBeNull();

    /** 只构造合法 PNG 签名 + IHDR 头，不是完整可解码图片。 */
    const forgedPng = (width: number, height: number): Buffer => {
      const buffer = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
      buffer.writeUInt32BE(13, 8);
      buffer.write('IHDR', 12, 'latin1');
      buffer.writeUInt32BE(width, 16);
      buffer.writeUInt32BE(height, 20);
      return buffer;
    };
    expect(readImageDimensions(forgedPng(50000, 50000))).toEqual({ width: 50000, height: 50000 });
    // 单边超限。
    expect(readImageDimensions(forgedPng(20001, 1))).toEqual({ width: 20001, height: 1 });
    // 总像素超限：6000*5000 = 30,000,000 > 25,000,000（单边都 ≤20000）。
    expect(readImageDimensions(forgedPng(6000, 5000))).toEqual({ width: 6000, height: 5000 });

    const store = storeAt('asset-bomb');
    try {
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', forgedPng(50000, 50000)) })
      ).rejects.toThrow('图片尺寸过大或无法识别');
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', forgedPng(6000, 5000)) })
      ).rejects.toThrow('图片尺寸过大或无法识别');
      // 拒绝发生在 loadImage 之前：目录里没有任何文件被写入（目录可能都还没创建）。
      const assetDir = path.join(store.dataDir, 'note-assets');
      expect(existsSync(assetDir) ? readdirSync(assetDir) : []).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('图片上限来自 settings：默认 2MB/8MP，改大 MB、改小像素立即生效，非法设置回退默认', async () => {
    const store = storeAt('asset-limits');
    try {
      expect(store.getNoteImageLimits()).toEqual({
        maxBytes: 2 * 1024 * 1024,
        maxPixels: 8_000_000
      });

      // 3MB 图片默认被拒（文案带当前上限）。
      const threeMb = Buffer.concat([PNG_BYTES, Buffer.alloc(3 * 1024 * 1024 - PNG_BYTES.length)]);
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', threeMb) })
      ).rejects.toThrow('图片不能超过 2MB');

      // 上限改到 5MB 后立即生效。
      store.updateSettings({ 'note_image.max_mb': '5' });
      expect(store.getNoteImageLimits()).toMatchObject({ maxBytes: 5 * 1024 * 1024 });
      const saved = await store.saveNoteAsset({ dataUrl: dataUrl('image/png', threeMb) });
      expect(saved.sizeBytes).toBe(3 * 1024 * 1024);

      // 2,000,000 像素的图片在默认 8MP 下通过；把 max_pixels 改到 1MP 后被拒（即使文件已存在）。
      const bigCanvas = createCanvas(1600, 1250);
      bigCanvas.getContext('2d').fillRect(0, 0, 1600, 1250);
      const twoMpPng = Buffer.from(await bigCanvas.encode('png'));
      expect(store.getNoteImageLimits().maxPixels).toBe(8_000_000);
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', twoMpPng) })
      ).resolves.toMatchObject({ mime: 'image/png' });

      store.updateSettings({ 'note_image.max_pixels': '1000000' });
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', twoMpPng) })
      ).rejects.toThrow('总像素最多 1000000');
      // 正常小图（3×2）在 1MP 上限下仍可通过。
      await expect(
        store.saveNoteAsset({ dataUrl: dataUrl('image/png', PNG_BYTES) })
      ).resolves.toMatchObject({ mime: 'image/png' });

      // 非法/越界/缺失值回退默认。
      store.updateSettings({
        'note_image.max_mb': 'abc',
        'note_image.max_pixels': '999999999'
      });
      expect(store.getNoteImageLimits()).toEqual({
        maxBytes: 2 * 1024 * 1024,
        maxPixels: 8_000_000
      });
      store.updateSettings({ 'note_image.max_mb': '0', 'note_image.max_pixels': '-5' });
      expect(store.getNoteImageLimits()).toEqual({
        maxBytes: 2 * 1024 * 1024,
        maxPixels: 8_000_000
      });
      store.deleteSettings(['note_image.max_mb', 'note_image.max_pixels']);
      expect(store.getNoteImageLimits()).toEqual({
        maxBytes: 2 * 1024 * 1024,
        maxPixels: 8_000_000
      });
    } finally {
      store.close();
    }
  });
});

describe('POST /api/v1/note-assets', () => {
  const dataDir = path.join(root, 'asset-http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('200 返回 NoteAssetRecord', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets',
      headers: headers(),
      payload: { dataUrl: dataUrl('image/png', PNG_BYTES), filename: '粘贴.png' }
    });
    expect(response.statusCode).toBe(200);
    const record = response.json() as {
      id: string;
      url: string;
      filename: string;
      mime: string;
      sizeBytes: number;
    };
    expect(record.id).toMatch(/^[0-9a-f]{64}$/);
    expect(record.url).toBe(`studianda-asset://note-assets/${record.id}.png`);
    expect(record.filename).toBe('粘贴.png');
    expect(record.mime).toBe('image/png');
    expect(record.sizeBytes).toBe(PNG_BYTES.length);
  });

  it('非法参数/非法图片返回 400 中文错误，>2MB 与不可解码也是 400', async () => {
    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets',
      headers: headers(),
      payload: {}
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { message: string }).message).toContain('dataUrl');

    const badType = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets',
      headers: headers(),
      payload: { dataUrl: 123 }
    });
    expect(badType.statusCode).toBe(400);

    const badMime = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets',
      headers: headers(),
      payload: { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }
    });
    expect(badMime.statusCode).toBe(400);
    expect((badMime.json() as { message: string }).message).toContain('只支持');

    const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 3);
    const large = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets',
      headers: headers(),
      payload: { dataUrl: dataUrl('image/png', tooLarge) }
    });
    expect(large.statusCode).toBe(400);
    expect((large.json() as { message: string }).message).toContain('2MB');

    const truncated = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets',
      headers: headers(),
      payload: {
        dataUrl: dataUrl('image/png', PNG_BYTES.subarray(0, Math.floor(PNG_BYTES.length / 2)))
      }
    });
    expect(truncated.statusCode).toBe(400);
    expect((truncated.json() as { message: string }).message).toContain('无法解码');
  });

  it('设置放宽到 5MB 后 3MB 图片可上传（路由 bodyLimit 足以容纳变大的上限）', async () => {
    store.updateSettings({ 'note_image.max_mb': '5' });
    const threeMb = Buffer.concat([PNG_BYTES, Buffer.alloc(3 * 1024 * 1024 - PNG_BYTES.length)]);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets',
      headers: headers(),
      payload: { dataUrl: dataUrl('image/png', threeMb), filename: '大图.png' }
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { sizeBytes: number }).sizeBytes).toBe(3 * 1024 * 1024);
  });
});

describe('GET /api/v1/note-assets/:file', () => {
  const dataDir = path.join(root, 'asset-get');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('按文件名返回图片字节与 content-type', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets',
      headers: headers(),
      payload: { dataUrl: dataUrl('image/png', PNG_BYTES) }
    });
    expect(created.statusCode).toBe(200);
    const record = created.json() as { id: string };

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/note-assets/${record.id}.png`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('image/png');
    expect(response.rawPayload).toEqual(PNG_BYTES);
  });

  it('拒绝路径穿越、分隔符与不存在的文件', async () => {
    for (const url of [
      '/api/v1/note-assets/..%2F..%2Fsecret',
      '/api/v1/note-assets/%2E%2E%5Csecret',
      '/api/v1/note-assets/missing.png'
    ]) {
      const response = await server.inject({ method: 'GET', url, headers: headers() });
      expect(response.statusCode).toBe(404);
    }
  });
});
