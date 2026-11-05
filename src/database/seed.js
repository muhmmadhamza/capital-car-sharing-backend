require('dotenv').config();
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { pool } = require('./pool');

const PASSWORD = 'Password123!';

const fmt = (d) => d.toISOString().slice(0, 10);
const offset = (days) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
const range = (from, to) => {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(fmt(offset(i)));
  return out;
};
const img = (label, n) =>
  `https://placehold.co/960x600/0B1F3A/C9A227?text=${encodeURIComponent(label)}+${n}`;

const cars = [
  // partner 0 -> Lahore Premium Rentals
  { p: 0, make: 'Toyota', model: 'Corolla Altis', year: 2023, type: 'Sedan', seats: 5, doors: 4, trans: 'Automatic', fuel: 'Petrol', price: 8500, loc: 'Lahore', approval: 'approved',
    desc: 'Comfortable and fuel-efficient sedan, perfect for city and highway driving.',
    features: ['Air Conditioning', 'Bluetooth', 'Cruise Control', 'Reverse Camera', 'USB Charging'] },
  { p: 0, make: 'Toyota', model: 'Fortuner', year: 2022, type: 'SUV', seats: 7, doors: 5, trans: 'Automatic', fuel: 'Diesel', price: 21000, loc: 'Lahore', approval: 'approved',
    desc: 'Powerful 7-seater SUV for family trips and northern area tours.',
    features: ['4x4', 'Leather Seats', 'Sunroof', 'Air Conditioning', 'Reverse Camera', 'Bluetooth'] },
  { p: 0, make: 'Honda', model: 'Civic', year: 2022, type: 'Sedan', seats: 5, doors: 4, trans: 'Automatic', fuel: 'Petrol', price: 10500, loc: 'Lahore', approval: 'approved',
    desc: 'Sporty and refined sedan with a premium interior.',
    features: ['Sunroof', 'Apple CarPlay', 'Lane Assist', 'Air Conditioning', 'Keyless Entry'] },
  { p: 0, make: 'Suzuki', model: 'Alto', year: 2023, type: 'Hatchback', seats: 4, doors: 5, trans: 'Manual', fuel: 'Petrol', price: 4500, loc: 'Lahore', approval: 'approved',
    desc: 'Economical hatchback, great for daily city commuting.',
    features: ['Air Conditioning', 'Power Steering', 'USB Charging'] },
  { p: 0, make: 'Mercedes-Benz', model: 'E-Class', year: 2021, type: 'Luxury', seats: 5, doors: 4, trans: 'Automatic', fuel: 'Petrol', price: 38000, loc: 'Lahore', approval: 'pending',
    desc: 'Executive luxury sedan for weddings, business and special occasions.',
    features: ['Leather Seats', 'Panoramic Roof', 'Massage Seats', 'Premium Sound', 'Air Conditioning'] },
  // partner 1 -> Capital City Motors
  { p: 1, make: 'Kia', model: 'Sportage', year: 2023, type: 'SUV', seats: 5, doors: 5, trans: 'Automatic', fuel: 'Petrol', price: 14500, loc: 'Islamabad', approval: 'approved',
    desc: 'Modern crossover SUV with great comfort and technology.',
    features: ['Panoramic Sunroof', 'Apple CarPlay', 'Android Auto', 'Reverse Camera', 'Air Conditioning'] },
  { p: 1, make: 'Toyota', model: 'Prius', year: 2020, type: 'Sedan', seats: 5, doors: 4, trans: 'Automatic', fuel: 'Hybrid', price: 9000, loc: 'Islamabad', approval: 'approved',
    desc: 'Hybrid sedan with excellent mileage for long drives.',
    features: ['Hybrid Engine', 'Air Conditioning', 'Bluetooth', 'Reverse Camera'] },
  { p: 1, make: 'Toyota', model: 'Hiace Grand Cabin', year: 2021, type: 'Van', seats: 12, doors: 4, trans: 'Manual', fuel: 'Diesel', price: 18000, loc: 'Karachi', approval: 'approved',
    desc: 'Spacious 12-seater van for group travel and tours.',
    features: ['Air Conditioning', 'Luggage Space', 'Reclining Seats'] },
  { p: 1, make: 'Hyundai', model: 'Tucson', year: 2022, type: 'SUV', seats: 5, doors: 5, trans: 'Automatic', fuel: 'Petrol', price: 15500, loc: 'Karachi', approval: 'approved',
    desc: 'Stylish SUV with a smooth ride and spacious cabin.',
    features: ['Leather Seats', 'Sunroof', 'Cruise Control', 'Air Conditioning', 'Bluetooth'] },
  { p: 1, make: 'Honda', model: 'City', year: 2023, type: 'Sedan', seats: 5, doors: 4, trans: 'Automatic', fuel: 'Petrol', price: 7500, loc: 'Karachi', approval: 'approved',
    desc: 'Reliable compact sedan with low running costs.',
    features: ['Air Conditioning', 'Bluetooth', 'Reverse Camera', 'USB Charging'] },
];

async function seed() {
  if (config.nodeEnv === 'production') {
    throw new Error('Refusing to run the development seed in production.');
  }

  const hash = await bcrypt.hash(PASSWORD, 10);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE reservations, availability, car_features, car_images, cars, partners, users RESTART IDENTITY CASCADE'
    );

    const addUser = async (name, email, phone, role) =>
      (await client.query(
        `INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [name, email, phone, hash, role]
      )).rows[0].id;

    await addUser('Capital Admin', 'admin@capitalcarsharing.com', '+92 300 0000000', 'admin');

    const partnerDefs = [
      ['Ahmed Raza', 'partner1@capitalcarsharing.com', '+92 321 1111111', 'Lahore Premium Rentals', 'Gulberg III, Lahore'],
      ['Sara Khan', 'partner2@capitalcarsharing.com', '+92 333 2222222', 'Capital City Motors', 'F-7 Markaz, Islamabad'],
    ];
    const partnerIds = [];
    for (const [name, email, phone, company, address] of partnerDefs) {
      const uid = await addUser(name, email, phone, 'partner');
      const { rows } = await client.query(
        'INSERT INTO partners (user_id, company_name, address) VALUES ($1,$2,$3) RETURNING id',
        [uid, company, address]
      );
      partnerIds.push(rows[0].id);
    }

    const customerIds = [];
    for (const [name, email, phone] of [
      ['Ali Hassan', 'customer1@capitalcarsharing.com', '+92 301 3333333'],
      ['Fatima Noor', 'customer2@capitalcarsharing.com', '+92 302 4444444'],
      ['Usman Tariq', 'customer3@capitalcarsharing.com', '+92 303 5555555'],
    ]) customerIds.push(await addUser(name, email, phone, 'customer'));

    // Cars, images, features
    const carIds = [];
    for (const c of cars) {
      const { rows } = await client.query(
        `INSERT INTO cars (partner_id, make, model, year, type, seats, doors, transmission, fuel_type,
                           daily_price, location, description, status, approval_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13) RETURNING id`,
        [partnerIds[c.p], c.make, c.model, c.year, c.type, c.seats, c.doors, c.trans, c.fuel, c.price, c.loc, c.desc, c.approval]
      );
      const id = rows[0].id;
      carIds.push(id);
      for (let i = 1; i <= 3; i += 1) {
        await client.query('INSERT INTO car_images (car_id, image_url, sort_order) VALUES ($1,$2,$3)', [
          id, img(`${c.make} ${c.model}`, i), i - 1,
        ]);
      }
      for (const f of c.features) {
        await client.query('INSERT INTO car_features (car_id, feature_name) VALUES ($1,$2)', [id, f]);
      }
    }

    // Owner-blocked days for a few cars
    const blocks = { 0: range(12, 14), 1: range(20, 23), 5: range(8, 9), 8: range(15, 17) };
    for (const [idx, dates] of Object.entries(blocks)) {
      for (const d of dates) {
        await client.query(`INSERT INTO availability (car_id, date, status) VALUES ($1,$2,'unavailable')`, [carIds[idx], d]);
      }
    }

    // Reservations (carIdx, customerIdx, pickupOffset, returnOffset, status)
    const reservations = [
      [0, 0, -30, -27, 'completed'],
      [2, 0, -10, -8, 'completed'],
      [5, 1, -2, 2, 'active'],
      [1, 0, 4, 7, 'upcoming'],
      [8, 2, 10, 12, 'upcoming'],
      [6, 1, 3, 5, 'cancelled'],
    ];
    for (const [ci, cu, from, to, status] of reservations) {
      const car = cars[ci];
      const days = to - from + 1;
      await client.query(
        `INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, return_date,
                                   status, daily_price, total_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [customerIds[cu], partnerIds[car.p], carIds[ci], car.loc, fmt(offset(from)), fmt(offset(to)), status, car.price, car.price * days]
      );
      // Mirror live reservations into availability as 'booked'
      if (status === 'upcoming' || status === 'active') {
        for (const d of range(from, to)) {
          await client.query(
            `INSERT INTO availability (car_id, date, status) VALUES ($1,$2,'booked')
             ON CONFLICT (car_id, date) DO UPDATE SET status = 'booked'`,
            [carIds[ci], d]
          );
        }
      }
    }

    await client.query('COMMIT');
    console.log('Seed complete.\n');
    console.log(`Login password for every seeded user: ${PASSWORD}`);
    console.log('  admin    admin@capitalcarsharing.com');
    console.log('  partner  partner1@capitalcarsharing.com, partner2@capitalcarsharing.com');
    console.log('  customer customer1@capitalcarsharing.com, customer2@..., customer3@...');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
