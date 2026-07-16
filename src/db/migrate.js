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

  // Caixa: sessões e movimentos manuais (fundo de troco / sangria / suprimento)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cash_sessions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      opened_by             INTEGER NOT NULL REFERENCES users(id),
      closed_by             INTEGER REFERENCES users(id),
      opened_at             TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
      closed_at             TEXT,
      opening_float_cents   INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
      closing_counted_cents INTEGER CHECK (closing_counted_cents IS NULL OR closing_counted_cents >= 0),
      expected_cents        INTEGER,
      status                TEXT    NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'closed')),
      notes                 TEXT,
      created_at            TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_cash_sessions_opened_at ON cash_sessions(opened_at);

    CREATE TABLE IF NOT EXISTS cash_movements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      INTEGER NOT NULL REFERENCES cash_sessions(id),
      movement_type   TEXT    NOT NULL CHECK (movement_type IN ('supply', 'bleed')),
      amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
      notes           TEXT,
      created_by      INTEGER NOT NULL REFERENCES users(id),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(session_id);
  `);
}

module.exports = { migrate };
