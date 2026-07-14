"""
Generate clean PNG icons for the HoverSave extension.
A picture frame with a download arrow inside, on a blue→violet gradient.
Outputs icon16.png, icon48.png, icon128.png in the icons/ folder.
"""

import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), 'icons')
os.makedirs(OUT, exist_ok=True)


def gradient(size, top, bottom):
    """Vertical gradient background."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def draw_icon(size):
    # Render at 4x for cleaner antialiasing, downscale at the end
    s = size * 4
    canvas = gradient(s, (79, 157, 255), (124, 58, 237))  # blue -> violet
    draw = ImageDraw.Draw(canvas)

    # Picture frame: rounded rect, white stroke, hollow
    frame_pad = int(s * 0.18)
    frame_left = frame_pad
    frame_top = frame_pad
    frame_right = s - frame_pad
    frame_bottom = s - frame_pad

    # Sun (top-left)
    sun_cx = frame_left + int(s * 0.13)
    sun_cy = frame_top + int(s * 0.13)
    sun_r = int(s * 0.06)
    draw.ellipse((sun_cx - sun_r, sun_cy - sun_r, sun_cx + sun_r, sun_cy + sun_r), fill=(255, 255, 255, 230))

    # Mountains (two triangles) inside frame
    base_y = frame_bottom - int(s * 0.08)
    m1 = [
        (frame_left + int(s * 0.08), base_y),
        (frame_left + int(s * 0.30), frame_top + int(s * 0.32)),
        (frame_left + int(s * 0.50), base_y),
    ]
    m2 = [
        (frame_left + int(s * 0.32), base_y),
        (frame_left + int(s * 0.56), frame_top + int(s * 0.46)),
        (frame_left + int(s * 0.78), base_y),
    ]
    draw.polygon(m1, fill=(255, 255, 255, 180))
    draw.polygon(m2, fill=(255, 255, 255, 220))

    # Frame outline (drawn over mountains to be crisp)
    stroke = max(2, int(s * 0.04))
    draw.rounded_rectangle(
        (frame_left, frame_top, frame_right, frame_bottom),
        radius=int(s * 0.10),
        outline=(255, 255, 255, 255),
        width=stroke,
    )

    # Download arrow in a circular badge (bottom-right, overlapping the frame)
    badge_r = int(s * 0.18)
    badge_cx = frame_right - int(s * 0.05)
    badge_cy = frame_bottom - int(s * 0.05)
    draw.ellipse(
        (badge_cx - badge_r, badge_cy - badge_r,
         badge_cx + badge_r, badge_cy + badge_r),
        fill=(255, 255, 255, 255),
    )
    # Inner colored ring effect via slight inset
    inset = max(2, int(s * 0.012))
    draw.ellipse(
        (badge_cx - badge_r + inset, badge_cy - badge_r + inset,
         badge_cx + badge_r - inset, badge_cy + badge_r - inset),
        outline=(79, 157, 255, 255),
        width=max(2, int(s * 0.012)),
    )

    # Arrow shaft (vertical bar)
    arrow_cx = badge_cx
    shaft_w = int(s * 0.045)
    shaft_h = int(s * 0.13)
    shaft_top = badge_cy - int(s * 0.02)
    draw.rounded_rectangle(
        (arrow_cx - shaft_w // 2, shaft_top,
         arrow_cx + shaft_w // 2, shaft_top + shaft_h),
        radius=shaft_w // 2,
        fill=(79, 157, 255, 255),
    )
    # Arrow head (triangle)
    head_w = int(s * 0.085)
    head_h = int(s * 0.06)
    head_top = shaft_top + shaft_h - int(s * 0.01)
    head = [
        (arrow_cx - head_w, head_top),
        (arrow_cx + head_w, head_top),
        (arrow_cx, head_top + head_h),
    ]
    draw.polygon(head, fill=(79, 157, 255, 255))
    # Arrow baseline
    bar_w = int(s * 0.13)
    bar_h = int(s * 0.022)
    bar_y = badge_cy + int(s * 0.10)
    draw.rounded_rectangle(
        (arrow_cx - bar_w // 2, bar_y,
         arrow_cx + bar_w // 2, bar_y + bar_h),
        radius=bar_h // 2,
        fill=(79, 157, 255, 255),
    )

    # Rounded corners on the whole icon
    mask = rounded_mask(s, int(s * 0.20))
    out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), mask)

    # Downscale with high quality
    out = out.resize((size, size), Image.LANCZOS)
    return out


for size in (16, 48, 128):
    img = draw_icon(size)
    path = os.path.join(OUT, f'icon{size}.png')
    img.save(path, 'PNG', optimize=True)
    print(f'wrote {path} ({size}x{size})')

print('done.')
