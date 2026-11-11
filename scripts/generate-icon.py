"""Generate the Studianda application icons.

Two artworks, both centred in the 512 design grid:

* ``open``: an open book with a vermilion S bookmark; used while the app is
  running (window / taskbar icon) and as the in-app brand mark.
* ``stack``: a stack of three books with a vermilion S bookmark; used before
  launch (installer / uninstaller / exe / shortcut / Start menu icon).

Both artworks are drawn from geometry (no fonts, no third-party images) with a
light 3-D treatment: cast shadow, page thickness, contact shadows and edge
highlights.  The book spines are on the left, the page fore-edges on the right.

Outputs (relative to the repo root):
    apps/desktop/build/icon.ico         stack, 16/24/32/48/64/128/256 (win.icon / NSIS)
    apps/desktop/build/icon.png         stack, 512
    apps/desktop/build/icon-open.ico    open, 16/24/32/48/64/128/256 (BrowserWindow.icon on Windows)
    apps/desktop/build/icon-open.png    open, 512 (window icon fallback)
    docs/brand/app-icon-stack-*.png     stack master 1024/512/256/32
    docs/brand/icon-open-*.png          open master 1024/512/256/32
    packages/ui/src/brand-mark-data.ts  open artwork as a 256 px data URI (in-app mark)

Run:  python scripts/generate-icon.py
Requires Pillow.
"""
import os
import math
import base64
import io
import argparse

from PIL import Image, ImageDraw, ImageFilter, ImageChops

S = 2048
K = S / 512.0

PAPER_RAISED = (251, 247, 236, 255)
PAPER = (244, 238, 223, 255)
PAPER_SUNK = (235, 226, 207, 255)
PAPER_DEEP = (226, 215, 195, 255)
CELADON = (127, 163, 138, 255)
CELADON_DEEP = (79, 111, 90, 255)
CELADON_LIGHT = (228, 237, 226, 255)
VERMILION = (178, 59, 46, 255)


def sx(v):
    return int(round(v * K))


def box(x0, y0, x1, y1):
    return [sx(x0), sx(y0), sx(x1), sx(y1)]


def blend(a, b, t):
    return (int(round(a[0] + (b[0] - a[0]) * t)),
            int(round(a[1] + (b[1] - a[1]) * t)),
            int(round(a[2] + (b[2] - a[2]) * t)), 255)


def blank():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))


def squircle(color):
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle(box(0, 0, 512, 512), radius=sx(112), fill=color)
    return im


def vgrad(top, bottom, y0, y1, power=1.0):
    im = blank()
    d = ImageDraw.Draw(im)
    for y in range(S):
        t = ((y / K) - y0) / max(1e-6, (y1 - y0))
        t = min(1.0, max(0.0, t)) ** power
        d.line([(0, y), (S, y)], fill=blend(top, bottom, t))
    return im


def grad_fill(mask, grad):
    im = blank()
    im.paste(grad, (0, 0), mask)
    return im


def solid_fill(mask, color):
    im = blank()
    im.paste(Image.new('RGBA', (S, S), color), (0, 0), mask)
    return im


def shadow(mask, color, blur, dx=0, dy=0):
    sh = blank()
    sh.paste(Image.new('RGBA', (S, S), color), (sx(dx), sx(dy)), mask)
    return sh.filter(ImageFilter.GaussianBlur(radius=blur))


def rmask(x0, y0, x1, y1, r):
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box(x0, y0, x1, y1), radius=sx(r), fill=255)
    return mask


# ------------------------------------------------------------------ bookmark
def normals(pts):
    out = []
    n = len(pts)
    for i, (x, y) in enumerate(pts):
        prev = pts[max(0, i - 1)]
        nxt = pts[min(n - 1, i + 1)]
        dx, dy = nxt[0] - prev[0], nxt[1] - prev[1]
        ln = math.hypot(dx, dy) or 1
        out.append((-dy / ln, dx / ln))
    return out


def ribbon_mask(pts, w0, w1, top_limit, notch_extend=16):
    n = len(pts)
    nrm = normals(pts)
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    left, right = [], []
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        w = w0 + (w1 - w0) * t
        nx, ny = nrm[i]
        left.append((x + nx * w / 2, y + ny * w / 2))
        right.append((x - nx * w / 2, y - ny * w / 2))
    md.polygon([(sx(x), sx(y)) for x, y in left + right[::-1]], fill=255)

    tip, prev = pts[-1], pts[-2]
    dx, dy = tip[0] - prev[0], tip[1] - prev[1]
    ln = math.hypot(dx, dy) or 1
    tx, ty = dx / ln, dy / ln
    nx, ny = -ty, tx
    half = w1 / 2
    end = (tip[0] + tx * notch_extend, tip[1] + ty * notch_extend)
    md.polygon([(sx(tip[0] + nx * half), sx(tip[1] + ny * half)),
                (sx(tip[0] - nx * half), sx(tip[1] - ny * half)),
                (sx(end[0] - nx * half), sx(end[1] - ny * half)),
                (sx(end[0] + nx * half), sx(end[1] + ny * half))], fill=255)
    md.polygon([(sx(end[0] + nx * (half + 1)), sx(end[1] + ny * (half + 1))),
                (sx(end[0] - nx * (half + 1)), sx(end[1] - ny * (half + 1))),
                (sx(end[0] - tx * (w1 * 0.95)), sx(end[1] - ty * (w1 * 0.95)))], fill=0)
    md.rectangle([0, 0, S, max(0, sx(top_limit) - 1)], fill=0)
    return mask


def bookmark_path(x, top, bottom, amp, drift, steps=96):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        delta = -amp * math.sin(2 * math.pi * t) * math.sin(math.pi * t) ** 0.25 + drift * t ** 2
        u = min(1.0, t / 0.12)
        latch = u * u * (3 - 2 * u)
        pts.append((x + delta * latch, top + (bottom - top) * t))
    return pts


def add_ribbon(base, pts, w0, w1, top, shadow_alpha=105):
    mask = ribbon_mask(pts, w0, w1, top)
    grad = vgrad(VERMILION, (214, 148, 132, 255), pts[0][1] - 10, pts[-1][1] + 10, 1.0)
    base.alpha_composite(shadow(mask, (62, 38, 30, shadow_alpha), 8, 5, 8))
    base.alpha_composite(grad_fill(mask, grad))
    edge = mask.filter(ImageFilter.GaussianBlur(radius=3))
    base.alpha_composite(shadow(edge, (120, 40, 30, 40), 5, 2, 1))


# ------------------------------------------------------------------ open book
def art_open():
    art = blank()
    top, bottom, left, right, cx = 142, 364, 86, 426, 256
    art.alpha_composite(shadow(rmask(left - 2, top, right + 2, bottom + 14, 18),
                               (28, 44, 36, 120), 18, 0, 10))

    art.alpha_composite(solid_fill(rmask(left, top + 8, right, bottom + 12, 16), PAPER_DEEP))
    edge = blank()
    ed = ImageDraw.Draw(edge)
    for i, y in enumerate((bottom + 1, bottom + 5, bottom + 9)):
        ed.line([(sx(left + 12), sx(y)), (sx(right - 12), sx(y))],
                fill=blend(PAPER_DEEP, (255, 255, 255, 255), 0.4 if i % 2 == 0 else 0.05),
                width=sx(2))
    art.alpha_composite(edge)

    grad = vgrad(blend(PAPER_RAISED, (255, 255, 255, 255), 0.22), PAPER_SUNK, top, bottom, 0.75)
    art.alpha_composite(grad_fill(rmask(left, top, cx - 7, bottom, 14), grad))
    art.alpha_composite(grad_fill(rmask(cx + 7, top, right, bottom, 14), grad))

    art.alpha_composite(solid_fill(rmask(cx - 7, top + 4, cx + 7, bottom - 4, 4), PAPER_DEEP))
    gutter = Image.new('L', (S, S), 0)
    ImageDraw.Draw(gutter).rectangle(box(cx - 20, top + 6, cx + 20, bottom - 6), fill=255)
    art.alpha_composite(shadow(gutter.filter(ImageFilter.GaussianBlur(12)), (110, 92, 70, 55), 8, 0, 0))

    hl = blank()
    ImageDraw.Draw(hl).line([(sx(left + 16), sx(top + 1.5)), (sx(right - 16), sx(top + 1.5))],
                            fill=(255, 255, 255, 110), width=sx(3))
    art.alpha_composite(hl)

    add_ribbon(art, bookmark_path(256, top, 372, amp=22, drift=18), 38, 30, top)
    return art


# ------------------------------------------------------------------ stack
def hgrad(x0, x1, c0, c1):
    im = blank()
    d = ImageDraw.Draw(im)
    for x in range(S):
        t = min(1.0, max(0.0, ((x / K) - x0) / max(1e-6, (x1 - x0))))
        d.line([(x, 0), (x, S)], fill=blend(c0, c1, t))
    return im


def hgrad_stops(x0, x1, stops):
    """Horizontal multi-stop gradient; stops = [(position 0..1, color), ...]."""
    im = blank()
    d = ImageDraw.Draw(im)
    for x in range(S):
        t = min(1.0, max(0.0, ((x / K) - x0) / max(1e-6, (x1 - x0))))
        color = stops[-1][1]
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if p0 <= t <= p1:
                local = (t - p0) / max(1e-6, (p1 - p0))
                color = blend(c0, c1, local)
                break
        d.line([(x, 0), (x, S)], fill=color)
    return im


def book_mask(x0, y0, x1, y1, r):
    """Rounded on the spine (left) side, square on the page fore-edge (right) side."""
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(box(x0, y0, x0 + 2 * r, y1), radius=sx(r), fill=255)
    md.rectangle(box(x0 + r, y0, x1, y1), fill=255)
    return mask


def concave_edge(x1, y0, y1, concave, steps=48):
    """Points of a fore-edge that curves inward (concave) towards the book."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        pts.append((x1 - concave * math.sin(math.pi * t), y0 + (y1 - y0) * t))
    return pts


def book_mask_concave(x0, y0, x1, y1, r, concave):
    """Rounded spine on the left, concave fore-edge on the right."""
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(box(x0, y0, x0 + 2 * r, y1), radius=sx(r), fill=255)
    edge = concave_edge(x1, y0, y1, concave)
    pts = [(sx(x0 + r), sx(y0)), (sx(x1), sx(y0))]
    pts += [(sx(x), sx(y)) for x, y in edge[1:]]
    pts += [(sx(x0 + r), sx(y1))]
    md.polygon(pts, fill=255)
    return mask


def hfade(width, x0, x1, solid_until):
    """Alpha ramp: 255 until `solid_until`, then linear down to 0 at `x1`."""
    a = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(a)
    for x in range(S):
        xd = x / K
        if xd <= solid_until:
            v = 255
        elif xd >= x1:
            v = 0
        else:
            v = int(round(255 * (1 - (xd - solid_until) / max(1e-6, x1 - solid_until))))
        d.line([(x, 0), (x, S)], fill=v)
    return ImageChops.multiply(width, a)


def alpha_ramp(x0, x1, a0, a1):
    """Horizontal alpha ramp (0..255) between x0 and x1."""
    a = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(a)
    for x in range(S):
        xd = x / K
        t = min(1.0, max(0.0, (xd - x0) / max(1e-6, x1 - x0)))
        d.line([(x, 0), (x, S)], fill=int(round(a0 + (a1 - a0) * t)))
    return a


def art_stack():
    """Cloth-cover books: rounded celadon spine + cover boards wrapping cream page blocks."""
    art = blank()
    books = [
        (104, 250, 432, 316),   # top
        (82, 318, 410, 384),    # middle
        (92, 386, 420, 452),    # bottom
    ]
    art.alpha_composite(shadow(rmask(82, 248, 432, 456, 22), (28, 44, 36, 120), 16, 0, 10))
    page_grad = vgrad(blend(PAPER_RAISED, (255, 255, 255, 255), 0.3), PAPER_SUNK, 250, 452, 0.6)

    cloth = blend(CELADON, CELADON_DEEP, 0.28)
    cloth_dark = blend(cloth, CELADON_DEEP, 0.55)
    cloth_light = blend(cloth, (255, 255, 255, 255), 0.35)
    crease = blend(CELADON_DEEP, (30, 40, 32, 255), 0.35)
    page_line = (146, 120, 84, 255)
    concave = 10

    for (x0, y0, x1, y1) in books:
        body = book_mask_concave(x0, y0, x1, y1, 16, concave)
        art.alpha_composite(grad_fill(body, page_grad))

        # ---- fore-edge: concave page block, lighter at the edge
        outer = concave_edge(x1, y0, y1, concave)
        inner = [(x - 32, y) for x, y in outer]
        edge_poly = [(sx(x), sx(y)) for x, y in outer] + [(sx(x), sx(y)) for x, y in reversed(inner)]
        edge_mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(edge_mask).polygon(edge_poly, fill=255)
        art.alpha_composite(solid_fill(edge_mask, PAPER_RAISED))
        # soften the page block towards the book interior
        feather = ImageChops.multiply(edge_mask, alpha_ramp(x1 - 34, x1 - 2, 0, 80))
        art.alpha_composite(solid_fill(feather, (255, 255, 255, 255)))
        # depth shading just inside the fore-edge
        inner8 = [(x - 9, y) for x, y in outer]
        depth_mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(depth_mask).polygon(
            [(sx(x), sx(y)) for x, y in outer] + [(sx(x), sx(y)) for x, y in reversed(inner8)], fill=255)
        art.alpha_composite(shadow(depth_mask.filter(ImageFilter.GaussianBlur(4)), (92, 72, 50, 55), 0, 0, 0))

        # horizontal page lines: staggered lengths, fading towards the interior
        fe = blank()
        fd = ImageDraw.Draw(fe)
        for k in range(10):
            yy = y0 + 9 + k * ((y1 - y0) - 18) / 9.0
            t = (yy - y0) / (y1 - y0)
            x_out = x1 - concave * math.sin(math.pi * t) - 2
            length = 12 + (k * 13) % 22          # 12..33, staggered
            segs = 6
            for s in range(segs):
                xa = x_out - length * s / segs
                xb = x_out - length * (s + 1) / segs
                alpha = int(round(24 + 140 * (1 - s / segs) ** 1.5))
                fd.line([(sx(xb), sx(yy)), (sx(xa), sx(yy))],
                        fill=(page_line[0], page_line[1], page_line[2], alpha), width=sx(2))
        # darker edge of the page block, following the concavity
        fd.line([(sx(x - 1), sx(y)) for x, y in outer],
                fill=blend(PAPER_DEEP, CELADON_DEEP, 0.35), width=sx(2))
        art.alpha_composite(fe)

        # ---- thin cloth cover edges (top / bottom boards)
        cover_h = 5
        top_strip = ImageChops.multiply(body, rmask(x0, y0 - 2, x1 + 2, y0 + cover_h, 4))
        bot_strip = ImageChops.multiply(body, rmask(x0, y1 - cover_h, x1 + 2, y1 + 2, 4))
        art.alpha_composite(grad_fill(top_strip, vgrad(cloth_light, cloth, y0, y0 + cover_h)))
        art.alpha_composite(grad_fill(bot_strip, vgrad(cloth, cloth_dark, y1 - cover_h, y1)))

        # ---- curved spine EDGE (a narrow band following the rounded left silhouette, not a panel)
        w = 22
        shifted = body.transform((S, S), Image.AFFINE, (1, 0, -sx(w), 0, 1, 0), resample=Image.BILINEAR)
        band = ImageChops.multiply(ImageChops.subtract(body, shifted), body)
        # soft crease shadow cast by the curved edge onto the pages
        crease_shadow = band.transform((S, S), Image.AFFINE, (1, 0, sx(3), 0, 1, 0), resample=Image.BILINEAR)
        art.alpha_composite(shadow(crease_shadow.filter(ImageFilter.GaussianBlur(3)), (60, 52, 36, 95), 0, 0, 0))
        # cloth shading across the curved edge
        band_grad = hgrad_stops(x0 - 2, x0 + w + 2, [
            (0.00, cloth_dark),
            (0.25, cloth),
            (0.55, cloth_light),
            (0.85, cloth),
            (1.00, cloth),
        ])
        art.alpha_composite(grad_fill(band, band_grad))
        # rim light on the outside of the curve
        rim = ImageChops.subtract(band, band.filter(ImageFilter.MinFilter(5)))
        art.alpha_composite(solid_fill(rim, (226, 240, 226, 160)))
        # highlight on the inner side where the cover turns in
        inner_edge = ImageChops.subtract(
            band, band.transform((S, S), Image.AFFINE, (1, 0, sx(2), 0, 1, 0), resample=Image.BILINEAR))
        art.alpha_composite(solid_fill(inner_edge, (250, 250, 240, 70)))
        # head / tail caps at the ends of the curved spine edge
        caps = blank()
        for cy0, cy1 in ((y0, y0 + 4), (y1 - 4, y1)):
            cap_mask = ImageChops.multiply(band, rmask(x0 - 4, cy0, x0 + w + 2, cy1, 4))
            cap_layer = blank()
            cap_layer.paste(Image.new('RGBA', (S, S), blend(cloth_dark, crease, 0.35)), (0, 0), cap_mask)
            caps.alpha_composite(cap_layer)
        art.alpha_composite(caps)
        # small spine ribs crossing the curved edge
        ribs = blank()
        rd = ImageDraw.Draw(ribs)
        for k in range(3):
            yy = y0 + 10 + k * ((y1 - y0) - 20) / 2.0
            rd.line([(sx(x0 - 2), sx(yy)), (sx(x0 + w - 2), sx(yy))],
                    fill=(cloth_dark[0], cloth_dark[1], cloth_dark[2], 80), width=sx(2))
            rd.line([(sx(x0 - 2), sx(yy + 2)), (sx(x0 + w - 2), sx(yy + 2))],
                    fill=(cloth_light[0], cloth_light[1], cloth_light[2], 90), width=sx(1))
        art.alpha_composite(ribs.filter(ImageFilter.GaussianBlur(0.8)))

        # contact shadow onto the book below
        contact = Image.new('L', (S, S), 0)
        ImageDraw.Draw(contact).rectangle(box(x0 + 10, y1 - 2, x1 - 10, y1 + 3), fill=255)
        art.alpha_composite(shadow(contact.filter(ImageFilter.GaussianBlur(6)), (96, 76, 56, 130), 0, 0, 0))

    add_ribbon(art, bookmark_path(300, 250, 470, amp=17, drift=12), 34, 28, 250, shadow_alpha=100)
    return art


# ------------------------------------------------------------------ compose
def compose(art, scale=1.32):
    """Scale the artwork up a little, then centre its solid silhouette in the 512 grid."""
    sized = art.resize((int(round(S * scale)), int(round(S * scale))), Image.LANCZOS)
    core = sized.split()[3].point(lambda a: 255 if a > 240 else 0)
    bbox = core.getbbox()
    layer = blank()
    if bbox:
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        dx = int(round(S / 2 - cx))
        dy = int(round(S / 2 - cy))
        layer.paste(sized, (dx, dy), sized)
    else:
        layer = sized
    bg = squircle(CELADON_DEEP)
    bg.alpha_composite(layer)
    return bg


def write_png(master, path, size):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    master.resize((size, size), Image.LANCZOS).save(path)


def write_brand_mark(master, path):
    buf = io.BytesIO()
    master.resize((256, 256), Image.LANCZOS).save(buf, format='PNG')
    data = base64.b64encode(buf.getvalue()).decode('ascii')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('// Generated by scripts/generate-icon.py -- do not edit by hand.\n')
        fh.write('// In-app brand mark: the open-book artwork (256 px), embedded as a data URI.\n')
        fh.write(f'export const BRAND_MARK_DATA_URI =\n  \'data:image/png;base64,{data}\';\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = parser.parse_args()
    root = os.path.abspath(args.root)

    open_master = compose(art_open())
    stack_master = compose(art_stack())

    build = os.path.join(root, 'apps', 'desktop', 'build')
    brand = os.path.join(root, 'docs', 'brand')
    ui = os.path.join(root, 'packages', 'ui', 'src')
    for d in (build, brand, ui):
        os.makedirs(d, exist_ok=True)

    ico = stack_master.resize((256, 256), Image.LANCZOS)
    ico.save(os.path.join(build, 'icon.ico'), format='ICO',
             sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    open_ico = open_master.resize((256, 256), Image.LANCZOS)
    open_ico.save(os.path.join(build, 'icon-open.ico'), format='ICO',
                 sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    write_png(stack_master, os.path.join(build, 'icon.png'), 512)
    write_png(open_master, os.path.join(build, 'icon-open.png'), 512)

    for prefix, master in (('app-icon-stack', stack_master), ('icon-open', open_master)):
        for size in (1024, 512, 256, 32):
            write_png(master, os.path.join(brand, f'{prefix}-{size}.png'), size)

    write_brand_mark(open_master, os.path.join(ui, 'brand-mark-data.ts'))
    print('wrote icon.ico (stack: installer/exe/shortcut), icon-open.ico (open: window/taskbar), icon.png, icon-open.png, docs/brand masters, ui brand-mark-data.ts')


if __name__ == '__main__':
    main()


