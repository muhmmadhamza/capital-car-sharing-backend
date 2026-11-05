class AppError extends Error {
  constructor(message, statusCode = 500, errors) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
  }
}

const badRequest = (m, errors) => new AppError(m, 400, errors);
const unauthorized = (m = 'Authentication required') => new AppError(m, 401);
const forbidden = (m = 'You do not have permission to perform this action') => new AppError(m, 403);
const notFound = (m = 'Resource not found') => new AppError(m, 404);
const conflict = (m) => new AppError(m, 409);
const unprocessable = (m, errors) => new AppError(m, 422, errors);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, unprocessable };
