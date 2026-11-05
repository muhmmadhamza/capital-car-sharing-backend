const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const isDate = (v) => {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const isStrongPassword = (v) =>
  typeof v === 'string' && v.length >= 8 && v.length <= 72 && /[A-Za-z]/.test(v) && /\d/.test(v);

const isNonEmpty = (v, max = 255) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;

const isPositiveNumber = (v) => v !== '' && v !== null && !Number.isNaN(Number(v)) && Number(v) > 0;

const isIntInRange = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;

const daysBetween = (start, end) =>
  Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000);

const ENUMS = {
  carTypes: ['Sedan', 'SUV', 'Hatchback', 'Luxury', 'Van', 'Coupe', 'Convertible', 'Pickup'],
  transmissions: ['Automatic', 'Manual'],
  fuelTypes: ['Petrol', 'Diesel', 'Hybrid', 'Electric', 'CNG'],
  carStatuses: ['active', 'inactive'],
};

module.exports = {
  isEmail,
  isDate,
  isStrongPassword,
  isNonEmpty,
  isPositiveNumber,
  isIntInRange,
  daysBetween,
  ENUMS,
};
