// Detects the real type of an uploaded file from its first bytes. The client's file name and declared
// content type are never trusted. Returns { mime, ext } or null when the bytes are not an accepted format.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffDocument(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  // PDF: "%PDF-" must open the file (some writers put up to 1 KB of junk first, which we deliberately refuse).
  if (buf.length >= 8 && buf.toString('latin1', 0, 5) === '%PDF-' && /^\d\.\d/.test(buf.toString('latin1', 5, 8))) {
    return { mime: 'application/pdf', ext: 'pdf' };
  }
  return null;
}

module.exports = { sniffDocument };
