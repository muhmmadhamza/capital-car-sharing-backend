const { query, withTransaction } = require('../database/pool');
const { notFound, conflict, badRequest, forbidden } = require('../utils/errors');
const config = require('../config/env');
const storage = require('./storage');
const availability = require('./availability.service');

// Shared SELECT: car + images[] + features[] + partner company name
const CAR_SELECT = `
  SELECT c.id, c.partner_id, c.make, c.model, c.year, c.type, c.seats, c.doors, c.transmission,
         c.fuel_type, c.daily_price, c.location, c.description, c.status, c.approval_status,
         c.created_at, c.updated_at,
         p.company_name AS partner_company_name,
         COALESCE((SELECT json_agg(ci.image_url ORDER BY ci.sort_order, ci.id)
                   FROM car_images ci WHERE ci.car_id = c.id), '[]'::json) AS images,
         COALESCE((SELECT json_agg(cf.feature_name ORDER BY cf.id)
                   FROM car_features cf WHERE cf.car_id = c.id), '[]'::json) AS features
  FROM cars c
  JOIN partners p ON p.id = c.partner_id`;

const SORTS = {
  newest: 'c.created_at DESC, c.id DESC',
  price_asc: 'c.daily_price ASC, c.id ASC',
  price_desc: 'c.daily_price DESC, c.id ASC',
  year_desc: 'c.year DESC, c.id ASC',
};

// ---------- Public ----------
async function searchCars(filters = {}) {
  const where = [`c.status = 'active'`, `c.approval_status = 'approved'`, `p.status = 'active'`];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  const list = (v) =>
    [].concat(v ?? [])
      .flatMap((x) => String(x).split(','))
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  const addAny = (sql, values) => {
    if (!values.length) return;
    params.push(values);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.location) add('c.location ILIKE ?', `%${filters.location}%`);
  if (filters.carType) add('LOWER(c.type) = LOWER(?)', filters.carType);
  if (filters.minPrice !== undefined) add('c.daily_price >= ?', Number(filters.minPrice));
  if (filters.maxPrice !== undefined) add('c.daily_price <= ?', Number(filters.maxPrice));
  if (filters.seats !== undefined) add('c.seats >= ?', Number(filters.seats));
  if (filters.transmission) add('LOWER(c.transmission) = LOWER(?)', filters.transmission);
  if (filters.fuelType) add('LOWER(c.fuel_type) = LOWER(?)', filters.fuelType);

  // Exclude cars that are blocked/booked anywhere in the requested range
  if (filters.pickupDate && filters.returnDate) {
    params.push(filters.pickupDate, filters.returnDate);
    const a = `$${params.length - 1}`;
    const b = `$${params.length}`;
    where.push(`NOT EXISTS (
      SELECT 1 FROM availability av
      WHERE av.car_id = c.id AND av.status IN ('unavailable', 'booked') AND av.date BETWEEN ${a}::date AND ${b}::date)`);
    where.push(`NOT EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.car_id = c.id AND r.status IN ('pending', 'confirmed')
        AND r.pickup_date <= ${b}::date AND r.return_date >= ${a}::date)`);
  }

  const page = Math.max(parseInt(filters.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 12, 1), 50);
  const orderBy = SORTS[filters.sort] || SORTS.newest;
  const whereSql = where.join(' AND ');

  const countRes = await query(
    `SELECT COUNT(*) AS total FROM cars c JOIN partners p ON p.id = c.partner_id WHERE ${whereSql}`,
    params
  );
  const total = countRes.rows[0].total;

  const { rows } = await query(
    `${CAR_SELECT} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params
  );

  return { cars: rows, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function getPublicCar(id) {
  const { rows } = await query(
    `${CAR_SELECT}
     WHERE c.id = $1 AND c.status = 'active' AND c.approval_status = 'approved' AND p.status = 'active'`,
    [id]
  );
  if (!rows[0]) throw notFound('Car not found');
  return rows[0];
}

async function carIsPublic(id) {
  const { rowCount } = await query(
    `SELECT 1 FROM cars c JOIN partners p ON p.id = c.partner_id
     WHERE c.id = $1 AND c.status = 'active' AND c.approval_status = 'approved' AND p.status = 'active'`,
    [id]
  );
  return rowCount > 0;
}

// ---------- Partner-owned ----------
// Adds availabilityToday { date, status } to partner-owned cars, read from the same availability data as the
// calendar. It says nothing about approval: a pending car can be 'available' today and is still pending.
async function withTodayAvailability(rows) {
  const { date, byCar } = await availability.getTodayStatuses(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, availabilityToday: { date, status: byCar.get(r.id) ?? 'available' } }));
}

async function listPartnerCars(partnerId) {
  const { rows } = await query(`${CAR_SELECT} WHERE c.partner_id = $1 ORDER BY c.created_at DESC, c.id DESC`, [
    partnerId,
  ]);
  return withTodayAvailability(rows);
}

async function getPartnerCar(partnerId, carId) {
  const { rows } = await query(`${CAR_SELECT} WHERE c.id = $1 AND c.partner_id = $2`, [carId, partnerId]);
  if (!rows[0]) throw notFound('Car not found'); // also hides other partners' cars
  return (await withTodayAvailability(rows))[0];
}

async function writeImagesAndFeatures(q, carId, images, features) {
  if (images) {
    await q('DELETE FROM car_images WHERE car_id = $1', [carId]);
    for (let i = 0; i < images.length; i += 1) {
      await q('INSERT INTO car_images (car_id, image_url, sort_order) VALUES ($1, $2, $3)', [carId, images[i], i]);
    }
  }
  if (features) {
    await q('DELETE FROM car_features WHERE car_id = $1', [carId]);
    for (const f of features) {
      await q('INSERT INTO car_features (car_id, feature_name) VALUES ($1, $2)', [carId, f.trim()]);
    }
  }
}

// Photos hosted by our own storage live under cars/<partnerId>/..., so a partner can only attach their own files.
function assertOwnUploads(partnerId, urls) {
  for (const url of urls || []) {
    const key = storage.keyFromUrl(url);
    if (key && !key.startsWith(`cars/${partnerId}/`)) throw forbidden('You can only use photos that you uploaded');
  }
}

// Saves an already stored file as the car's next photo. Ownership is checked by the caller's partnerId.
async function addPartnerCarImage(partnerId, carId, url) {
  const id = await withTransaction(async (q) => {
    const { rows: owned } = await q('SELECT id FROM cars WHERE id = $1 AND partner_id = $2 FOR UPDATE', [carId, partnerId]);
    if (!owned[0]) throw notFound('Car not found');
    const { rows: stats } = await q('SELECT COUNT(*)::int AS n, COALESCE(MAX(sort_order), -1) AS top FROM car_images WHERE car_id = $1', [carId]);
    if (stats[0].n >= config.upload.maxImagesPerCar) {
      throw badRequest(`A car can have at most ${config.upload.maxImagesPerCar} photos`);
    }
    const { rows } = await q(
      'INSERT INTO car_images (car_id, image_url, sort_order) VALUES ($1, $2, $3) RETURNING id',
      [carId, url, stats[0].top + 1]
    );
    return rows[0].id;
  });
  return { id, car: await getPartnerCar(partnerId, carId) };
}

async function createPartnerCar(partnerId, d) {
  assertOwnUploads(partnerId, d.images);
  const carId = await withTransaction(async (q) => {
    const { rows } = await q(
      `INSERT INTO cars (partner_id, make, model, year, type, seats, doors, transmission, fuel_type,
                         daily_price, location, description, status, approval_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
       RETURNING id`,
      [
        partnerId, d.make.trim(), d.model.trim(), d.year, d.type, d.seats, d.doors, d.transmission,
        d.fuelType, d.dailyPrice, d.location.trim(), d.description || null, d.status || 'active',
      ]
    );
    await writeImagesAndFeatures(q, rows[0].id, d.images || [], d.features || []);
    return rows[0].id;
  });
  return getPartnerCar(partnerId, carId);
}

async function updatePartnerCar(partnerId, carId, d) {
  const before = await getPartnerCar(partnerId, carId); // ownership check
  assertOwnUploads(partnerId, d.images);

  await withTransaction(async (q) => {
    await q(
      `UPDATE cars SET
         make = COALESCE($3, make), model = COALESCE($4, model), year = COALESCE($5, year),
         type = COALESCE($6, type), seats = COALESCE($7, seats), doors = COALESCE($8, doors),
         transmission = COALESCE($9, transmission), fuel_type = COALESCE($10, fuel_type),
         daily_price = COALESCE($11, daily_price), location = COALESCE($12, location),
         description = COALESCE($13, description), status = COALESCE($14, status),
         updated_at = NOW()
       WHERE id = $1 AND partner_id = $2`,
      [
        carId, partnerId, d.make?.trim() ?? null, d.model?.trim() ?? null, d.year ?? null, d.type ?? null,
        d.seats ?? null, d.doors ?? null, d.transmission ?? null, d.fuelType ?? null,
        d.dailyPrice ?? null, d.location?.trim() ?? null, d.description ?? null, d.status ?? null,
      ]
    );
    await writeImagesAndFeatures(q, carId, d.images, d.features);
  });
  // Photos the partner removed no longer need their file on disk
  if (d.images) {
    const kept = new Set(d.images);
    await Promise.all(before.images.filter((u) => !kept.has(u)).map((u) => storage.removeByUrl(u)));
  }
  return getPartnerCar(partnerId, carId);
}

async function deletePartnerCar(partnerId, carId) {
  const existing = await getPartnerCar(partnerId, carId);
  const { rowCount } = await query(
    `SELECT 1 FROM reservations WHERE car_id = $1 AND status IN ('pending', 'confirmed')`,
    [carId]
  );
  if (rowCount) throw conflict('This car has pending or confirmed reservations and cannot be deleted');

  try {
    await query('DELETE FROM cars WHERE id = $1 AND partner_id = $2', [carId, partnerId]);
  } catch (err) {
    // Past reservations still reference the car (ON DELETE RESTRICT) -> keep history, hide it instead
    if (err.code === '23503') {
      await query(`UPDATE cars SET status = 'inactive', updated_at = NOW() WHERE id = $1`, [carId]);
      return { deleted: false, deactivated: true };
    }
    throw err;
  }
  await Promise.all(existing.images.map((u) => storage.removeByUrl(u)));
  return { deleted: true };
}

// ---------- Admin ----------
async function listAllCars({ approvalStatus, partnerId, page, limit } = {}) {
  const params = [];
  const where = ['TRUE'];
  if (approvalStatus) { params.push(approvalStatus); where.push(`c.approval_status = $${params.length}`); }
  if (partnerId) { params.push(partnerId); where.push(`c.partner_id = $${params.length}`); }
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const whereSql = where.join(' AND ');

  const total = (await query(`SELECT COUNT(*) AS total FROM cars c WHERE ${whereSql}`, params)).rows[0].total;
  const { rows } = await query(
    `${CAR_SELECT} WHERE ${whereSql} ORDER BY c.created_at DESC, c.id DESC LIMIT ${lim} OFFSET ${(pg - 1) * lim}`,
    params
  );
  return { cars: rows, meta: { page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) } };
}

async function setApprovalStatus(carId, approvalStatus) {
  const { rows } = await query(
    'UPDATE cars SET approval_status = $2, updated_at = NOW() WHERE id = $1 RETURNING id',
    [carId, approvalStatus]
  );
  if (!rows[0]) throw notFound('Car not found');
  const { rows: full } = await query(`${CAR_SELECT} WHERE c.id = $1`, [carId]);
  return full[0];
}

module.exports = {
  searchCars, getPublicCar, carIsPublic,
  listPartnerCars, getPartnerCar, addPartnerCarImage, createPartnerCar, updatePartnerCar, deletePartnerCar,
  listAllCars, setApprovalStatus,
};
