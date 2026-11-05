const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

// Streams a private identity document to an already-authorized caller.
// The content type comes from the database (it was set from the file's real bytes at upload), the file name is
// fixed by us, and the headers stop the browser from caching it, guessing a different type or running anything in it.
function sendDocument(res, { stream, size, mimeType, side }) {
  res.status(200);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', `inline; filename="verification-${side}.${EXT[mimeType] || 'bin'}"`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Referrer-Policy', 'no-referrer');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

module.exports = { sendDocument };
