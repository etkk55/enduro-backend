const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Database configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is running!' });
});

// Get all events
app.get('/api/eventi', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM eventi ORDER BY data DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get event details
app.get('/api/eventi/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM eventi WHERE id_evento = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get pilots for an event
app.get('/api/eventi/:id/piloti', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM piloti WHERE id_evento = $1 ORDER BY numero_pilota',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pilots:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get timing data for live timing
app.get('/api/eventi/:id/timing', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get event details
    const eventResult = await pool.query(
      'SELECT * FROM eventi WHERE id_evento = $1',
      [id]
    );
    
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Get pilots
    const pilotsResult = await pool.query(
      'SELECT * FROM piloti WHERE id_evento = $1 ORDER BY numero_pilota',
      [id]
    );

    // Get stages
    const stagesResult = await pool.query(
      'SELECT * FROM prove_speciali WHERE id_evento = $1 ORDER BY numero_prova',
      [id]
    );

    // Get all timing data
    const timingResult = await pool.query(
      `SELECT t.*, ps.numero_prova, ps.nome_prova
       FROM tempi t
       JOIN prove_speciali ps ON t.id_prova = ps.id_prova
       WHERE ps.id_evento = $1
       ORDER BY ps.numero_prova, t.numero_pilota`,
      [id]
    );

    res.json({
      event: eventResult.rows[0],
      pilots: pilotsResult.rows,
      stages: stagesResult.rows,
      timing: timingResult.rows
    });
  } catch (error) {
    console.error('Error fetching timing data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export replay data endpoint
app.get('/api/eventi/:id_evento/export-replay', async (req, res) => {
  try {
    const { id_evento } = req.params;

    // Get event info
    const eventResult = await pool.query(
      'SELECT * FROM eventi WHERE id_evento = $1',
      [id_evento]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Get pilots
    const pilotsResult = await pool.query(
      'SELECT * FROM piloti WHERE id_evento = $1 ORDER BY numero_pilota',
      [id_evento]
    );

    // Get stages
    const stagesResult = await pool.query(
      'SELECT * FROM prove_speciali WHERE id_evento = $1 ORDER BY numero_prova',
      [id_evento]
    );

    // Get timing data with stage info
    const timingResult = await pool.query(
      `SELECT t.*, ps.numero_prova, ps.nome_prova, ps.distanza
       FROM tempi t
       JOIN prove_speciali ps ON t.id_prova = ps.id_prova
       WHERE ps.id_evento = $1
       ORDER BY ps.numero_prova, t.numero_pilota`,
      [id_evento]
    );

    res.json({
      event: eventResult.rows[0],
      pilots: pilotsResult.rows,
      stages: stagesResult.rows,
      timing: timingResult.rows
    });
  } catch (error) {
    console.error('Error exporting replay data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
