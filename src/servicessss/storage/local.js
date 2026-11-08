const fs = require('fs/promises');
const path = require('path');

// Local-disk driver. Files live under `rootDir` and are served by express.static at `${publicBaseUrl}/uploads/<key>`.
// Every other driver (S3, GCS, ...) must expose the same three methods.
module.exports = function createLocalDriver({ rootDir, publicBaseUrl }) {
  const urlPrefix = `${publicBaseUrl}/uploads/`;

  // Resolves a key to a path and refuses anything that would leave rootDir.
  const resolveKey = (key) => {
    const full = path.resolve(rootDir, key);
    if (full !== rootDir && !full.startsWith(rootDir + path.sep)) throw new Error('Invalid storage key');
    return full;
  };

  return {
    name: 'local',
    rootDir,
    urlPrefix,

    /** Saves a Buffer under `key` and returns its public URL. */
    async save({ key, buffer }) {
      const full = resolveKey(key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buffer, { flag: 'wx', mode: 0o644 }); // 'wx': never overwrite
      return { key, url: urlPrefix + key };
    },

    /** The storage key for a URL this driver produced, or null for any other URL. */
    keyFromUrl(url) {
      if (typeof url !== 'string' || !url.startsWith(urlPrefix)) return null;
      const key = url.slice(urlPrefix.length);
      return key && !key.includes('..') && !key.includes('\\') ? key : null;
    },

    /** Best-effort delete of the file behind a URL. Unknown URLs are ignored. */
    async removeByUrl(url) {
      const key = this.keyFromUrl(url);
      if (!key) return;
      try {
        await fs.unlink(resolveKey(key));
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('Could not delete uploaded file:', err.message);
      }
    },
  };
};
