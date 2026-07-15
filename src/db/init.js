require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getConnection, dbPath } = require('./connection');
const { migrate } = require('./migrate');

function initDatabase() {
  const schemaPath = path.join(__dirname, '../../db/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const db = getConnection();

  db.exec(schema);
  migrate(db);
  db.close();

  console.log(`Banco inicializado em: ${path.resolve(dbPath)}`);
}

initDatabase();
