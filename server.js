require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Test database
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all events
app.get('/api/eventi', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM eventi ORDER BY data_inizio DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get pilots
app.get('/api/piloti', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, c.nome_categoria 
      FROM piloti p 
      LEFT JOIN categorie c ON p.id_categoria = c.id 
      ORDER BY p.numero_gara
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get classifications
app.get('/api/classifiche', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM classifiche_per_categoria 
      ORDER BY nome_categoria, posizione
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Seed database with test data
app.post('/api/seed', async (req, res) => {
  try {
    // Insert event
    await pool.query(`
      INSERT INTO eventi (id, nome_evento, codice_gara, data_inizio, data_fine, luogo, stato) 
      VALUES ('550e8400-e29b-41d4-a716-446655440000', 'Six Days Enduro Bergamo 2025', 'END2025BG', '2025-06-15', '2025-06-21', 'Bergamo, Italia', 'attivo')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert categories
    await pool.query(`
      INSERT INTO categorie (id, id_evento, nome_categoria) VALUES
      ('650e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440000', 'Senior'),
      ('650e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440000', 'Under 23'),
      ('650e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440000', 'Women')
      ON CONFLICT DO NOTHING
    `);

    // Insert pilots
    await pool.query(`
      INSERT INTO piloti (id, id_evento, numero_gara, nome, cognome, id_categoria, team, nazione) VALUES
      ('750e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440000', 1, 'Marco', 'Rossi', '650e8400-e29b-41d4-a716-446655440001', 'KTM Factory', 'ITA'),
      ('750e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440000', 2, 'Andrea', 'Verdi', '650e8400-e29b-41d4-a716-446655440001', 'Husqvarna', 'ITA'),
      ('750e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440000', 3, 'Luca', 'Bianchi', '650e8400-e29b-41d4-a716-446655440001', 'Beta Factory', 'ITA')
      ON CONFLICT DO NOTHING
    `);

    res.json({ success: true, message: 'Database seeded!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
