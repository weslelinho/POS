/**
 * Ajustes idempotentes para bancos já existentes.
 * CREATE TABLE IF NOT EXISTS não altera tabelas antigas.
 */
function migrate(db) {
  const customerCols = db.prepare(`PRAGMA table_info(customers)`).all();
  const hasBaseId = customerCols.some((c) => c.name === 'base_id');

  if (!hasBaseId) {
    db.exec(`ALTER TABLE customers ADD COLUMN base_id INTEGER REFERENCES bases(id)`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_base ON customers(base_id)`);
}

module.exports = { migrate };
