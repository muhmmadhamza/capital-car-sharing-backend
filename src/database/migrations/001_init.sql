-- Capital Car Sharing - initial schema
-- Future modules (booking, payments, earnings) should be added as new numbered migrations.

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(254) NOT NULL,
  phone         VARCHAR(30),
  password_hash VARCHAR(100) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer', 'partner', 'admin')),
  avatar        TEXT,
  status        VARCHAR(20)  NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_users_email_unique ON users (LOWER(email));
CREATE INDEX idx_users_role   ON users (role);
CREATE INDEX idx_users_status ON users (status);

CREATE TABLE partners (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  company_name VARCHAR(160) NOT NULL,
  address      TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'active'
               CHECK (status IN ('pending', 'active', 'suspended')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_partners_status ON partners (status);

CREATE TABLE cars (
  id              SERIAL PRIMARY KEY,
  partner_id      INTEGER NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
  make            VARCHAR(80)  NOT NULL,
  model           VARCHAR(80)  NOT NULL,
  year            SMALLINT     NOT NULL CHECK (year BETWEEN 1990 AND 2100),
  type            VARCHAR(30)  NOT NULL,
  seats           SMALLINT     NOT NULL CHECK (seats BETWEEN 1 AND 20),
  doors           SMALLINT     NOT NULL CHECK (doors BETWEEN 1 AND 10),
  transmission    VARCHAR(20)  NOT NULL CHECK (transmission IN ('Automatic', 'Manual')),
  fuel_type       VARCHAR(20)  NOT NULL,
  daily_price     NUMERIC(12, 2) NOT NULL CHECK (daily_price > 0),
  location        VARCHAR(120) NOT NULL,
  description     TEXT,
  status          VARCHAR(20)  NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive')),
  approval_status VARCHAR(20)  NOT NULL DEFAULT 'pending'
                  CHECK (approval_status IN ('pending', 'approved', 'rejected', 'suspended')),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_cars_partner_id      ON cars (partner_id);
CREATE INDEX idx_cars_status          ON cars (status);
CREATE INDEX idx_cars_approval_status ON cars (approval_status);
CREATE INDEX idx_cars_location        ON cars (LOWER(location));
CREATE INDEX idx_cars_type            ON cars (type);
CREATE INDEX idx_cars_daily_price     ON cars (daily_price);

CREATE TABLE car_images (
  id         SERIAL PRIMARY KEY,
  car_id     INTEGER NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  image_url  TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_car_images_car_id ON car_images (car_id);

CREATE TABLE car_features (
  id           SERIAL PRIMARY KEY,
  car_id       INTEGER NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  feature_name VARCHAR(100) NOT NULL
);
CREATE INDEX idx_car_features_car_id ON car_features (car_id);

-- Explicit per-day overrides. A day with no row is treated as "available".
CREATE TABLE availability (
  id     SERIAL PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  date   DATE    NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'available'
         CHECK (status IN ('available', 'unavailable', 'booked')),
  UNIQUE (car_id, date)
);
CREATE INDEX idx_availability_car_date ON availability (car_id, date);
CREATE INDEX idx_availability_status   ON availability (status);

-- Structure only. The creation/booking workflow comes in a later module.
-- (That module should add a double-booking guard, e.g. a btree_gist EXCLUDE constraint
--  on (car_id, daterange(pickup_date, return_date, '[]')) for upcoming/active rows.)
CREATE TABLE reservations (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES users (id)    ON DELETE RESTRICT,
  partner_id      INTEGER NOT NULL REFERENCES partners (id) ON DELETE RESTRICT,
  car_id          INTEGER NOT NULL REFERENCES cars (id)     ON DELETE RESTRICT,
  pickup_location VARCHAR(160) NOT NULL,
  pickup_date     DATE NOT NULL,
  return_date     DATE NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'upcoming'
                  CHECK (status IN ('upcoming', 'active', 'completed', 'cancelled')),
  daily_price     NUMERIC(12, 2) NOT NULL CHECK (daily_price >= 0),
  total_price     NUMERIC(12, 2) NOT NULL CHECK (total_price >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (return_date >= pickup_date)
);
CREATE INDEX idx_reservations_customer_id ON reservations (customer_id);
CREATE INDEX idx_reservations_partner_id  ON reservations (partner_id);
CREATE INDEX idx_reservations_car_id      ON reservations (car_id);
CREATE INDEX idx_reservations_pickup_date ON reservations (pickup_date);
CREATE INDEX idx_reservations_return_date ON reservations (return_date);
CREATE INDEX idx_reservations_status      ON reservations (status);
CREATE INDEX idx_reservations_car_dates   ON reservations (car_id, pickup_date, return_date);
