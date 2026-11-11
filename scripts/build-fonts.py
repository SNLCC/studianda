#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

KAI_OLD_FAMILY = 'LXGW WenKai GB'
KAI_NEW_FAMILY = 'Studianda Kai'
KAI_NEW_PS = 'StudiandaKaiSC-Regular'

# 楷体子集：GB2312 汉字 + 常用符号块 + 拉丁/希腊/数学
SYMBOL_RANGES = [
    (0x0020, 0x007E),   # 基本拉丁
    (0x00A0, 0x024F),   # 拉丁补充 / 扩展 A、B
    (0x0300, 0x036F),   # 组合附加符号
    (0x0370, 0x03FF),   # 希腊
    (0x0400, 0x04FF),   # 西里尔
    (0x2000, 0x206F),   # 通用标点
    (0x20A0, 0x20CF),   # 货币
    (0x2100, 0x218F),   # 字母式符号 / 数字形式
    (0x2190, 0x21FF),   # 箭头
    (0x2200, 0x22FF),   # 数学运算符
    (0x2460, 0x24FF),   # 带圈字符
    (0x2500, 0x257F),   # 制表符
    (0x25A0, 0x26FF),   # 几何图形 / 杂项符号
    (0x3000, 0x303F),   # CJK 标点
    (0xFF00, 0xFFEF),   # 全角
]

# 拉丁伴随字体：Noto Serif / Noto Sans（latin-greek-cyrillic）负责 CJK 字体里缺失的
# 拉丁扩展、IPA、组合附加符号、完整希腊/西里尔、上下标等；通用标点留给 CJK 字体，
# 避免中文引号被换成西文设计。
LATIN_RANGES = [
    (0x0020, 0x024F),   # 基本拉丁 / 拉丁补充 / 扩展 A、B
    (0x0250, 0x02FF),   # IPA 扩展 / 修饰字母
    (0x0300, 0x036F),   # 组合附加符号
    (0x0370, 0x03FF),   # 希腊
    (0x0400, 0x04FF),   # 西里尔
    (0x1E00, 0x1EFF),   # 拉丁扩展附加
    (0x2070, 0x209F),   # 上标 / 下标
    (0x20A0, 0x20CF),   # 货币
    (0x2100, 0x214F),   # 字母式符号
    (0x2150, 0x218F),   # 数字形式
    (0x2C60, 0x2C7F),   # 拉丁扩展 C
    (0xA720, 0xA7FF),   # 拉丁扩展 D
]

def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest().upper()


def fmt_size(n: int) -> str:
    return '%.2f MB' % (n / 1024 / 1024)


def cmap_codepoints(font: TTFont) -> set[int]:
    result: set[int] = set()
    for table in font['cmap'].tables:
        if table.isUnicode():
            result |= set(table.cmap.keys())
    return result


def gb2312_chars() -> set[int]:
    chars: set[int] = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(ord(bytes([hi, lo]).decode('gb2312')))
            except Exception:
                pass
    return chars


def build_charset(font: TTFont, tier: str) -> list[int]:
    available = cmap_codepoints(font)
    if tier == 'full':
        return sorted(available)
    if tier == 'latin':
        chars = set()
        for start, end in LATIN_RANGES:
            chars |= set(range(start, end + 1))
        return sorted(c for c in chars if c in available)
    chars = set(gb2312_chars())
    for start, end in SYMBOL_RANGES:
        chars |= set(range(start, end + 1))
    return sorted(c for c in chars if c in available)


def instantiate(src: str, wght: float, cache_dir: str) -> str:
    tag = '%s-%s.ttf' % (os.path.splitext(os.path.basename(src))[0], int(wght))
    out = os.path.join(cache_dir, tag)
    if os.path.exists(out):
        return out
    font = TTFont(src)
    # 必须钉死所有轴：Noto Serif / Noto Sans 的拉丁版有 wght + wdth 两个轴，
    # 只钉 wght 会留下 wdth 变体（fvar/gvar 仍在，产物不是真正的静态字体）。
    settings = {'wght': wght}
    if 'fvar' in font:
        for axis in font['fvar'].axes:
            if axis.axisTag not in settings:
                settings[axis.axisTag] = axis.defaultValue
    instance = instancer.instantiateVariableFont(
        font, settings, inplace=False, updateFontNames=False
    )
    instance.save(out)
    instance.close()
    font.close()
    return out


def subset_font(src: str, chars: list[int], out: str) -> None:
    options = subset.Options()
    options.flavor = 'woff2'
    options.with_zopfli = True
    options.layout_features = ['*']
    options.hinting = False
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.notdef_outline = True
    options.recommended_glyphs = True
    font = TTFont(src)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=chars)
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(out)
    font.close()


def rename_kai(path: str) -> None:
    """把文楷的「主名称」改成 Studianda Kai；版权/许可/作者字段原样保留。"""
    font = TTFont(path)
    name = font['name']
    replacements = {
        1: (KAI_NEW_FAMILY, 0x409),          # family
        4: (KAI_NEW_FAMILY, 0x409),          # full name
        6: (KAI_NEW_PS, 0x409),              # postscript
        16: (KAI_NEW_FAMILY, 0x409),         # typographic family（本字体无此条，存在才改）
    }
    for rec in list(name.names):
        if rec.nameID in replacements:
            value, _ = replacements[rec.nameID]
            name.setName(value, rec.nameID, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID == 3:  # unique id：''<Family>:Version x.yyy'
            old = name.getDebugName(3) or ''
            if KAI_OLD_FAMILY in old:
                name.setName(old.replace(KAI_OLD_FAMILY, KAI_NEW_FAMILY),
                             rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    font.save(path)
    font.close()


def main() -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument('--serif', required=True, help='NotoSerifCJKsc-VF.ttf')
    ap.add_argument('--sans', required=True, help='NotoSansCJKsc-VF.ttf')
    ap.add_argument('--kai', required=True, help='LXGWWenKaiGB-Regular.ttf')
    ap.add_argument('--serif-latin', default=None,
                    help='可选：NotoSerif 变量字体（latin-greek-cyrillic），用于补 CJK 字体缺失的拉丁/IPA/希腊/西里尔')
    ap.add_argument('--sans-latin', default=None,
                    help='可选：NotoSans 变量字体（latin-greek-cyrillic），同上')
    ap.add_argument('--out', default=os.path.join(
        repo_root, 'packages', 'ui', 'src', 'styles', 'assets', 'fonts'))
    ap.add_argument('--cache', default=os.path.join(repo_root, '.font-build-cache'))
    ap.add_argument('--tier', default='full', choices=['full', 'gb2312'],
                    help='宋/黑的覆盖档位；full=字体全部码位（默认）')
    ap.add_argument('--only', default='all', choices=['all', 'companions'],
                    help='all=全部字体；companions=只重建拉丁伴随字体')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.cache, exist_ok=True)

    jobs = [
        # (源, 静态字重, 输出名, 覆盖档位, 是否需要改名)
        (args.serif, 400, 'StudiandaSerifSC-Regular.woff2', args.tier, False),
        (args.serif, 600, 'StudiandaSerifSC-SemiBold.woff2', args.tier, False),
        (args.sans, 400, 'StudiandaSansSC-Regular.woff2', args.tier, False),
        (args.sans, 500, 'StudiandaSansSC-Medium.woff2', args.tier, False),
        (args.kai, None, 'StudiandaKaiSC-Regular.woff2', 'gb2312', True),
    ]
    if args.only == 'companions':
        jobs = []
    # 拉丁伴随字体（可选）：只覆盖 CJK 字体里缺失的区段，通过 unicode-range 局部生效
    if args.serif_latin and args.only in ('all', 'companions'):
        jobs += [
            (args.serif_latin, 400, 'StudiandaSerifLatin-Regular.woff2', 'latin', False),
            (args.serif_latin, 600, 'StudiandaSerifLatin-SemiBold.woff2', 'latin', False),
        ]
    if args.sans_latin and args.only in ('all', 'companions'):
        jobs += [
            (args.sans_latin, 400, 'StudiandaSansLatin-Regular.woff2', 'latin', False),
            (args.sans_latin, 500, 'StudiandaSansLatin-Medium.woff2', 'latin', False),
        ]
    # 拉丁伴随字体（可选）：只覆盖 CJK 字体里缺失的区段，通过 unicode-range 局部生效
    manifest = []
    for src, wght, out_name, tier, rename in jobs:
        t0 = time.time()
        print('=' * 74)
        print('%s  wght=%s  tier=%s' % (out_name, wght, tier))
        sys.stdout.flush()
        staged = src
        if wght is not None:
            staged = instantiate(src, wght, args.cache)
        tmp_out = os.path.join(args.cache, out_name.replace('.woff2', '.tmp.woff2'))
        font = TTFont(staged, lazy=True)
        chars = build_charset(font, tier)
        font.close()
        print('  码位 %d' % len(chars))
        sys.stdout.flush()
        subset_font(staged, chars, tmp_out)
        if rename:
            # woff2 需先解压再改名：转成 TTF 处理后再压回去
            plain = os.path.join(args.cache, 'kai-rename.ttf')
            f = TTFont(tmp_out)
            f.flavor = None
            f.save(plain)
            f.close()
            rename_kai(plain)
            f = TTFont(plain)
            f.flavor = 'woff2'
            f.save(tmp_out)
            f.close()
        final = os.path.join(args.out, out_name)
        with open(tmp_out, 'rb') as fh:
            data = fh.read()
        with open(final, 'wb') as fh:
            fh.write(data)
        size = len(data)
        digest = sha256(final)
        print('  -> %s  %s  %.0fs' % (final, fmt_size(size), time.time() - t0))
        sys.stdout.flush()
        manifest.append({
            'file': out_name,
            'bytes': size,
            'sha256': digest,
            'weight': wght,
            'tier': tier,
            'codepoints': len(chars),
            'renamed': rename,
        })

    manifest_path = os.path.join(args.out, 'fonts.manifest.json')
    if args.only == 'companions' and os.path.exists(manifest_path):
        # 增量重建：保留 CJK 字体条目，只替换本次产出的条目
        with open(manifest_path, 'r', encoding='utf-8') as fh:
            existing = json.load(fh)
        built = {item['file'] for item in manifest}
        manifest = [item for item in existing if item['file'] not in built] + manifest
    with open(manifest_path, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    total = sum(item['bytes'] for item in manifest)
    print('=' * 74)
    print('共 %d 个文件，合计 %s' % (len(manifest), fmt_size(total)))
    print('清单：%s' % manifest_path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
