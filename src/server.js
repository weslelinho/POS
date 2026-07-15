require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');

const { getConnection, dbPath } = require('./db/connection');
const { migrate } = require('./db/migrate');
const { createRouter } = require('./routes');

const PORT = Number(process.env.PORT) || 3000;
const dataDir = path.dirname(path.resolve(dbPath));

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = getConnection();

// Garante schema na subida (idempotente)
const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
db.exec(schema);
migrate(db);

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use('/public', express.static(path.join(__dirname, '../public')));

// Sessão em memória (adequado a evento single-node; relogar após restart)
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 12 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session?.user || null;
  res.locals.formatMoney = (cents) =>
    (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  next();
});

app.use(createRouter(db));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Erro',
    message: process.env.NODE_ENV === 'production' ? 'Erro interno.' : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`POS Motoclube em http://localhost:${PORT}`);
  console.log(`SQLite: ${path.resolve(dbPath)}`);
});
