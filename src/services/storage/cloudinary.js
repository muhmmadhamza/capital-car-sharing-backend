// 





const { v2: cloudinary } = require('cloudinary');
const config = require('../../config/env');

const cloudName = config.upload.cloudinary.cloudName;
const apiKey = config.upload.cloudinary.apiKey;
const apiSecret = config.upload.cloudinary.apiSecret;

if (!cloudName || !apiKey || !apiSecret) {
  throw new Error('Missing Cloudinary environment variables');
}

// Configure Cloudinary
cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
  secure: true,
});

// Convert Cloudinary URL into public ID.
function getPublicId(url) {
  try {
    if (typeof url !== 'string') return null;

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

    const publicId = parts
      .slice(versionIndex + 1)
      .join('/');

    return publicId.replace(/\.[^/.]+$/, '') || null;

  } catch {
    return null;
  }
}

function create() {
  return {
    name: 'cloudinary',

    // Upload image to Cloudinary
    async save({ key, buffer }) {
      if (!key || !Buffer.isBuffer(buffer)) {
        throw new Error('Invalid image upload data');
      }

      const publicId = key
        .replace(/\\/g, '/')
        .replace(/\.[^/.]+$/, '');

      if (
        publicId.startsWith('/') ||
        publicId.split('/').some(
          part => !part || part === '.' || part === '..'
        )
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
            if (error) {
              console.error('Cloudinary upload error:', {
                message: error.message,
                http_code: error.http_code,
              });

              return reject(error);
            }

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

    // Extract storage key from Cloudinary URL
    keyFromUrl(url) {
      return getPublicId(url);
    },

    // Delete image from Cloudinary
    async removeByUrl(url) {
      const publicId = getPublicId(url);

      if (!publicId) return false;

      const result = await cloudinary.uploader.destroy(
        publicId,
        {
          resource_type: 'image',
          invalidate: true,
        }
      );

      return result.result === 'ok';
    },
  };
}

module.exports = create();
