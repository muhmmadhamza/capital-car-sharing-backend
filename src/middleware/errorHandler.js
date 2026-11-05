const { failure } = require('../utils/response');
const config = require('../config/env');

const notFoundHandler = (req, res) => failure(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  if (err.isOperational) return failure(res, err.message, err.statusCode, err.errors);

  if (err.type === 'entity.parse.failed') return failure(res, 'Invalid JSON body', 400);
  if (err.type === 'entity.too.large') return failure(res, 'Request body too large', 413);

  // PostgreSQL errors
  if (err.code === '23505') return failure(res, 'A record with these details already exists', 409);
  if (err.code === '23503') return failure(res, 'Related record does not exist or is still in use', 409);
  if (err.code === '22P02' || err.code === '22007' || err.code === '22008')
    return failure(res, 'Invalid value supplied', 400);

  console.error(err);
  const message = config.nodeEnv === 'production' ? 'Internal server error' : err.message;
  return failure(res, message, 500);
};

module.exports = { notFoundHandler, errorHandler };
