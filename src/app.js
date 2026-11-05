const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const routes = require('./routes');
const { apiLimiter } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser clients (curl, server-to-server) and whitelisted origins
      if (!origin || config.corsOrigin.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);
// Uploaded car photos. Served read-only from the upload folder: no directory listing, no dotfiles,
// content type fixed by the (server-chosen) extension, and never interpreted as a page or script.
if (config.upload.driver === 'local') {
  app.use(
    '/uploads',
    express.static(config.upload.dir, {
      index: false,
      dotfiles: 'ignore',
      redirect: false,
      maxAge: '7d',
      immutable: true, // file names are random and never reused
      setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // the Next.js app is another origin
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      },
    })
  );
}

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.use('/api', apiLimiter, routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
