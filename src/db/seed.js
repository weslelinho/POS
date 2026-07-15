require('dotenv').config();

const bcrypt = require('bcryptjs');
const { getConnection } = require('./connection');

function seed() {
  const db = getConnection();

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'Administrador';

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`Usuário admin "${username}" já existe. Seed ignorado.`);
    db.close();
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 10);

  const insertUser = db.prepare(`
    INSERT INTO users (name, username, password_hash, role, active)
    VALUES (?, ?, ?, 'admin', 1)
  `);

  const insertProducts = db.prepare(`
    INSERT INTO products (name, description, price_cents, category, stock_qty, active)
    VALUES (@name, @description, @price_cents, @category, @stock_qty, 1)
  `);

  const seedAll = db.transaction(() => {
    insertUser.run(name, username, passwordHash);

    const samples = [
      { name: 'X-Burger', description: 'Hambúrguer simples', price_cents: 1500, category: 'Lanche', stock_qty: null },
      { name: 'X-Bacon', description: 'Hambúrguer com bacon', price_cents: 2000, category: 'Lanche', stock_qty: null },
      { name: 'Hot Dog', description: 'Cachorro-quente', price_cents: 1200, category: 'Lanche', stock_qty: null },
      { name: 'Refrigerante lata', description: '350ml', price_cents: 600, category: 'Bebida', stock_qty: 100 },
      { name: 'Água mineral', description: '500ml', price_cents: 400, category: 'Bebida', stock_qty: 100 },
    ];

    for (const p of samples) {
      insertProducts.run(p);
    }
  });

  seedAll();
  db.close();

  console.log(`Seed concluído. Admin: ${username} / ${password}`);
  console.log('Troque a senha do admin após o primeiro acesso.');
}

seed();
