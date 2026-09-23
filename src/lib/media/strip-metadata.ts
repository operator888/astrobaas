/**
 * Removing camera metadata from a retained original, without touching a pixel.
 *
 * ## Why this exists
 *
 * The upload path now KEEPS the file it was given, so a shop does not lose the
 * master copy of its own photograph. But an uploaded file is served from
 * /uploads at a content-addressed and therefore guessable URL, and a phone photo
 * carries an EXIF block with GPS coordinates, the device serial and the owner's
 * name. An optician photographing stock at home would be publishing their home
 * address with every product image — something the shop never chose to do and
 * would never find out about.
 *
 * Before originals were retained this could not happen: the old pipeline deleted
 * the raw upload after re-encoding, and the re-encode dropped the metadata. The
 * exposure is created by keeping the file, so it has to be closed here.
 *
 * ## Why not just re-encode it
 *
 * Because that is not the same file any more. Re-encoding a JPEG loses quality,
 * and the whole point of retaining the original is that it is the master copy.
 *
 * So this is a LOSSLESS container edit: it removes whole metadata segments and
 * copies the compressed image data through byte for byte. Decode the result and
 * the pixels are identical — the tests assert exactly that.
 *
 * ## What is deliberately kept
 *
 * ICC colour profiles (JPEG APP2, PNG iCCP). Dropping those changes how the
 * image LOOKS, which is a visible regression on a product photo, and they say
 * nothing about the photographer.
 */

export interface StripResult {
  buf: Buffer;
  /** Bytes removed. Zero means there was nothing to remove. */
  removed: number;
  /** Which segments/chunks went, for the log and for the tests. */
  dropped: string[];
}

/**
 * JPEG: drop APP1 (EXIF and XMP) and APP13 (IPTC/Photoshop), plus comments.
 *
 * Everything up to the Start Of Scan is a sequence of length-prefixed segments,
 * so they can be dropped by copying around them. From SOS onwards the bytes are
 * entropy-coded image data, copied verbatim to the end.
 */
function stripJpeg(buf: Buffer): StripResult {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { buf, removed: 0, dropped: [] };
  }
  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  const dropped: string[] = [];
  let i = 2;

  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) break; // Not a marker where one is required: stop editing.
    const marker = buf[i + 1];

    // Start of Scan: the rest of the file is image data.
    if (marker === 0xda) {
      out.push(buf.subarray(i));
      i = buf.length;
      break;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }

    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) break; // Malformed: stop editing.
    const end = i + 2 + len;

    const isExifOrXmp = marker === 0xe1;  // APP1
    const isPhotoshop = marker === 0xed;  // APP13, IPTC
    const isComment = marker === 0xfe;    // COM
    if (isExifOrXmp || isPhotoshop || isComment) {
      dropped.push(isExifOrXmp ? 'APP1' : isPhotoshop ? 'APP13' : 'COM');
    } else {
      // Everything else is kept, INCLUDING APP0 (JFIF) and APP2 (ICC profile):
      // dropping a colour profile changes how the product photo looks.
      out.push(buf.subarray(i, end));
    }
    i = end;
  }
  if (i < buf.length) out.push(buf.subarray(i));

  const result = Buffer.concat(out);
  return { buf: result, removed: buf.length - result.length, dropped };
}

/** PNG chunk types that carry metadata rather than image data. */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/**
 * PNG: drop the metadata chunks.
 *
 * Each chunk carries its own CRC over its own bytes, so removing whole chunks
 * leaves every remaining CRC valid. iCCP is kept, for the same reason as APP2.
 */
function stripPng(buf: Buffer): StripResult {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    return { buf, removed: 0, dropped: [] };
  }
  const out: Buffer[] = [buf.subarray(0, 8)];
  const dropped: string[] = [];
  let i = 8;

  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + len; // length + type + data + crc
    if (len > buf.length || end > buf.length) break; // Malformed: stop editing.

    if (PNG_DROP.has(type)) dropped.push(type);
    else out.push(buf.subarray(i, end));

    i = end;
    if (type === 'IEND') break;
  }
  if (i < buf.length) out.push(buf.subarray(i));

  const result = Buffer.concat(out);
  return { buf: result, removed: buf.length - result.length, dropped };
}

/**
 * WebP: drop the EXIF and XMP chunks from the RIFF container.
 *
 * A phone camera does not produce WebP — but this pipeline does, and the upload
 * route has an explicit comment about re-uploading a previously downloaded
 * asset, so a WebP that has been round-tripped through some other tool and
 * picked up metadata is a real input rather than a theoretical one.
 *
 * Two things have to be right or the file is corrupt: the RIFF length prefix,
 * and the VP8X feature flags whose EXIF/XMP bits would otherwise advertise
 * chunks that are no longer there.
 */
function stripWebp(buf: Buffer): StripResult {
  if (
    buf.length < 16
    || buf.toString('ascii', 0, 4) !== 'RIFF'
    || buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return { buf, removed: 0, dropped: [] };
  }
  const kept: Buffer[] = [];
  const dropped: string[] = [];
  let i = 12;

  while (i + 8 <= buf.length) {
    const type = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    // Chunks are padded to an even length; the pad byte is not counted in size.
    const end = i + 8 + size + (size % 2);
    if (size > buf.length || end > buf.length) return { buf, removed: 0, dropped: [] };

    if (type === 'EXIF' || type === 'XMP ') {
      dropped.push(type.trim());
    } else {
      const chunk = Buffer.from(buf.subarray(i, end));
      if (type === 'VP8X' && chunk.length >= 9) {
        // Clear the EXIF (bit 3) and XMP (bit 2) flags in the feature byte, so
        // the header stops advertising chunks that are now gone.
        chunk[8] &= ~0b00001100;
      }
      kept.push(chunk);
    }
    i = end;
  }
  if (dropped.length === 0) return { buf, removed: 0, dropped: [] };

  const body = Buffer.concat(kept);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0, 'ascii');
  // The RIFF size counts everything after this field: 'WEBP' plus the chunks.
  out.writeUInt32LE(4 + body.length, 4);
  out.write('WEBP', 8, 'ascii');
  body.copy(out, 12);
  return { buf: out, removed: buf.length - out.length, dropped };
}

/**
 * Remove camera metadata, losslessly, from the formats that carry it.
 *
 * GIF is returned unchanged: it has no EXIF block, and its comment extension is
 * not something a camera writes.
 *
 * Never throws. A file this cannot parse is returned exactly as it arrived: a
 * retained original with its metadata still in it is a smaller problem than an
 * upload that fails.
 */
export function stripImageMetadata(buf: Buffer, format: string): StripResult {
  try {
    if (format === 'jpeg' || format === 'image/jpeg') return stripJpeg(buf);
    if (format === 'png' || format === 'image/png') return stripPng(buf);
    if (format === 'webp' || format === 'image/webp') return stripWebp(buf);
  } catch {
    // Fall through to returning the input untouched.
  }
  return { buf, removed: 0, dropped: [] };
}

/**
 * Whether to do it at all.
 *
 * On by default. `MEDIA_ORIGINAL_EXIF=keep` retains the file byte for byte, for
 * a shop that needs the capture metadata — a studio workflow, a copyright claim
 * — and accepts that it is published.
 */
export function shouldStripOriginalMetadata(): boolean {
  return String(process.env.MEDIA_ORIGINAL_EXIF ?? '').trim().toLowerCase() !== 'keep';
}
