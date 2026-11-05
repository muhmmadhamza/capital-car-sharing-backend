const v = require('../utils/validators');
const { rangeProblem } = require('../services/availability.service');
const { ENUMS } = v;

const body = (req) => req.body || {};
const has = (o, k) => o[k] !== undefined && o[k] !== null;

const IMAGE_RE = /^(https?:\/\/|\/)[^\s]+$/i;
const PHONE_RE = /^[0-9+()\-\s]{7,30}$/;

const idParam = (name = 'id') => (req) =>
  /^\d+$/.test(req.params[name]) && Number(req.params[name]) > 0 ? [] : [`Invalid ${name}`];

const register = (req) => {
  const b = body(req);
  const e = [];
  if (!v.isNonEmpty(b.name, 120)) e.push('Name is required');
  if (!v.isEmail(b.email)) e.push('A valid email is required');
  if (!v.isStrongPassword(b.password)) e.push('Password must be 8-72 characters and include a letter and a number');
  if (has(b, 'phone') && b.phone !== '' && !PHONE_RE.test(b.phone)) e.push('Phone number is invalid');
  if (has(b, 'role') && !['customer', 'partner'].includes(b.role)) e.push('Role must be customer or partner');
  if (b.role === 'partner' && !v.isNonEmpty(b.companyName, 160)) e.push('Company name is required for partners');
  return e;
};

const login = (req) => {
  const b = body(req);
  const e = [];
  if (!v.isEmail(b.email)) e.push('A valid email is required');
  if (typeof b.password !== 'string' || !b.password) e.push('Password is required');
  return e;
};

const forgotPassword = (req) => (v.isEmail(body(req).email) ? [] : ['A valid email is required']);

const resetPassword = (req) => {
  const b = body(req);
  const e = [];
  if (typeof b.token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(b.token)) e.push('This reset link is invalid or has expired');
  if (!v.isStrongPassword(b.password)) e.push('Password must be 8-72 characters and include a letter and a number');
  return e;
};

const profile = (req) => {
  const b = body(req);
  const e = [];
  if (has(b, 'name') && !v.isNonEmpty(b.name, 120)) e.push('Name cannot be empty');
  if (has(b, 'phone') && b.phone !== '' && !PHONE_RE.test(b.phone)) e.push('Phone number is invalid');
  if (has(b, 'avatar') && (typeof b.avatar !== 'string' || b.avatar.length > 2000)) e.push('Avatar is invalid');
  if (has(b, 'companyName') && !v.isNonEmpty(b.companyName, 160)) e.push('Company name cannot be empty');
  if (has(b, 'address') && typeof b.address !== 'string') e.push('Address must be text');
  return e;
};

const car = (isUpdate) => (req) => {
  const b = body(req);
  const e = [];
  const required = (key, test, msg) => {
    if (!has(b, key)) { if (!isUpdate) e.push(msg); return; }
    if (!test(b[key])) e.push(msg);
  };

  required('make', (x) => v.isNonEmpty(x, 80), 'Make is required');
  required('model', (x) => v.isNonEmpty(x, 80), 'Model is required');
  required('year', (x) => v.isIntInRange(x, 1990, new Date().getFullYear() + 1), 'Year is invalid');
  required('type', (x) => ENUMS.carTypes.includes(x), `Type must be one of: ${ENUMS.carTypes.join(', ')}`);
  required('seats', (x) => v.isIntInRange(x, 1, 20), 'Seats must be between 1 and 20');
  required('doors', (x) => v.isIntInRange(x, 1, 10), 'Doors must be between 1 and 10');
  required('transmission', (x) => ENUMS.transmissions.includes(x), 'Transmission must be Automatic or Manual');
  required('fuelType', (x) => ENUMS.fuelTypes.includes(x), `Fuel type must be one of: ${ENUMS.fuelTypes.join(', ')}`);
  required('dailyPrice', (x) => v.isPositiveNumber(x) && Number(x) <= 10000000, 'Daily price must be a positive number');
  required('location', (x) => v.isNonEmpty(x, 120), 'Location is required');

  if (has(b, 'description') && (typeof b.description !== 'string' || b.description.length > 5000))
    e.push('Description must be text up to 5000 characters');
  if (has(b, 'status') && !ENUMS.carStatuses.includes(b.status)) e.push('Status must be active or inactive');
  if (has(b, 'images')) {
    if (!Array.isArray(b.images) || b.images.length > 15 || !b.images.every((u) => typeof u === 'string' && IMAGE_RE.test(u)))
      e.push('Images must be an array (max 15) of http(s) URLs or site-relative paths');
  }
  if (has(b, 'features')) {
    if (!Array.isArray(b.features) || b.features.length > 40 || !b.features.every((f) => v.isNonEmpty(f, 100)))
      e.push('Features must be an array (max 40) of short text values');
  }
  return e;
};

const carSearch = (req) => {
  const q = req.query;
  const e = [];
  const { pickupDate, returnDate } = q;
  if ((pickupDate && !returnDate) || (!pickupDate && returnDate)) e.push('Provide both pickupDate and returnDate');
  if (pickupDate && !v.isDate(pickupDate)) e.push('pickupDate must be YYYY-MM-DD');
  if (returnDate && !v.isDate(returnDate)) e.push('returnDate must be YYYY-MM-DD');
  if (v.isDate(pickupDate) && v.isDate(returnDate) && v.daysBetween(pickupDate, returnDate) < 0)
    e.push('returnDate must be on or after pickupDate');
  ['minPrice', 'maxPrice'].forEach((k) => {
    if (q[k] !== undefined && (Number.isNaN(Number(q[k])) || Number(q[k]) < 0)) e.push(`${k} must be a non-negative number`);
  });
  if (q.minPrice !== undefined && q.maxPrice !== undefined && Number(q.minPrice) > Number(q.maxPrice))
    e.push('minPrice cannot be greater than maxPrice');
  if (q.seats !== undefined && !v.isIntInRange(q.seats, 1, 20)) e.push('seats must be between 1 and 20');
  return e;
};

const availabilityQuery = (req) => {
  const { startDate, endDate } = req.query;
  const e = [];
  if (startDate && !v.isDate(startDate)) e.push('startDate must be YYYY-MM-DD');
  if (endDate && !v.isDate(endDate)) e.push('endDate must be YYYY-MM-DD');
  if (!e.length && startDate && endDate) {
    const problem = rangeProblem(startDate, endDate);
    if (problem) e.push(problem);
  }
  return e;
};

const availabilityUpdate = (req) => {
  const b = body(req);
  const e = [];
  if (!Array.isArray(b.dates) || !b.dates.length || b.dates.length > 366 || !b.dates.every(v.isDate))
    e.push('dates must be a non-empty array (max 366) of YYYY-MM-DD values');
  if (!['available', 'unavailable'].includes(b.status)) e.push('status must be available or unavailable');
  return e;
};

module.exports = { idParam, register, login, forgotPassword, resetPassword, profile, car, carSearch, availabilityQuery, availabilityUpdate };
