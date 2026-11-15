# SPDX-License-Identifier: AGPL-3.0-or-later
"""Spike S2 (THROWAWAY): writes the 2 plain home-screen icons (teal square, white bar) with the
standard library only. Run: python3 apps/web/spike/s2/make-icons.py"""
import struct
import sys
import zlib
from pathlib import Path


def png(size: int) -> bytes:
    teal, white = b"\x0b\x6e\x6e", b"\xff\xff\xff"
    lo, hi = size * 3 // 8, size * 5 // 8
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")
        for x in range(size):
            row += white if lo <= y < hi and size // 5 <= x < size * 4 // 5 else teal
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "public")
    for s in (192, 512):
        (out / f"icon-{s}.png").write_bytes(png(s))
        print(f"icon-{s}.png")
