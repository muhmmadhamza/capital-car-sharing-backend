const success = (res, data = {}, status = 200, meta) => {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
};

const failure = (res, message, status = 500, errors) => {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(status).json(body);
};

module.exports = { success, failure };
