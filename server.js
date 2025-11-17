const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');

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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Test database connection
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EVENTI ====================

// GET tutti gli eventi
app.get('/api/eventi', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM eventi ORDER BY data_inizio DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crea nuovo evento
app.post('/api/eventi', async (req, res) => {
  const { nome_evento, codice_gara, data_inizio, data_fine, luogo, logo_url, descrizione } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO eventi (nome_evento, codice_gara, data_inizio, data_fine, luogo, logo_url, descrizione, stato)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'attivo')
       RETURNING *`,
      [nome_evento, codice_gara, data_inizio, data_fine, luogo, logo_url, descrizione]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE evento
app.delete('/api/eventi/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Elimina tempi collegati
    await pool.query('DELETE FROM tempi WHERE id_pilota IN (SELECT id FROM piloti WHERE id_evento = $1)', [id]);
    
    // Elimina piloti collegati
    await pool.query('DELETE FROM piloti WHERE id_evento = $1', [id]);
    
    // Elimina prove speciali collegate
    await pool.query('DELETE FROM prove_speciali WHERE id_evento = $1', [id]);
    
    // Elimina evento
    await pool.query('DELETE FROM eventi WHERE id = $1', [id]);
    
    res.json({ message: 'Evento eliminato con successo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PILOTI ====================

// GET tutti i piloti
app.get('/api/piloti', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, e.nome_evento 
      FROM piloti p
      LEFT JOIN eventi e ON p.id_evento = e.id
      ORDER BY p.numero_gara
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crea nuovo pilota
app.post('/api/piloti', async (req, res) => {
  const { numero_gara, nome, cognome, id_categoria, team, nazione, email, telefono, id_evento } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO piloti (numero_gara, nome, cognome, id_categoria, team, nazione, email, telefono, id_evento)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [numero_gara, nome, cognome, id_categoria, team, nazione, email, telefono, id_evento]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE pilota
app.delete('/api/piloti/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('DELETE FROM piloti WHERE id = $1', [id]);
    res.json({ message: 'Pilota eliminato' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PROVE SPECIALI ====================

// GET tutte le prove speciali
app.get('/api/prove-speciali', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ps.*, e.nome_evento 
      FROM prove_speciali ps
      LEFT JOIN eventi e ON ps.id_evento = e.id
      ORDER BY ps.numero_ordine
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crea nuova prova speciale
app.post('/api/prove-speciali', async (req, res) => {
  const { nome_ps, numero_ordine, id_evento } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO prove_speciali (nome_ps, numero_ordine, id_evento, stato)
       VALUES ($1, $2, $3, 'attiva')
       RETURNING *`,
      [nome_ps, numero_ordine, id_evento]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== TEMPI ====================

// GET tutti i tempi (con formattazione)
app.get('/api/tempi', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.id,
        t.tempo_secondi,
        t.penalita_secondi,
        p.numero_gara,
        p.nome,
        p.cognome,
        ps.nome_ps,
        ps.numero_ordine,
        e.nome_evento,
        t.id_pilota,
        t.id_ps
      FROM tempi t
      JOIN piloti p ON t.id_pilota = p.id
      JOIN prove_speciali ps ON t.id_ps = ps.id
      JOIN eventi e ON ps.id_evento = e.id
      ORDER BY ps.numero_ordine, t.tempo_secondi
    `);
    
    // Formatta i tempi
    const tempiFormattati = result.rows.map(row => {
      const minuti = Math.floor(row.tempo_secondi / 60);
      const secondi = (row.tempo_secondi % 60).toFixed(2);
      
      return {
        ...row,
        tempo_formattato: `${minuti}'${secondi.padStart(5, '0')}`,
        tempo_secondi_raw: row.tempo_secondi
      };
    });
    
    res.json(tempiFormattati);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST inserisci nuovo tempo
app.post('/api/tempi', async (req, res) => {
  const { id_pilota, id_ps, tempo_secondi, penalita_secondi } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id_pilota, id_ps, tempo_secondi, penalita_secondi || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT aggiorna tempo
app.put('/api/tempi/:id', async (req, res) => {
  const { id } = req.params;
  const { tempo_secondi, penalita_secondi } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE tempi 
       SET tempo_secondi = $1, penalita_secondi = $2
       WHERE id = $3
       RETURNING *`,
      [tempo_secondi, penalita_secondi, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLASSIFICHE ====================

// GET classifica generale
app.get('/api/classifiche', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.numero_gara,
        p.nome,
        p.cognome,
        e.nome_evento,
        SUM(t.tempo_secondi + COALESCE(t.penalita_secondi, 0)) as tempo_totale
      FROM piloti p
      JOIN tempi t ON p.id = t.id_pilota
      JOIN prove_speciali ps ON t.id_ps = ps.id
      JOIN eventi e ON p.id_evento = e.id
      GROUP BY p.id, p.numero_gara, p.nome, p.cognome, e.nome_evento
      ORDER BY tempo_totale ASC
    `);
    
    // Formatta tempi e calcola distacchi
    const classificaFormattata = result.rows.map((row, index) => {
      const minuti = Math.floor(row.tempo_totale / 60);
      const secondi = (row.tempo_totale % 60).toFixed(2);
      
      let distacco = '';
      if (index > 0) {
        const diff = row.tempo_totale - result.rows[0].tempo_totale;
        const diffMinuti = Math.floor(diff / 60);
        const diffSecondi = (diff % 60).toFixed(2);
        distacco = `${diffMinuti}'${diffSecondi.padStart(5, '0')}`;
      }
      
      return {
        posizione: index + 1,
        numero_gara: row.numero_gara,
        pilota: `${row.nome} ${row.cognome}`,
        evento: row.nome_evento,
        tempo_totale: `${minuti}'${secondi.padStart(5, '0')}`,
        tempo_totale_raw: row.tempo_totale,
        distacco: distacco
      };
    });
    
    res.json(classificaFormattata);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== IMPORT FICR ====================

// Funzione per convertire tempo FICR in secondi
function convertiTempoFICR(tempoStr) {
  if (!tempoStr || tempoStr === '') return null;
  
  const match = tempoStr.match(/(\d+)'(\d+\.\d+)/);
  if (!match) return null;
  
  const minuti = parseInt(match[1]);
  const secondi = parseFloat(match[2]);
  
  return minuti * 60 + secondi;
}

// POST import dati da FICR
app.post('/api/import-ficr', async (req, res) => {
  const { anno, codiceEquipe, manifestazione, giorno, prova, categoria, id_evento, id_ps } = req.body;
  
  try {
    // Chiama API FICR
    const url = `https://apienduro.ficr.it/END/mpcache-5/get/clasps/${anno}/${codiceEquipe}/${manifestazione}/${giorno}/${prova}/${categoria}/*/*/*/*/*`;
    const response = await axios.get(url);
    
    if (!response.data || !response.data.data || !response.data.data.clasdella) {
      return res.status(404).json({ error: 'Dati non trovati su FICR' });
    }
    
    const piloti = response.data.data.clasdella;
    
    let pilotiImportati = 0;
    let tempiImportati = 0;
    
    for (const pilotaFICR of piloti) {
      // Cerca pilota esistente
      let pilotaId;
      const pilotaEsistente = await pool.query(
        'SELECT id FROM piloti WHERE numero_gara = $1 AND id_evento = $2',
        [pilotaFICR.Numero, id_evento]
      );
      
      if (pilotaEsistente.rows.length > 0) {
        pilotaId = pilotaEsistente.rows[0].id;
      } else {
        // Crea nuovo pilota
        const nuovoPilota = await pool.query(
          `INSERT INTO piloti (numero_gara, nome, cognome, team, nazione, id_evento)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            pilotaFICR.Numero,
            pilotaFICR.Nome,
            pilotaFICR.Cognome,
            pilotaFICR.Motoclub || '',
            pilotaFICR.Naz || '',
            id_evento
          ]
        );
        pilotaId = nuovoPilota.rows[0].id;
        pilotiImportati++;
      }
      
      // Converti e inserisci tempo
      const tempoSecondi = convertiTempoFICR(pilotaFICR.Tempo);
      if (tempoSecondi !== null) {
        await pool.query(
          `INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
           VALUES ($1, $2, $3, 0)
           ON CONFLICT DO NOTHING`,
          [pilotaId, id_ps, tempoSecondi]
        );
        tempiImportati++;
      }
    }
    
    res.json({ 
      success: true, 
      pilotiImportati, 
      tempiImportati,
      totale: piloti.length
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CATEGORIE ====================

// GET tutte le categorie
app.get('/api/categorie', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categorie ORDER BY nome_categoria');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
