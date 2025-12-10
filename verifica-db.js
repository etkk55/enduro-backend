const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.query(`
  SELECT column_name, data_type 
  FROM information_schema.columns 
  WHERE table_name = 'comunicati'
  ORDER BY ordinal_position
`).then(res => {
  console.log('\nColonne tabella comunicati:');
  console.table(res.rows);
  pool.end();
}).catch(err => {
  console.error('Errore:', err.message);
  pool.end();
});
