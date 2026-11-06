import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

/**
 * A mokuro volume built in memory — a `.cbz` of solid-colour PNG pages and its
 * `.mokuro` with one vertical text block per page — for specs that cannot reach
 * the app's modules (a production build has no `/src/...` to import) and must
 * import through the real upload modal. No ImageMagick or `zip` needed.
 */

export interface SyntheticVolume {
  dir: string;
  cbz: string;
  mokuro: string;
  seriesTitle: string;
  seriesUuid: string;
  volumeUuid: string;
  /** The OCR text on every page. */
  text: string;
  /** The pages' colour, `[r, g, b]`. */
  colour: [number, number, number];
}

const WIDTH = 600;
const HEIGHT = 900;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A truecolour PNG filled with one colour. */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** A ZIP of deflated entries (what a real `.cbz` usually is). */
export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Write `<title> 01.cbz` and its `.mokuro` (same basename) to a fresh temp dir. */
export function writeSyntheticVolume(
  seriesTitle = 'CspTest',
  pages = 3,
  colour: [number, number, number] = [216, 240, 255]
): SyntheticVolume {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-volume-'));
  const volumeTitle = `${seriesTitle} 01`;
  const seriesUuid = '7a1f0c52-3b8e-4d6a-9c11-5e2f8b7d4a01';
  const volumeUuid = '7a1f0c52-3b8e-4d6a-9c11-5e2f8b7d4a02';
  const text = 'テスト';
  const names = Array.from({ length: pages }, (_, i) => `${String(i + 1).padStart(3, '0')}.png`);
  const png = solidPng(WIDTH, HEIGHT, colour);

  const cbz = join(dir, `${volumeTitle}.cbz`);
  writeFileSync(cbz, zip(names.map((name) => ({ name, data: png }))));

  const mokuro = join(dir, `${volumeTitle}.mokuro`);
  writeFileSync(
    mokuro,
    JSON.stringify({
      version: '0.2.1',
      title: seriesTitle,
      title_uuid: seriesUuid,
      volume: volumeTitle,
      volume_uuid: volumeUuid,
      chars: text.length * pages,
      pages: names.map((img_path) => ({
        version: '0.2.1',
        img_width: WIDTH,
        img_height: HEIGHT,
        img_path,
        blocks: [
          {
            box: [260, 120, 340, 420],
            vertical: true,
            font_size: 72,
            lines: [text],
            lines_coords: [
              [
                [264, 130],
                [336, 130],
                [336, 410],
                [264, 410]
              ]
            ]
          }
        ]
      }))
    })
  );

  return { dir, cbz, mokuro, seriesTitle, seriesUuid, volumeUuid, text, colour };
}
