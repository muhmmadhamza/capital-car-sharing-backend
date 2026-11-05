const { unprocessable } = require('../utils/errors');

// validate((req) => ['error message', ...])  -> 422 when the returned list is non-empty
const validate = (rules) => (req, _res, next) => {
  const errors = rules(req) || [];
  if (errors.length) return next(unprocessable(errors[0], errors));
  next();
};

module.exports = validate;
