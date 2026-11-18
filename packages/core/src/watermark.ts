/**
 * 图像产物的 AI 标识：可见水印（烧录）+ PNG 元数据（隐式标识）。
 *
 * 现状：应用目前没有"AI 生成图片"的产物（视觉读页的渲染 PNG 只进模型上下文、不落盘），
 * 所以这里先把**标准化水印**做出来，等出现"导出译文版式页 / AI 标注图 / 生成图"时直接调用，
 * 不用临到上线再改文案、位置与元数据格式。
 *
 * 三条约束（与 docs/USAGE-NOTICE.md 的标识口径一致）：
 * 1. **本机 OCR 烧来源水印、但不标 AI**：Tesseract 与 PDF 文本层不是生成式 AI，`local_ocr`
 *    也烧水印（文案说明"OCR · 本机 · 请核对原图"），PNG 元数据写 `Source` 而不是 `AIGC`；
 *    只有 AI 类（generated / translation / vision）才写 `AIGC`；
 * 2. **fail-closed**：水印或元数据写不进去就抛错，调用方不许把未标识的图当成功产物落盘；
 * 3. **可见 + 隐式双标识**：右下角可见水印（裁掉会伤图），PNG `tEXt` 写来源/生成标记与 `Software`。
 *
 * 字体：**不依赖也不分发任何专有字体**。调用方可以传 `fontPath` 指定随包的开源字体
 * （建议用 OFL 的 Noto Sans CJK SC 水印子集）；不传就用平台默认无衬线字体做即时渲染——
 * 字体装在用户自己的系统上，本模块不复制、不嵌入、不再分发字体文件。中文字形不可用时
 * 自动退回 ASCII 文案，保证水印一定画得出来而不是画成一排方框。
 */
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  imageWatermarkAsciiText,
  imageWatermarkMetadata,
  imageWatermarkText,
  type ImageWatermarkKind
} from '@studianda/shared';

export class WatermarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatermarkError';
  }
}

export interface BurnWatermarkOptions {
  /** 标识类型；`local_ocr` 烧"本机 OCR"来源水印（不写 `AIGC`），其余写 AI 标识。 */
  kind: ImageWatermarkKind;
  /**
   * 可选：随包的开源字体（OFL/Apache，可商用）路径；只用于本次渲染，不复制、不再分发。
   * 不给则用平台默认字体渲染，中文不可用时自动退回 ASCII 文案。
   */
  fontPath?: string;
  /** 字体族名；给了 `fontPath` 时按注册后的 family 用。 */
  fontFamily?: string;
  /** 水印字号相对图片宽度的比例，默认 0.016，下限 12px。 */
  fontScale?: number;
  /** 底色带透明度，默认 0.55。 */
  scrimOpacity?: number;
}

export interface BurnWatermarkResult {
  /** 输出 PNG 字节（已烧录可见水印并写入元数据；四种 kind 都改写）。 */
  bytes: Uint8Array;
  /** 实际烧录的文案（中文；字形不可用时是 ASCII 兜底文案）。 */
  text: string;
  /** 是否真的改写了图片（四种 kind 均为 true）。 */
  changed: boolean;
  /** 是否退回了 ASCII 文案（诊断用）。 */
  asciiFallback: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC32（PNG 规范用的多项式），只在本模块内部用。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/**
 * 在 IHDR 之后插入一个 `tEXt` 块（PNG 规范：tEXt 必须出现在 IDAT 之前）。
 *
 * 这是"隐式标识"：即使图片被裁剪、可见水印被抹掉，元数据里仍留着来源/生成标记与工具。
 * AI 类写 `AIGC`，本机 OCR 写 `Source`（见 `imageWatermarkMetadata`）。
 * 插不进去（不是合法 PNG、找不到 IHDR）就抛错，由调用方决定是否终止落盘。
 */
export function insertPngTextChunk(
  png: Uint8Array,
  keyword: string,
  value: string
): Uint8Array {
  if (!isPng(png)) throw new WatermarkError('not a PNG image');
  if (png.length < 33) throw new WatermarkError('truncated PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ihdrLength = view.getUint32(8);
  const ihdrType = String.fromCharCode(png[12]!, png[13]!, png[14]!, png[15]!);
  if (ihdrType !== 'IHDR') throw new WatermarkError('PNG without IHDR');
  const insertAt = 8 + 12 + ihdrLength;
  if (insertAt > png.length) throw new WatermarkError('truncated PNG');

  const key = new TextEncoder().encode(keyword);
  const body = new TextEncoder().encode(value);
  const type = new TextEncoder().encode('tEXt');
  const data = new Uint8Array(key.length + 1 + body.length);
  data.set(key, 0);
  data[key.length] = 0;
  data.set(body, key.length + 1);

  const chunk = new Uint8Array(12 + data.length);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(type, 0);
  crcInput.set(data, 4);
  chunkView.setUint32(8 + data.length, crc32(crcInput));

  const output = new Uint8Array(png.length + chunk.length);
  output.set(png.subarray(0, insertAt), 0);
  output.set(chunk, insertAt);
  output.set(png.subarray(insertAt), insertAt + chunk.length);
  return output;
}

/**
 * 字形可用性探针：拿**实际要画的文案里的汉字逐个**与私用区字符各画一遍，逐像素比较。
 *
 * 两个坑：
 * 1. 不能用 `measureText`：CJK 字体的缺字框（notdef）本身就是全角，宽度和真字形一样，
 *    会把「一排方框」误判成「有中文字形」；
 * 2. 不能用固定的「中」字探测：水印字体子集只收水印用到的字形，「中」很可能不在子集里。
 *
 * 必须逐个汉字检查而不是只抽前两个：Skia 对缺字有时会按字形回退到系统字体（拉丁字母常见），
 * 但对 CJK 缺字不一定回退，只抽两个会把"部分字是方框"的文案误判成可用。
 */
function cjkGlyphsAvailable(family: string, label: string): boolean {
  const draw = (char: string): Uint8Array => {
    const canvas = createCanvas(32, 32);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 32, 32);
    context.fillStyle = '#000000';
    context.font = `24px ${family}`;
    context.textBaseline = 'middle';
    context.fillText(char, 2, 16);
    return new Uint8Array(context.getImageData(0, 0, 32, 32).data);
  };
  const sample = [...new Set([...label].filter((char) => /[\u3400-\u9fff]/.test(char)))];
  if (sample.length === 0) return false;
  const notdef = draw('\uE000');
  const rendered = (char: string): boolean => {
    const glyph = draw(char);
    if (glyph.length !== notdef.length) return true;
    for (let index = 0; index < glyph.length; index += 1) {
      if (glyph[index] !== notdef[index]) return true;
    }
    return false;
  };
  return sample.every(rendered);
}

const WATERMARK_FAMILY = 'StudiandaWatermark';
let resolvedFamily: string | null | undefined;

/**
 * 随包水印字体（**就是项目已经集成的 Noto Sans CJK SC**，只切了水印用到的字形，约 9 KB）。
 *
 * 界面上它是 woff2（CSS @font-face 用），canvas 读不了 woff2，所以同一款字体另出一份 TTF 子集，
 * 由 `scripts/build-fonts.py` 从同一个源文件生成、登记在同一款字体的许可条目下——
 * 不引入新字体，也不新增许可义务。找不到就退回平台默认字体（再不行退回 ASCII 文案）。
 */
function bundledWatermarkFont(): string | undefined {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  // Core 是独立子进程（ELECTRON_RUN_AS_NODE）：开发态 bundle 在 packages/core/dist，
  // 安装后 bundle 在 <resources>/app.asar/out/core/dist。安装包里的字体不进 asar，
  // 所以 resources 那条候选必须排在"同包 assets"之前（后者在 asar 内，canvas 原生读不了）。
  const coreDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.STUDIANDA_WATERMARK_FONT,
    path.join(process.cwd(), 'packages', 'core', 'assets', 'fonts', 'StudiandaWatermark.ttf'),
    path.join(process.cwd(), 'assets', 'fonts', 'StudiandaWatermark.ttf'),
    // 安装后：dist 向上四级即 <resources>，与 electron-builder.yml 的 extraResources
    // 落点一致（不依赖 process.resourcesPath）；开发态该路径不存在，会继续往下找。
    path.resolve(coreDir, '..', '..', '..', '..', 'assets', 'fonts', 'StudiandaWatermark.ttf'),
    // 开发态（pnpm dev / dev:core / vitest）：dist（或 src）与 assets 同属 packages/core。
    path.resolve(coreDir, '..', 'assets', 'fonts', 'StudiandaWatermark.ttf'),
    resourcesPath
      ? path.join(resourcesPath, 'assets', 'fonts', 'StudiandaWatermark.ttf')
      : undefined
  ];
  return candidates.find(
    (candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string)
  );
}

/**
 * 选择渲染字体：只接受调用方显式给的 `fontPath`（应为随包的 OFL/Apache 字体）；
 * 没给就用平台默认无衬线字体。两者都不复制、不分发字体文件。
 */
function resolveWatermarkFamily(
  label: string,
  fontPath?: string,
  fontFamily?: string
): string {
  if (resolvedFamily !== undefined && !fontPath) return resolvedFamily ?? 'sans-serif';
  if (fontPath) {
    try {
      GlobalFonts.registerFromPath(fontPath, fontFamily ?? WATERMARK_FAMILY);
    } catch (error) {
      throw new WatermarkError(
        `failed to register watermark font: ${(error as Error).message}`
      );
    }
    const family = fontFamily ?? WATERMARK_FAMILY;
    if (!cjkGlyphsAvailable(family, label)) return 'sans-serif';
    resolvedFamily = family;
    return family;
  }
  resolvedFamily = null;
  return 'sans-serif';
}

/**
 * 烧录标准化水印。
 *
 * 失败即抛 `WatermarkError`（fail-closed）：调用方不得把未标识的图片当成功产物落盘。
 */
export async function burnImageWatermark(
  image: Uint8Array,
  options: BurnWatermarkOptions
): Promise<BurnWatermarkResult> {
  const label = imageWatermarkText(options.kind);
  const asciiLabel = imageWatermarkAsciiText(options.kind);

  let family = resolveWatermarkFamily(
    label,
    options.fontPath ?? bundledWatermarkFont(),
    options.fontFamily
  );
  const asciiFallback = !cjkGlyphsAvailable(family, label);
  if (asciiFallback) family = 'sans-serif';
  const text = asciiFallback ? asciiLabel : label;

  let canvas;
  let context;
  try {
    const loaded = await loadImage(Buffer.from(image));
    canvas = createCanvas(loaded.width, loaded.height);
    context = canvas.getContext('2d');
    context.drawImage(loaded, 0, 0);
  } catch (error) {
    throw new WatermarkError(`failed to load image: ${(error as Error).message}`);
  }
  if (!canvas || !context) throw new WatermarkError('failed to create canvas');

  const fontScale = options.fontScale ?? 0.016;
  const fontSize = Math.max(12, Math.round(canvas.width * fontScale));
  const padding = Math.max(6, Math.round(fontSize * 0.5));
  context.font = `${fontSize}px ${family}`;
  context.textBaseline = 'middle';
  const textWidth = context.measureText(text).width;
  const bandHeight = Math.round(fontSize * 1.6);
  const bandWidth = Math.min(canvas.width, Math.ceil(textWidth + padding * 2));
  const bandX = Math.max(0, canvas.width - bandWidth - padding);
  const bandY = Math.max(0, canvas.height - bandHeight - padding);

  const scrimOpacity = options.scrimOpacity ?? 0.55;
  context.fillStyle = `rgba(0, 0, 0, ${scrimOpacity})`;
  context.fillRect(bandX, bandY, bandWidth, bandHeight);
  context.fillStyle = 'rgba(255, 255, 255, 0.95)';
  context.fillText(text, bandX + padding, bandY + bandHeight / 2);

  let png: Uint8Array;
  try {
    png = Uint8Array.from(canvas.toBuffer('image/png'));
  } catch (error) {
    throw new WatermarkError(`failed to encode PNG: ${(error as Error).message}`);
  }
  // 隐式标识：AI 类写 AIGC，本机 OCR 写 Source；都保留 Software。写不进去就整件事失败。
  for (const { keyword, value } of imageWatermarkMetadata(options.kind, text)) {
    png = insertPngTextChunk(png, keyword, value);
  }
  return { bytes: png, text, changed: true, asciiFallback };
}
