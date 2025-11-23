// server.js
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const helmet = require('helmet');
const cors = require('cors');
const http = require('http');

const db = require('./db'); // connects to Mongo
// const seedRoles = require('./seed/seedRoles');

const authRoutes = require('./routes/auth');
const tableRoutes = require('./routes/table');
const menuRoutes = require('./routes/menu');
const orderRoutes = require('./routes/orders');

const { initKdsSocket } = require('./kdsSocket');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// mount routes
app.use('/api/auth', authRoutes);
app.use('/api/tables', tableRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);

// health
app.get('/health', (req, res) => res.json({ status: 'ok', now: new Date() }));

const PORT = process.env.PORT || 3000;

// Create HTTP server and attach Socket.IO
const httpServer = http.createServer(app);

// connect then seed then listen
(async () => {
  try {
    await db.connect();
    console.log('Mongo connected');

    // init KDS websocket
    initKdsSocket(httpServer);

    httpServer.listen(PORT, () =>
      console.log(`Server + Socket.IO running on port ${PORT}`)
    );
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
})();
