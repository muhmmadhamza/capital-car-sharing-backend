const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// PRIVATE local-disk storage for identity documents.
//
// Unlike ./local.js (public car photos served by express.static) this driver:
//   - has no public URL at all: nothing here is ever mounted on the web server,
//   - refuses to start if its folder is the public upload folder or inside it (or the reverse),
//   - writes files with owner-only permissions and never overwrites,
//   - only hands bytes out through read(), which the authorized API endpoints call after their own checks.
//
// To move to cloud storage later (e.g. an S3 bucket with block-public-access and server-side encryption),
// implement the same four methods: save, read, remove, exists.
module.exports = function createPrivateStore({ rootDir, publicDir }) {
  const root = path.resolve(rootDir);
  if (publicDir) {
    const pub = path.resolve(publicDir);
    const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
    if (inside(root, pub) || inside(pub, root)) {
      throw new Error(
        `VERIFICATION_STORAGE_DIR (${root}) must be a different folder from the public upload folder (${pub}) and not inside it.`
      );
    }
  }

  // Resolves a key to a path and refuses anything that would leave the private folder.
  const resolveKey = (key) => {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_\-./]+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  };

  return {
    name: 'private-local',
    rootDir: root,

    /** Saves a Buffer under `key`. Never overwrites. */
    async save({ key, buffer }) {
      const full = resolveKey(key);
      await fsp.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await fsp.writeFile(full, buffer, { flag: 'wx', mode: 0o600 });
      return { key };
    },

    /** A readable stream for the file. Rejects with code ENOENT when it does not exist. */
    async read(key) {
      const full = resolveKey(key);
      const stat = await fsp.stat(full); // throws ENOENT early so the caller can answer 404 before sending headers
      return { stream: fs.createReadStream(full), size: stat.size };
    },

    async exists(key) {
      try {
        await fsp.access(resolveKey(key));
        return true;
      } catch {
        return false;
      }
    },

    /** Best-effort delete. A missing file is not an error. Never logs the key's contents. */
    async remove(key) {
      try {
        await fsp.unlink(resolveKey(key));
        return true;
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('Could not delete a private file:', err.code || err.message);
        return false;
      }
    },
  };
};
