#!/usr/bin/env python3
"""
PlumiChat's app icon, generated rather than drawn, so the whole set can never
drift out of sync with the palette.

The mark: a phosphor SCREEN floating in a terracotta field, shaped as a speech
bubble, with a prompt caret and a block cursor inside it. It says the two things
PlumiChat is at once -- a chat, and a terminal -- and it is a sibling to
the wider Plume family by palette and pixel language rather than by reusing
any mascot.

Every colour below is a Plume token (public/plume.css). The bubble is --code-bg
because of the standing rule that a screen inside a screen stays phosphor in
both modes; the field is the PAPER accent #E0915E, which is the exact terracotta
of the Plume palette, so a family of apps sits together on a home screen.

Geometry is declared once in a 32-unit square and rendered two ways:

  * vector  -- supersampled 16x and box-filtered down. Used for every size where
               the icon is BIG (100px and up) and smooth arcs read as designed.
  * pixel   -- a literal 32x32 grid, one unit per pixel, no anti-aliasing. Used
               for the 16/32px favicon, where a downsampled arc turns to soup.

Both paths consume the same constants, so the small mark is the large mark, not
a different drawing.

Usage:  python3 scripts/brand/make-icons.py [--out public] [--sheet]
"""

import argparse
import math
import os
from PIL import Image, ImageDraw

# ---------------------------------------------------------------- palette ---
FIELD  = (224, 145,  94, 255)   # #E0915E  Plume paper --accent (the icon ground)
SHADE  = (176, 108,  64, 255)   # a darkened FIELD: the hard, blur-free Plume shadow
SCREEN = ( 16,  14,  12, 255)   # #100E0C  --code-bg
INK    = (232, 226, 211, 255)   # #E8E2D3  --code-text
CURSOR = (232, 160, 111, 255)   # #E8A06F  --accent (phosphor), the one warm note inside

# ------------------------------------------------------------------ layout ---
# All coordinates are in a 32-unit square, so a unit is exactly one pixel in the
# 32px favicon and 16 pixels in the 512px icon.
U = 32.0

R_OUT = 7.0                     # container corner radius (~22%, iOS proportions)

BUB = (4.0, 6.0, 28.0, 21.0)    # speech bubble body: x0, y0, x1, y1
R_BUB = 2.5
SHADOW_OFF = 1.0                # hard offset, no blur -- see --shadow-sm

TAIL = ((8.5, 19.0), (8.5, 24.5), (16.0, 19.0))   # down-left; stubby, not a pin

GLYPH_TOP, GLYPH_BOT = 9.5, 17.5
CHEV_X0, CHEV_X1 = 10.0, 15.0   # the > caret
CHEV_W = 2.2                    # stroke width
CUR = (18.0, 9.5, 22.0, 17.5)   # the block cursor


# ================================================================== vector ===
def _rounded(draw, box, r, fill):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle([x0, y0, x1 - 1, y1 - 1], radius=r, fill=fill)


def _bubble(draw, s, dx, dy, fill):
    """Body + tail as one silhouette, at scale s, offset by (dx, dy) units."""
    x0, y0, x1, y1 = BUB
    _rounded(draw, [(x0 + dx) * s, (y0 + dy) * s, (x1 + dx) * s, (y1 + dy) * s], R_BUB * s, fill)
    draw.polygon([((px + dx) * s, (py + dy) * s) for px, py in TAIL], fill=fill)


def render_vector(size, *, rounded=True, content_scale=1.0, ss=16):
    """Smooth render. content_scale < 1 shrinks the artwork about the centre,
    which is how the maskable icon keeps its safe zone."""
    n = int(size * ss)
    s = n / U                                   # pixels per unit
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=R_OUT * s, fill=FIELD)
    else:
        d.rectangle([0, 0, n - 1, n - 1], fill=FIELD)

    art = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    a = ImageDraw.Draw(art)

    _bubble(a, s, SHADOW_OFF, SHADOW_OFF, SHADE)
    _bubble(a, s, 0, 0, SCREEN)

    ym = (GLYPH_TOP + GLYPH_BOT) / 2
    a.line([(CHEV_X0 * s, GLYPH_TOP * s), (CHEV_X1 * s, ym * s), (CHEV_X0 * s, GLYPH_BOT * s)],
           fill=INK, width=max(1, round(CHEV_W * s)), joint="curve")
    a.rectangle([CUR[0] * s, CUR[1] * s, CUR[2] * s - 1, CUR[3] * s - 1], fill=CURSOR)

    if content_scale != 1.0:
        m = max(1, round(n * content_scale))
        art = art.resize((m, m), Image.LANCZOS)
        off = (n - m) // 2
        pad = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        pad.paste(art, (off, off))
        art = pad

    img.alpha_composite(art)
    return img.resize((size, size), Image.LANCZOS)


# =================================================================== pixel ===
# The 32x32 grid, written out so the favicon is a deliberate drawing and not an
# accident of a resampling filter. Two rows of the caret are doubled because a
# 1px diagonal disappears at this size.
def render_pixel():
    img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    px = img.load()

    def fill(x0, y0, x1, y1, c):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                if 0 <= x < 32 and 0 <= y < 32:
                    px[x, y] = c

    # Container: a square with its four corners nibbled to a 7px radius.
    r = 7
    for y in range(32):
        for x in range(32):
            cx = r - 0.5 if x < r else (32 - r - 0.5 if x >= 32 - r else x)
            cy = r - 0.5 if y < r else (32 - r - 0.5 if y >= 32 - r else y)
            if math.hypot(x - cx, y - cy) <= r - 0.5 + 0.5:
                px[x, y] = FIELD

    # Bubble + tail, drawn twice: once shifted for the hard shadow, once solid.
    def bubble(dx, dy, c):
        fill(4 + dx, 7 + dy, 28 + dx, 20 + dy, c)      # body, minus the corner nibs
        fill(5 + dx, 6 + dy, 27 + dx, 21 + dy, c)
        for i in range(5):                              # tail: a 5-step stair
            fill(9 + dx, 20 + dy + i, 16 - int(1.5 * i) + dx, 21 + dy + i, c)

    bubble(1, 1, SHADE)
    bubble(0, 0, SCREEN)

    # > caret: 2px thick, 8 rows tall.
    for i in range(4):
        fill(10 + i, 9 + i, 12 + i, 11 + i, INK)
        fill(10 + i, 16 - i, 12 + i, 18 - i, INK)
    # Block cursor.
    fill(18, 9, 22, 18, CURSOR)
    return img


# ==================================================================== main ===
def write_svg(path):
    """Same mark as geometry, for rel=icon type=image/svg+xml."""
    x0, y0, x1, y1 = BUB
    ym = (GLYPH_TOP + GLYPH_BOT) / 2
    hexof = lambda c: "#%02X%02X%02X" % c[:3]
    tail = " ".join("%g,%g" % p for p in TAIL)
    bub = lambda dx, dy, c: (
        f'<rect x="{x0 + dx}" y="{y0 + dy}" width="{x1 - x0}" height="{y1 - y0}" '
        f'rx="{R_BUB}" fill="{hexof(c)}"/>'
        f'<polygon points="{" ".join("%g,%g" % (p[0] + dx, p[1] + dy) for p in TAIL)}" fill="{hexof(c)}"/>'
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="PlumiChat">
  <rect width="32" height="32" rx="{R_OUT}" fill="{hexof(FIELD)}"/>
  {bub(SHADOW_OFF, SHADOW_OFF, SHADE)}
  {bub(0, 0, SCREEN)}
  <polyline points="{CHEV_X0},{GLYPH_TOP} {CHEV_X1},{ym} {CHEV_X0},{GLYPH_BOT}" fill="none"
    stroke="{hexof(INK)}" stroke-width="{CHEV_W}" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="{CUR[0]}" y="{CUR[1]}" width="{CUR[2] - CUR[0]}" height="{CUR[3] - CUR[1]}" fill="{hexof(CURSOR)}"/>
</svg>
"""
    with open(path, "w") as f:
        f.write(svg)


def flatten(img, bg=FIELD):
    """Opaque copy -- iOS paints BLACK behind any transparency in a touch icon."""
    out = Image.new("RGB", img.size, bg[:3])
    out.paste(img, mask=img.split()[3])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public")
    ap.add_argument("--sheet", action="store_true", help="also write a contact sheet to /tmp")
    a = ap.parse_args()
    out = a.out
    os.makedirs(out, exist_ok=True)

    # Rounded, transparent-cornered: browser tabs, bookmarks, manifest "any".
    render_pixel().save(os.path.join(out, "favicon-32.png"))
    render_vector(100).save(os.path.join(out, "favicon-100.png"))
    render_vector(512).save(os.path.join(out, "favicon-512.png"))

    # iOS / macOS home screen: FULL BLEED and OPAQUE. The system applies its own
    # squircle; a pre-rounded icon donates its transparent corners to black.
    flatten(render_vector(180, rounded=False)).save(os.path.join(out, "apple-touch-icon.png"))

    # Android adaptive: full bleed, artwork inside the 80% safe circle.
    flatten(render_vector(512, rounded=False, content_scale=0.78)).save(
        os.path.join(out, "maskable-512.png"))

    # Multi-size .ico so a bare /favicon.ico request is answered.
    ico = render_pixel()
    ico.save(os.path.join(out, "favicon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48)])

    write_svg(os.path.join(out, "icon.svg"))

    if a.sheet:
        sheet = Image.new("RGB", (1120, 560), (30, 27, 22))
        x = 24
        for size in (512, 180, 100, 64, 48, 32, 16):
            im = render_pixel().resize((size, size), Image.NEAREST) if size <= 32 else render_vector(size)
            sheet.paste(flatten(im, (30, 27, 22)), (x, 24 + (512 - size) // 2))
            x += size + 24
        sheet.save("/tmp/plumichat-icons.png")
        print("sheet -> /tmp/plumichat-icons.png")

    for f in sorted(os.listdir(out)):
        if f.startswith(("favicon", "apple-touch", "maskable", "icon.svg")):
            print(" ", f, os.path.getsize(os.path.join(out, f)), "bytes")


if __name__ == "__main__":
    main()
