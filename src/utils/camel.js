const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// Converts snake_case column names of a DB row to camelCase keys (shallow).
module.exports = function camelize(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out;
};
