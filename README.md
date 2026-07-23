# POS Motoclube — Sistema de Vendas Informais

Sistema de ponto de venda (POS) em **Node.js** com **SQLite em arquivo**, pensado para eventos de motoclube onde se vendem lanches:

- **Clientes externos** → pagamento à vista (**PIX** ou **dinheiro**)
- **Membros do motoclube** → vendas a **fiado**, com extrato e quitação posterior

---

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Arquitetura](#2-arquitetura)
3. [Stack e frameworks](#3-stack-e-frameworks)
4. [Perfis e permissões](#4-perfis-e-permissões)
5. [Entidades de domínio](#5-entidades-de-domínio)
6. [Modelo de banco de dados](#6-modelo-de-banco-de-dados)
7. [Fluxos principais](#7-fluxos-principais)
8. [Estrutura de pastas](#8-estrutura-de-pastas)
9. [Instalação e deploy](#9-instalação-e-deploy)
10. [Backup e operação no evento](#10-backup-e-operação-no-evento)
11. [Rotas da aplicação](#11-rotas-da-aplicação)
12. [Decisões técnicas](#12-decisões-técnicas)

---

## 1. Visão geral

| Aspecto | Definição |
|--------|-----------|
| Tipo | Monólito web server-rendered (SSR) |
| Runtime | Node.js ≥ 20 |
| Persistência | SQLite (`data/pos.sqlite`) |
| UI | Páginas EJS + CSS estático |
| Autenticação | Sessão em cookie (memória do processo) |
| Público-alvo | Balcão de lanches em evento de motoclube |

O sistema roda em **um único processo** na máquina do evento (notebook/PC). Não depende de nuvem nem de servidor externo.

---

## 2. Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                     Navegador (vendedor/admin)               │
│              Chrome / Edge — tablet ou notebook              │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP (localhost:3000)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Express (src/server.js)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Sessão       │  │ Middleware   │  │ Rotas (pages)     │  │
│  │ (MemoryStore)│  │ auth/roles   │  │ EJS views         │  │
│  └──────────────┘  └──────────────┘  └─────────┬─────────┘  │
│                                                │             │
│                     ┌──────────────────────────▼──────────┐ │
│                     │  Services (regras de negócio)       │ │
│                     │  saleService → venda + fiado        │ │
│                     └──────────────────────────┬──────────┘ │
│                                                │             │
│                     ┌──────────────────────────▼──────────┐ │
│                     │  better-sqlite3                     │ │
│                     │  PRAGMA foreign_keys / WAL          │ │
│                     └──────────────────────────┬──────────┘ │
└────────────────────────────────────────────────┼────────────┘
                                                 ▼
                              ┌────────────────────────────────┐
                              │  Arquivo: data/pos.sqlite      │
                              └────────────────────────────────┘
```

### Camadas

| Camada | Responsabilidade |
|--------|------------------|
| **Views** (`views/`) | Telas: login, PDV, cadastros, fiado |
| **Routes** (`src/routes/`) | HTTP, validação de entrada, autorização |
| **Services** (`src/services/`) | Regras: fiado só para membro, totais, ledger |
| **DB** (`src/db/`, `db/schema.sql`) | Conexão, schema, seed |
| **Middleware** | `requireAuth`, `requireAdmin`, `requireSellerOrAdmin` |

### Princípios

- **Dinheiro em centavos** (`INTEGER`) — evita erro de ponto flutuante.
- **Snapshot do produto na venda** (`sale_items.product_name`, `unit_price_cents`) — histórico não muda se o preço do cardápio mudar.
- **Fiado com ledger** — toda cobrança e quitação gera linha em `credit_ledger` e atualiza `credit_accounts.balance_cents`.
- **Transações SQLite** — venda + estoque + fiado no mesmo `db.transaction()`.

---

## 3. Stack e frameworks

### Obrigatórios (runtime)

| Pacote | Versão (aprox.) | Uso |
|--------|-----------------|-----|
| **Node.js** | ≥ 20 LTS | Runtime |
| **express** | ^4.21 | Servidor HTTP e rotas |
| **ejs** | ^3.1 | Templates HTML |
| **better-sqlite3** | ^11 | Driver SQLite síncrono e rápido |
| **express-session** | ^1.18 | Sessão autenticada (MemoryStore) |
| **bcryptjs** | ^2.4 | Hash de senhas |
| **dotenv** | ^16 | Variáveis de ambiente |
| **method-override** | ^3 | Suporte a verbos HTTP em forms (extensível) |

### Nativos / sistema

| Item | Observação |
|------|------------|
| **SQLite 3** | Embutido via `better-sqlite3` (não precisa instalar SQLite separado) |
| **Build tools** | No Windows, `better-sqlite3` pode exigir [windows-build-tools](https://github.com/nodejs/node-gyp) / Visual Studio Build Tools se o binário pré-compilado não estiver disponível |

### Não utilizados (de propósito)

- ORM pesado (Prisma/Sequelize) — schema SQL explícito e queries simples bastam para o evento
- React/Vue SPA — SSR com EJS reduz complexidade de deploy no dia do evento
- PostgreSQL/MySQL — arquivo SQLite é portátil (copiar `data/` = backup completo)

---

## 4. Perfis e permissões

| Perfil | `users.role` | Pode |
|--------|--------------|------|
| **Admin** | `admin` | Tudo do vendedor + cadastrar usuários, cadastrar produtos, (futuro: relatórios avançados, cancelamentos) |
| **Vendedor** | `seller` | Login, PDV, clientes, listar produtos, vendas, consultar/quitar fiado |

### Páginas funcionais

| Página | Admin | Vendedor |
|--------|:-----:|:--------:|
| Login / painel | ✓ | ✓ |
| Nova venda (PDV) | ✓ | ✓ |
| Histórico de vendas | ✓ | ✓ |
| Cadastro de clientes | ✓ | ✓ |
| Cadastro de produtos | ✓ | listar |
| Cadastro de usuários | ✓ | — |
| Fiado (lista, extrato, quitação) | ✓ | ✓ |

---

## 5. Entidades de domínio

### 5.1 User (usuário do sistema)

Operador do balcão ou administrador.

| Campo lógico | Descrição |
|--------------|-----------|
| name | Nome de exibição |
| username | Login único |
| password_hash | Senha com bcrypt |
| role | `admin` \| `seller` |
| active | Soft-disable |

### 5.2 Customer (cliente)

Pessoa que compra no evento.

| Campo lógico | Descrição |
|--------------|-----------|
| name | Nome |
| customer_type | `member` (membro) \| `external` (fora do clube) |
| club_nickname | Apelido / callsign (membros) |
| phone, document | Contato e identificação opcional |
| notes | Observações |

**Regra:** apenas `member` pode comprar a **fiado**.

### 5.3 Product (produto / lanche)

Item vendável no cardápio.

| Campo lógico | Descrição |
|--------------|-----------|
| name, description | Identificação |
| price_cents | Preço atual em centavos |
| category | Ex.: Lanche, Bebida |
| stock_qty | `NULL` = não controla estoque; número = controlado |

### 5.4 Sale (venda)

Cabeçalho da venda.

| Campo lógico | Descrição |
|--------------|-----------|
| sale_number | Código legível (`V20260715-0001`) |
| customer | Opcional à vista; **obrigatório** no fiado |
| seller | Usuário que registrou |
| payment_method | `cash` \| `pix` \| `credit` |
| payment_status | `paid` \| `credit` \| `partial` |
| totais | subtotal / desconto / total / amount_paid (centavos) |

### 5.5 SaleItem (item da venda)

Linha do pedido com snapshot de preço/nome.

### 5.6 CreditAccount (conta fiado)

Saldo consolidado por membro (`balance_cents > 0` = deve).

### 5.7 CreditLedger (extrato fiado)

Movimentações:

| entry_type | Significado |
|------------|-------------|
| `charge` | Venda a fiado (aumenta saldo) |
| `payment` | Quitação em PIX/dinheiro (reduz saldo) |
| `adjustment` | Ajuste manual (uso admin futuro) |

### 5.8 AuditLog

Trilha simples de ações administrativas (estrutura pronta para evolução).

---

## 6. Modelo de banco de dados

Arquivo físico: `data/pos.sqlite` (configurável via `DB_PATH`).  
Schema canônico: [`db/schema.sql`](db/schema.sql).

### Diagrama ER (simplificado)

```
users ──────────────┐
                    │ seller_id
customers ──┐       │
            │       ▼
            │    sales ──── sale_items ──── products
            │       │
            │       │ (fiado)
            ▼       ▼
     credit_accounts
            │
            ▼
      credit_ledger
```

### Tabelas

#### `users`

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT | |
| username | TEXT UNIQUE | case-insensitive |
| password_hash | TEXT | bcrypt |
| role | TEXT | `admin` \| `seller` |
| active | INTEGER | 0/1 |
| created_at, updated_at | TEXT | ISO local |

#### `customers`

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT | |
| phone, document | TEXT | opcionais |
| customer_type | TEXT | `member` \| `external` |
| club_nickname | TEXT | |
| notes | TEXT | |
| active | INTEGER | |
| created_at, updated_at | TEXT | |

#### `products`

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT | |
| description | TEXT | |
| price_cents | INTEGER | ≥ 0 |
| category | TEXT | |
| stock_qty | INTEGER NULL | NULL = ilimitado |
| active | INTEGER | |
| created_at, updated_at | TEXT | |

#### `sales`

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | INTEGER PK | |
| sale_number | TEXT UNIQUE | |
| customer_id | INTEGER FK NULL | obrigatório se `credit` |
| seller_id | INTEGER FK | → users |
| payment_method | TEXT | `cash` \| `pix` \| `credit` |
| status | TEXT | `open` \| `completed` \| `cancelled` |
| payment_status | TEXT | `paid` \| `credit` \| `partial` |
| subtotal_cents | INTEGER | |
| discount_cents | INTEGER | |
| total_cents | INTEGER | |
| amount_paid_cents | INTEGER | 0 no fiado até quitar |
| notes | TEXT | |
| sold_at | TEXT | |
| created_at, updated_at | TEXT | |

#### `sale_items`

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | INTEGER PK | |
| sale_id | INTEGER FK | CASCADE |
| product_id | INTEGER FK | |
| product_name | TEXT | snapshot |
| unit_price_cents | INTEGER | snapshot |
| quantity | INTEGER | > 0 |
| line_total_cents | INTEGER | |

#### `credit_accounts`

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | INTEGER PK | |
| customer_id | INTEGER UNIQUE FK | 1 conta por membro |
| balance_cents | INTEGER | dívida atual |
| updated_at | TEXT | |

#### `credit_ledger`

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | INTEGER PK | |
| customer_id | INTEGER FK | |
| sale_id | INTEGER FK NULL | vínculo com venda |
| entry_type | TEXT | `charge` \| `payment` \| `adjustment` |
| amount_cents | INTEGER | > 0 |
| payment_method | TEXT NULL | `cash` \| `pix` na quitação |
| balance_after_cents | INTEGER | saldo após o lançamento |
| notes | TEXT | |
| created_by | INTEGER FK | usuário |
| created_at | TEXT | |

#### `audit_logs`

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | INTEGER PK | |
| user_id | INTEGER FK | |
| action | TEXT | |
| entity, entity_id | TEXT/INTEGER | |
| details | TEXT | JSON/texto |
| created_at | TEXT | |

### Índices principais

- `customers(customer_type)`, `customers(name)`
- `products(active)`
- `sales(customer_id)`, `sales(seller_id)`, `sales(sold_at)`, `sales(payment_method, payment_status)`
- `sale_items(sale_id)`
- `credit_ledger(customer_id)`, `credit_ledger(sale_id)`

---

## 7. Fluxos principais

### 7.1 Venda à vista (externo ou membro)

1. Vendedor abre **Nova venda**
2. Adiciona lanches/bebidas
3. Escolhe **Dinheiro** ou **PIX** (cliente opcional)
4. Sistema grava `sales` + `sale_items`, baixa estoque se controlado
5. `payment_status = paid`

### 7.2 Venda fiado (somente membro)

1. Vendedor seleciona pagamento **Fiado**
2. Obrigatório escolher cliente `member`
3. Sistema:
   - grava venda com `payment_method = credit`, `payment_status = credit`
   - incrementa `credit_accounts.balance_cents`
   - lança `credit_ledger` tipo `charge`

### 7.3 Quitação de fiado

1. Tela **Fiado** → detalhe do membro
2. Informa valor + PIX ou dinheiro
3. Sistema reduz saldo, lança `payment` no ledger e atualiza `payment_status` da venda vinculada quando aplicável (`partial` / `paid`)

---

## 8. Estrutura de pastas

```
pos/
├── README.md                 ← esta documentação
├── package.json
├── .env.example
├── .gitignore
├── db/
│   └── schema.sql            ← DDL canônico
├── data/
│   ├── .gitkeep
│   └── pos.sqlite            ← gerado em runtime (não versionar)
├── public/
│   └── styles.css
├── views/                    ← telas EJS
│   ├── login.ejs
│   ├── dashboard.ejs
│   ├── customers/
│   ├── users/
│   ├── products/
│   ├── sales/
│   └── credit/
└── src/
    ├── server.js             ← entrypoint
    ├── middleware/auth.js
    ├── routes/index.js
    ├── services/saleService.js
    └── db/
        ├── connection.js
        ├── init.js
        └── seed.js
```

---

## 9. Instalação e deploy

### 9.1 Pré-requisitos

- Node.js 20+ (`node -v`)
- npm 10+
- Windows / Linux / macOS
- No Windows, se `better-sqlite3` falhar no install: instalar **Visual Studio Build Tools** com workload “Desktop development with C++”

### 9.2 Setup local (desenvolvimento)

```bash
# 1. Entrar na pasta do projeto
cd pos

# 2. Instalar dependências
npm install

# 3. Configurar ambiente
copy .env.example .env          # Windows
# cp .env.example .env          # Linux/macOS

# 4. Editar .env (obrigatório em produção)
#    SESSION_SECRET=string-longa-aleatoria
#    ADMIN_PASSWORD=senha-forte

# 5. Inicializar schema + seed (admin + produtos exemplo)
npm run db:init
npm run db:seed

# 6. Subir aplicação
npm run dev          # com --watch
# ou
npm start
```

Acesse: [http://localhost:3000](http://localhost:3000)

**Credenciais padrão do seed** (trocar no evento):

| Campo | Valor |
|-------|-------|
| Usuário | `admin` |
| Senha | `admin123` |

### 9.3 Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `3000` | Porta HTTP |
| `NODE_ENV` | `development` | `production` em evento |
| `SESSION_SECRET` | — | Segredo da sessão (**obrigatório** em produção) |
| `DB_PATH` | `./data/pos.sqlite` | Caminho do arquivo SQLite |
| `ADMIN_USERNAME` | `admin` | Usado no seed |
| `ADMIN_PASSWORD` | `admin123` | Usado no seed |
| `ADMIN_NAME` | `Administrador` | Usado no seed |

### 9.4 Deploy no dia do evento (máquina local)

Objetivo: um notebook no balcão, rede local opcional (Wi‑Fi do evento) para tablets.

1. Clonar/copiar a pasta `pos` para o PC do evento
2. `npm install --omit=dev`
3. Configurar `.env` com `NODE_ENV=production` e `SESSION_SECRET` forte
4. `npm run db:init && npm run db:seed` (só na primeira vez)
5. Cadastrar vendedores, membros e cardápio real
6. Iniciar com `npm start` (ou PM2 — ver abaixo)
7. Abrir `http://IP-DO-PC:3000` nos dispositivos do balcão

#### Opção com PM2 (recomendado se a máquina ficar ligada o dia todo)

```bash
npm install -g pm2
pm2 start src/server.js --name pos-motoclube
pm2 save
```

#### Firewall Windows

Liberar porta TCP `3000` (entrada) se outros dispositivos na rede forem usar o POS.

### 9.5 Deploy “portátil” (pendrive)

1. Rodar o setup uma vez e validar
2. Copiar a pasta inteira **incluindo** `node_modules` e `data/` (ou reinstalar `npm install` na máquina destino)
3. No destino: `npm start`
4. O arquivo `data/pos.sqlite` contém **todo** o histórico

> `better-sqlite3` é nativo: se mudar de SO/arquitetura (ex.: Windows → Linux), rode `npm rebuild` ou `npm install` de novo.

---

## 10. Backup e operação no evento

### Backup

Copiar periodicamente:

```
data/pos.sqlite
data/pos.sqlite-wal   (se existir — modo WAL)
data/pos.sqlite-shm   (se existir)
```

Sugestão: a cada 1–2 horas, ou após picos de movimento, copiar a pasta `data/` para pendrive/OneDrive.

### Encerrar o dia

1. Conferir **Fiado em aberto**
2. Exportar/listar vendas do dia pela tela **Vendas**
3. Parar o processo (`Ctrl+C` ou `pm2 stop pos-motoclube`)
4. Backup final de `data/`

### Segurança básica

- Trocar senha do admin após o seed
- Não versionar `.env` nem `*.sqlite`
- Cada vendedor com usuário próprio (rastreio em `sales.seller_id`)

---

## 11. Rotas da aplicação

| Método | Rota | Perfil | Função |
|--------|------|--------|--------|
| GET/POST | `/login` | público | Autenticação |
| POST | `/logout` | autenticado | Sair |
| GET | `/dashboard` | autenticado | Painel |
| GET/POST | `/customers` | seller/admin | Listar / criar clientes |
| GET | `/customers/new` | seller/admin | Formulário |
| GET/POST | `/users` | admin | Listar / criar usuários |
| GET | `/users/new` | admin | Formulário |
| GET | `/products` | seller/admin | Listar |
| GET/POST | `/products` | admin | Criar |
| GET | `/sales` | seller/admin | Histórico |
| GET/POST | `/sales/new`, `/sales` | seller/admin | PDV |
| GET | `/credit` | seller/admin | Fiados abertos |
| GET | `/credit/:customerId` | seller/admin | Extrato |
| POST | `/credit/:customerId/pay` | seller/admin | Quitação |

---

## 12. Decisões técnicas

| Decisão | Motivo |
|---------|--------|
| SQLite em arquivo | Zero instalação de SGBD; backup = copiar arquivo; ideal para evento |
| better-sqlite3 | API síncrona previsível; excelente para POS single-node |
| Centavos INTEGER | Precisão monetária |
| Fiado só para `member` | Regra de negócio do motoclube |
| EJS SSR | Deploy simples, funciona offline na LAN, sem build de frontend |
| Sessão em memória | Simples e estável; após restart do Node é preciso logar de novo |
| WAL mode | Melhor concorrência leitura/escrita no balcão |

### Evoluções possíveis (fora do MVP)

- Edição/desativação de produtos e usuários pela UI
- Cancelamento de venda com estorno de estoque/fiado
- Relatório de caixa (total PIX / dinheiro / fiado do dia)
- Impressão de comprovante / QR Code PIX estático por venda
- Modo offline com sync (se houver múltiplos pontos)

---

## Scripts npm

| Script | Descrição |
|--------|-----------|
| `npm start` | Sobe o servidor |
| `npm run dev` | Sobe com `node --watch` |
| `npm run db:init` | Aplica `db/schema.sql` |
| `npm run db:seed` | Cria admin + produtos de exemplo |

---

## Licença

Software proprietário — todos os direitos reservados.

Uso interno autorizado do evento / motoclube ECMC apenas. Ver o arquivo
[`LICENSE`](./LICENSE) para os termos completos.

## DNS + DHCP com dnsmasq
sudo apt update
sudo apt install dnsmasq
Crie /etc/dnsmasq.d/pos-ap.conf (ajuste interface e IP):

interface=wlan0
bind-interfaces
# Se o NetworkManager já faz DHCP, use só DNS:
# (comente as linhas de dhcp-range abaixo)
# Se o dnsmasq for o DHCP:
dhcp-range=10.42.0.50,10.42.0.200,12h
dhcp-option=option:router,10.42.0.1
dhcp-option=option:dns-server,10.42.0.1
# Nome fácil
address=/pos.local/10.42.0.1
address=/app.local/10.42.0.1
# Captive portal: qualquer domínio → IP do AP
address=/#/10.42.0.1
Reinicie:

sudo systemctl restart dnsmasq
sudo systemctl enable dnsmasq
Se o NetworkManager já gerencia o hotspot, às vezes ele conflita com o DHCP do dnsmasq — nesse caso use só as linhas address= e deixe o NM cuidar do DHCP, configurando DNS = IP do AP no hotspot.


## Proxy na porta 80 → app :3000
Porta 80 é o que os celulares checam no captive portal. Nginx é o caminho mais simples:

sudo apt install nginx
/etc/nginx/sites-available/pos:

server {
    listen 80 default_server;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

Ative e abra o firewall:

sudo ln -sf /etc/nginx/sites-available/pos /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 80/tcp
Com isso:

http://10.42.0.1 → app
http://pos.local → app
Qualquer HTTP → app (via DNS wildcard)