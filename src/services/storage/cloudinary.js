const { v2: cloudinary } = require('cloudinary');
const path = require('path');

const config = require('../../config/env');

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (!cloudName || !apiKey || !apiSecret) {
  throw new Error('Missing Cloudinary environment variables');
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
  secure: true,
});

// Convert uploaded URL back to its Cloudinary public ID.
function getPublicId(url) {
  try {
    const parsed = new URL(url);

    if (
      parsed.hostname !== 'res.cloudinary.com' ||
      parsed.pathname.split('/')[1] !== cloudName
    ) {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    const uploadIndex = parts.indexOf('upload');

    if (uploadIndex === -1) return null;

    const versionIndex = parts.findIndex(
      (part, index) =>
        index > uploadIndex && /^v\d+$/.test(part)
    );

    if (versionIndex === -1) return null;

    const publicId = parts.slice(versionIndex + 1).join('/');

    return publicId.replace(/\.[^/.]+$/, '') || null;
  } catch {
    return null;
  }
}

function create() {
  return {
    async save({ key, buffer }) {
      if (!key || !Buffer.isBuffer(buffer)) {
        throw new Error('Invalid image upload data');
      }

      const publicId = key
        .replace(/\\/g, '/')
        .replace(/\.[^/.]+$/, '');

      if (
        publicId.startsWith('/') ||
        publicId.split('/').some(part => !part || part === '.' || part === '..')
      ) {
        throw new Error('Invalid image storage key');
      }

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            public_id: publicId,
            resource_type: 'image',
            overwrite: false,
            unique_filename: false,
            use_filename: false,
          },
          (error, uploaded) => {
            if (error) return reject(error);
            resolve(uploaded);
          }
        );

        stream.end(buffer);
      });

      return {
        url: result.secure_url,
        key: publicId,
      };
    },

    keyFromUrl(url) {
      return getPublicId(url);
    },

    async removeByUrl(url) {
      const publicId = getPublicId(url);

      if (!publicId) return false;

      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: 'image',
        invalidate: true,
      });

      return result.result === 'ok';
    },
  };
}

module.exports = create();