const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurazione PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());

// Test connessione database
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Errore connessione database:', err);
  } else {
    console.log('✅ Database connesso:', res.rows[0].now);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Enduro Events API',
    timestamp: new Date().toISOString()
  });
});

// GET - Lista eventi
app.get('/api/eventi', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM eventi 
      WHERE stato = 'attivo'
      ORDER BY data_inizio DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Errore GET eventi:', error);
    res.status(500).json({ error: 'Errore recupero eventi' });
  }
});

// GET - Singolo evento
app.get('/api/eventi/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM eventi WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Errore GET evento:', error);
    res.status(500).json({ error: 'Errore recupero evento' });
  }
});

// POST - Nuovo evento
app.post('/api/eventi', async (req, res) => {
  try {
    const { nome_evento, codice_gara, data_inizio, data_fine, luogo, descrizione } = req.body;
    
    const result = await pool.query(`
      INSERT INTO eventi (nome_evento, codice_gara, data_inizio, data_fine, luogo, descrizione, stato)
      VALUES ($1, $2, $3, $4, $5, $6, 'attivo')
      RETURNING *
    `, [nome_evento, codice_gara, data_inizio, data_fine, luogo, descrizione]);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Errore POST evento:', error);
    res.status(500).json({ error: 'Errore creazione evento' });
  }
});

// PUT - Aggiorna evento
app.put('/api/eventi/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_evento, data_inizio, data_fine, luogo, descrizione } = req.body;
    
    const result = await pool.query(`
      UPDATE eventi 
      SET nome_evento = $1, data_inizio = $2, data_fine = $3, luogo = $4, descrizione = $5, updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [nome_evento, data_inizio, data_fine, luogo, descrizione, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Errore PUT evento:', error);
    res.status(500).json({ error: 'Errore aggiornamento evento' });
  }
});

// DELETE - Elimina evento (soft delete)
app.delete('/api/eventi/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      UPDATE eventi 
      SET stato = 'eliminato', updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    res.json({ message: 'Evento eliminato', evento: result.rows[0] });
  } catch (error) {
    console.error('Errore DELETE evento:', error);
    res.status(500).json({ error: 'Errore eliminazione evento' });
  }
});

// GET - Piloti di un evento
app.get('/api/eventi/:id_evento/piloti', async (req, res) => {
  try {
    const { id_evento } = req.params;
    const result = await pool.query(`
      SELECT * FROM piloti 
      WHERE id_evento = $1
      ORDER BY numero
    `, [id_evento]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Errore GET piloti:', error);
    res.status(500).json({ error: 'Errore recupero piloti' });
  }
});

// POST - Import piloti da FICR
app.post('/api/eventi/:id_evento/import-piloti', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id_evento } = req.params;
    const { piloti } = req.body;
    
    if (!Array.isArray(piloti) || piloti.length === 0) {
      return res.status(400).json({ error: 'Array piloti mancante o vuoto' });
    }
    
    await client.query('BEGIN');
    
    let importati = 0;
    let aggiornati = 0;
    let errori = [];
    
    for (const pilota of piloti) {
      try {
        const checkResult = await client.query(
          'SELECT id FROM piloti WHERE id_evento = $1 AND numero = $2',
          [id_evento, pilota.numero]
        );
        
        if (checkResult.rows.length > 0) {
          await client.query(`
            UPDATE piloti 
            SET cognome = $1, nome = $2, classe = $3, moto = $4, updated_at = NOW()
            WHERE id = $5
          `, [pilota.cognome, pilota.nome, pilota.classe, pilota.moto, checkResult.rows[0].id]);
          aggiornati++;
        } else {
          await client.query(`
            INSERT INTO piloti (id_evento, numero, cognome, nome, classe, moto)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [id_evento, pilota.numero, pilota.cognome, pilota.nome, pilota.classe, pilota.moto]);
          importati++;
        }
      } catch (err) {
        errori.push({ pilota: pilota.numero, errore: err.message });
      }
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      importati,
      aggiornati,
      errori: errori.length > 0 ? errori : undefined
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Errore import piloti:', error);
    res.status(500).json({ error: 'Errore import piloti' });
  } finally {
    client.release();
  }
});

// GET - Prove speciali di un evento
app.get('/api/eventi/:id_evento/prove', async (req, res) => {
  try {
    const { id_evento } = req.params;
    const result = await pool.query(`
      SELECT * FROM prove_speciali 
      WHERE id_evento = $1
      ORDER BY numero_prova
    `, [id_evento]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Errore GET prove:', error);
    res.status(500).json({ error: 'Errore recupero prove' });
  }
});

// POST - Import prove da FICR
app.post('/api/eventi/:id_evento/import-prove', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id_evento } = req.params;
    const { prove } = req.body;
    
    if (!Array.isArray(prove) || prove.length === 0) {
      return res.status(400).json({ error: 'Array prove mancante o vuoto' });
    }
    
    await client.query('BEGIN');
    
    let importate = 0;
    let aggiornate = 0;
    
    for (const prova of prove) {
      const checkResult = await client.query(
        'SELECT id FROM prove_speciali WHERE id_evento = $1 AND numero_prova = $2',
        [id_evento, prova.numero_prova]
      );
      
      if (checkResult.rows.length > 0) {
        await client.query(`
          UPDATE prove_speciali 
          SET nome_prova = $1, updated_at = NOW()
          WHERE id = $2
        `, [prova.nome_prova, checkResult.rows[0].id]);
        aggiornate++;
      } else {
        await client.query(`
          INSERT INTO prove_speciali (id_evento, numero_prova, nome_prova)
          VALUES ($1, $2, $3)
        `, [id_evento, prova.numero_prova, prova.nome_prova]);
        importate++;
      }
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      importate,
      aggiornate
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Errore import prove:', error);
    res.status(500).json({ error: 'Errore import prove' });
  } finally {
    client.release();
  }
});

// POST - Import tempi da FICR
app.post('/api/eventi/:id_evento/import-tempi', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id_evento } = req.params;
    const { tempi } = req.body;
    
    if (!Array.isArray(tempi) || tempi.length === 0) {
      return res.status(400).json({ error: 'Array tempi mancante o vuoto' });
    }
    
    await client.query('BEGIN');
    
    let importati = 0;
    let aggiornati = 0;
    let errori = [];
    
    for (const tempo of tempi) {
      try {
        const pilotaResult = await client.query(
          'SELECT id FROM piloti WHERE id_evento = $1 AND numero = $2',
          [id_evento, tempo.numero_pilota]
        );
        
        if (pilotaResult.rows.length === 0) {
          errori.push({ numero: tempo.numero_pilota, errore: 'Pilota non trovato' });
          continue;
        }
        
        const id_pilota = pilotaResult.rows[0].id;
        
        const provaResult = await client.query(
          'SELECT id FROM prove_speciali WHERE id_evento = $1 AND numero_prova = $2',
          [id_evento, tempo.numero_prova]
        );
        
        if (provaResult.rows.length === 0) {
          errori.push({ 
            numero: tempo.numero_pilota, 
            prova: tempo.numero_prova, 
            errore: 'Prova non trovata' 
          });
          continue;
        }
        
        const id_prova = provaResult.rows[0].id;
        
        const checkResult = await client.query(
          'SELECT id FROM tempi WHERE id_pilota = $1 AND id_prova = $2',
          [id_pilota, id_prova]
        );
        
        if (checkResult.rows.length > 0) {
          await client.query(`
            UPDATE tempi 
            SET tempo_secondi = $1, penalita = $2, ritirato = $3, updated_at = NOW()
            WHERE id = $4
          `, [tempo.tempo_secondi, tempo.penalita || 0, tempo.ritirato || false, checkResult.rows[0].id]);
          aggiornati++;
        } else {
          await client.query(`
            INSERT INTO tempi (id_pilota, id_prova, tempo_secondi, penalita, ritirato)
            VALUES ($1, $2, $3, $4, $5)
          `, [id_pilota, id_prova, tempo.tempo_secondi, tempo.penalita || 0, tempo.ritirato || false]);
          importati++;
        }
      } catch (err) {
        errori.push({ 
          numero: tempo.numero_pilota, 
          prova: tempo.numero_prova, 
          errore: err.message 
        });
      }
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      importati,
      aggiornati,
      errori: errori.length > 0 ? errori : undefined
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Errore import tempi:', error);
    res.status(500).json({ error: 'Errore import tempi' });
  } finally {
    client.release();
  }
});

// GET - Export replay per Live Timing
app.get('/api/eventi/:id_evento/export-replay', async (req, res) => {
  try {
    const { id_evento } = req.params;
    
    // Verifica evento
    const eventoResult = await pool.query('SELECT nome_evento FROM eventi WHERE id = $1', [id_evento]);
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    // Carica piloti
    const pilotiResult = await pool.query(`
      SELECT id, numero, cognome, nome, classe, moto
      FROM piloti 
      WHERE id_evento = $1
      ORDER BY numero
    `, [id_evento]);
    
    // Carica prove
    const proveResult = await pool.query(`
      SELECT id, numero_prova, nome_prova
      FROM prove_speciali
      WHERE id_evento = $1
      ORDER BY numero_prova
    `, [id_evento]);
    
    // Carica tempi
    const tempiResult = await pool.query(`
      SELECT t.*, p.numero as numero_pilota, ps.numero_prova
      FROM tempi t
      JOIN piloti p ON t.id_pilota = p.id
      JOIN prove_speciali ps ON t.id_prova = ps.id
      WHERE p.id_evento = $1 AND ps.id_evento = $1
      ORDER BY ps.numero_prova, p.numero
    `, [id_evento]);
    
    // Costruisci mappa piloti
    const pilotiMap = {};
    pilotiResult.rows.forEach(p => {
      pilotiMap[p.id] = {
        num: p.numero,
        cognome: p.cognome,
        nome: p.nome,
        classe: p.classe,
        moto: p.moto,
        id: p.id
      };
    });
    
    // Costruisci mappa prove
    const proveMap = {};
    proveResult.rows.forEach(pr => {
      proveMap[pr.id] = pr.numero_prova;
    });
    
    // Costruisci snapshots
    const snapshots = [];
    const prove = proveResult.rows.sort((a, b) => a.numero_prova - b.numero_prova);
    
    for (let i = 0; i < prove.length; i++) {
      const provaCorrente = prove[i];
      const proveFinoAd = prove.slice(0, i + 1);
      
      // Calcola classifica cumulativa
      const classificaPiloti = {};
      
      pilotiResult.rows.forEach(pilota => {
        classificaPiloti[pilota.id] = {
          pos: 0,
          num: pilota.numero,
          cognome: pilota.cognome,
          nome: pilota.nome,
          classe: pilota.classe,
          totale_secondi: 0,
          tempi_prove: {}
        };
      });
      
      // Accumula tempi
      tempiResult.rows.forEach(tempo => {
        const numProva = proveMap[tempo.id_prova];
        if (numProva <= provaCorrente.numero_prova) {
          if (classificaPiloti[tempo.id_pilota]) {
            classificaPiloti[tempo.id_pilota].totale_secondi += tempo.tempo_secondi;
            classificaPiloti[tempo.id_pilota].tempi_prove[`ps${i + 1}`] = tempo.tempo_secondi;
          }
        }
      });
      
      // Ordina per tempo totale
      const classificaArray = Object.values(classificaPiloti)
        .filter(p => p.totale_secondi > 0)
        .sort((a, b) => a.totale_secondi - b.totale_secondi);
      
      // Assegna posizioni e calcola variazioni
      const leader = classificaArray[0];
      const leaderTime = leader ? leader.totale_secondi : 0;
      
      classificaArray.forEach((pilota, idx) => {
        pilota.pos = idx + 1;
        const gap = pilota.totale_secondi - leaderTime;
        pilota.totale = formatTempo(pilota.totale_secondi);
        pilota.var = gap > 0 ? Math.round(gap * 10) / 10 : 0;
        
        // Formatta tempi prove
        for (let j = 1; j <= i + 1; j++) {
          const tempoProva = pilota.tempi_prove[`ps${j}`];
          if (tempoProva) {
            pilota[`ps${j}`] = gap > 0 ? `+${(gap / 10).toFixed(1)}` : "0.0";
            pilota[`ps${j}_time`] = formatTempo(tempoProva);
          } else {
            pilota[`ps${j}`] = null;
            pilota[`ps${j}_time`] = null;
          }
