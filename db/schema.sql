-- POS Motoclube — Schema SQLite
-- Encoding: UTF-8 | Foreign keys: ON

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Usuários do sistema (admin e vendedor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'seller')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------------------------------------------------------------------------
-- Bases (chapters / capítulos do motoclube)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,                -- nome do chapter (ex.: Base São Paulo)
  city        TEXT,
  state       TEXT,                            -- UF (ex.: SP)
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_bases_name ON bases(name);
CREATE INDEX IF NOT EXISTS idx_bases_active ON bases(active);

-- ---------------------------------------------------------------------------
-- Clientes (membros do motoclube ou clientes externos)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  phone         TEXT,
  document      TEXT,                          -- CPF opcional / identificação
  customer_type TEXT    NOT NULL CHECK (customer_type IN ('member', 'external')),
  club_nickname TEXT,                          -- apelido / callsign do membro
  base_id       INTEGER REFERENCES bases(id),  -- chapter vinculado (opcional)
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_customers_type ON customers(customer_type);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
-- idx_customers_base é criado em migrate.js (bancos antigos ainda não têm base_id)

-- ---------------------------------------------------------------------------
-- Produtos (lanches e demais itens)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),  -- valor em centavos
  category    TEXT,
  stock_qty   INTEGER,                         -- NULL = estoque ilimitado / não controlado
  image_path  TEXT,                            -- relativo a public/ (ex.: img/products/1.jpg)
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

-- ---------------------------------------------------------------------------
-- Vendas
-- status:
--   open      — em montagem (carrinho)
--   completed — finalizada
--   cancelled — cancelada
-- payment_status:
--   paid     — quitada (pix/dinheiro ou fiado já pago)
--   credit   — fiado em aberto
--   partial  — pagamento parcial do fiado
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_number     TEXT    NOT NULL UNIQUE,     -- ex: V20260715-0001
  customer_id     INTEGER REFERENCES customers(id),
  seller_id       INTEGER NOT NULL REFERENCES users(id),
  payment_method  TEXT    NOT NULL CHECK (payment_method IN ('cash', 'pix', 'credit')),
  status          TEXT    NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('open', 'completed', 'cancelled')),
  payment_status  TEXT    NOT NULL DEFAULT 'paid'
                    CHECK (payment_status IN ('paid', 'credit', 'partial')),
  subtotal_cents  INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents  INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents     INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  amount_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  notes           TEXT,
  sold_at         TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),

  -- Fiado exige cliente membro
  CHECK (
    (payment_method = 'credit' AND customer_id IS NOT NULL)
    OR payment_method IN ('cash', 'pix')
  )
);

CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_seller ON sales(seller_id);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_payment ON sales(payment_method, payment_status);

-- ---------------------------------------------------------------------------
-- Itens da venda
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id         INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  product_name    TEXT    NOT NULL,            -- snapshot do nome no momento da venda
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

-- ---------------------------------------------------------------------------
-- Conta fiado por cliente membro (saldo consolidado)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL UNIQUE REFERENCES customers(id),
  balance_cents   INTEGER NOT NULL DEFAULT 0,  -- >0 = cliente deve
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------------------------------------------------------------------------
-- Movimentações de fiado (venda a crédito e pagamentos)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  sale_id         INTEGER REFERENCES sales(id),
  entry_type      TEXT    NOT NULL CHECK (entry_type IN ('charge', 'payment', 'adjustment')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  payment_method  TEXT    CHECK (payment_method IN ('cash', 'pix') OR payment_method IS NULL),
  balance_after_cents INTEGER NOT NULL,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_customer ON credit_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_sale ON credit_ledger(sale_id);

-- ---------------------------------------------------------------------------
-- Sessão de caixa (turno): fundo de troco na abertura e fechamento
-- Apenas uma sessão com status 'open' por vez (garantido na aplicação).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_sessions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_by             INTEGER NOT NULL REFERENCES users(id),
  closed_by             INTEGER REFERENCES users(id),
  opened_at             TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  closed_at             TEXT,
  opening_float_cents   INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
  closing_counted_cents INTEGER CHECK (closing_counted_cents IS NULL OR closing_counted_cents >= 0),
  expected_cents        INTEGER,  -- snapshot do saldo esperado no fechamento
  status                TEXT    NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'closed')),
  notes                 TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(status);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_opened_at ON cash_sessions(opened_at);

-- ---------------------------------------------------------------------------
-- Movimentos manuais de caixa (não provenientes de vendas)
--   supply — suprimento / reforço de troco
--   bleed  — sangria (retirada para cofre)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Auditoria simples de ações administrativas
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT    NOT NULL,
  entity      TEXT,
  entity_id   INTEGER,
  details     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------------------------------------------------------------------------
-- Seed mínimo: admin padrão (senha deve ser trocada no primeiro acesso)
-- password: admin123  (bcrypt hash gerado na inicialização da app — ver seed.js)
-- ---------------------------------------------------------------------------
