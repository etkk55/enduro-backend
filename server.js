const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to database:', err.stack);
  } else {
    console.log('Successfully connected to database');
    release();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Test database endpoint
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// EVENTI ENDPOINTS
// ============================================

// Get all eventi
app.get('/api/eventi', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM eventi ORDER BY data_inizio DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create evento
app.post('/api/eventi', async (req, res) => {
  try {
    const { nome_evento, codice_gara, data_inizio, data_fine, location, descrizione, organizzatore_id } = req.body;
    
    const result = await pool.query(
      `INSERT INTO eventi (nome_evento, codice_gara, data_inizio, data_fine, location, descrizione, organizzatore_id, stato)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'attivo')
       RETURNING *`,
      [nome_evento, codice_gara, data_inizio, data_fine, location, descrizione, organizzatore_id]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CATEGORIE ENDPOINTS
// ============================================

// Get all categorie
app.get('/api/categorie', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categorie ORDER BY nome_categoria');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create categoria
app.post('/api/categorie', async (req, res) => {
  try {
    const { nome_categoria, descrizione, id_evento } = req.body;
    
    const result = await pool.query(
      'INSERT INTO categorie (nome_categoria, descrizione, id_evento) VALUES ($1, $2, $3) RETURNING *',
      [nome_categoria, descrizione, id_evento]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PILOTI ENDPOINTS
// ============================================

// Get all piloti
app.get('/api/piloti', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM piloti ORDER BY numero_gara');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create pilota
app.post('/api/piloti', async (req, res) => {
  try {
    const { nome, cognome, numero_gara, categoria, email, telefono, id_evento } = req.body;
    
    const result = await pool.query(
      `INSERT INTO piloti (nome, cognome, numero_gara, categoria, email, telefono, id_evento)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [nome, cognome, numero_gara, categoria, email, telefono, id_evento]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete pilota
app.delete('/api/piloti/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM piloti WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pilota non trovato' });
    }
    
    res.json({ message: 'Pilota eliminato', pilota: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROVE SPECIALI ENDPOINTS
// ============================================

// Get all prove speciali
app.get('/api/prove-speciali', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM prove_speciali ORDER BY numero_ordine');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create prova speciale
app.post('/api/prove-speciali', async (req, res) => {
  try {
    const { nome_ps, numero_ordine, distanza_km, id_evento } = req.body;
    
    const result = await pool.query(
      `INSERT INTO prove_speciali (nome_ps, numero_ordine, id_evento)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [nome_ps, numero_ordine, id_evento]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TEMPI ENDPOINTS
// ============================================

// Get all tempi with pilot data (for classifiche)
app.get('/api/tempi', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.id,
        t.tempo_minuti,
        t.tempo_secondi,
        t.tempo_centesimi,
        t.penalita,
        p.id as id_pilota,
        p.nome,
        p.cognome,
        p.numero_gara,
        p.categoria
      FROM tempi t
      JOIN piloti p ON t.id_pilota = p.id
      ORDER BY (t.tempo_minuti * 60 + t.tempo_secondi + t.tempo_centesimi / 100) ASC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create tempo
app.post('/api/tempi', async (req, res) => {
  try {
    const { id_pilota, id_ps, tempo_minuti, tempo_secondi, tempo_centesimi, penalita } = req.body;
    
    const result = await pool.query(
      `INSERT INTO tempi (id_pilota, id_ps, tempo_minuti, tempo_secondi, tempo_centesimi, penalita)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id_pilota, id_ps, tempo_minuti, tempo_secondi, tempo_centesimi, penalita || 0]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update tempo
app.put('/api/tempi/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { tempo_secondi, penalita_secondi } = req.body;
    
    const result = await pool.query(
      `UPDATE tempi 
       SET tempo_secondi = $1, penalita_secondi = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [tempo_secondi, penalita_secondi, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tempo non trovato' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CLASSIFICHE ENDPOINTS
// ============================================

// Get classifiche
app.get('/api/classifiche', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id,
        p.nome,
        p.cognome,
        p.numero_gara,
        p.categoria,
        SUM(t.tempo_minuti * 60 + t.tempo_secondi + t.tempo_centesimi / 100) as tempo_totale
      FROM piloti p
      LEFT JOIN tempi t ON p.id = t.id_pilota
      GROUP BY p.id, p.nome, p.cognome, p.numero_gara, p.categoria
      ORDER BY tempo_totale ASC NULLS LAST
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
