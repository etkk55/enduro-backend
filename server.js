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

// ==================== MIGRATION ====================
app.get('/api/migrate', async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE piloti 
      ADD COLUMN IF NOT EXISTS classe VARCHAR(50),
      ADD COLUMN IF NOT EXISTS moto VARCHAR(100)
    `);
    
    res.json({ success: true, message: 'Colonne classe e moto aggiunte con successo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EVENTI ====================

app.get('/api/eventi', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM eventi ORDER BY data_inizio DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.delete('/api/eventi/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('DELETE FROM tempi WHERE id_pilota IN (SELECT id FROM piloti WHERE id_evento = $1)', [id]);
    await pool.query('DELETE FROM piloti WHERE id_evento = $1', [id]);
    await pool.query('DELETE FROM prove_speciali WHERE id_evento = $1', [id]);
    await pool.query('DELETE FROM eventi WHERE id = $1', [id]);
    
    res.json({ message: 'Evento eliminato con successo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PILOTI ====================

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

app.post('/api/piloti', async (req, res) => {
  const { numero_gara, nome, cognome, id_categoria, team, nazione, email, telefono, id_evento, classe, moto } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO piloti (numero_gara, nome, cognome, id_categoria, team, nazione, email, telefono, id_evento, classe, moto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [numero_gara, nome, cognome, id_categoria, team, nazione, email, telefono, id_evento, classe || '', moto || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/prove-speciali', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        ps.id,
        ps.nome_ps,
        ps.numero_ordine,
        ps.id_evento,
        ps.stato,
        ps.created_at,
        e.nome_evento,
        CONCAT(ps.nome_ps, ' - ', e.nome_evento) as nome_completo
      FROM prove_speciali ps
      LEFT JOIN eventi e ON ps.id_evento = e.id
      ORDER BY e.nome_evento, ps.numero_ordine
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ==================== AGGIORNA CLASSE/MOTO ====================
app.get('/api/aggiorna-classe-moto/:id_evento', async (req, res) => {
  const { id_evento } = req.params;
  
  try {
    const eventoResult = await pool.query('SELECT * FROM eventi WHERE id = $1', [id_evento]);
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    const evento = eventoResult.rows[0];
    const [manifestazione, giorno] = evento.codice_gara.split('-');
    const anno = new Date(evento.data_inizio).getFullYear();
    
    const pilotiResult = await pool.query(
      'SELECT * FROM piloti WHERE id_evento = $1',
      [id_evento]
    );
    
    let aggiornati = 0;
    let errori = 0;
    
    for (const pilota of pilotiResult.rows) {
      try {
        const url = `https://apienduro.ficr.it/END/mpcache-5/get/clasps/${anno}/107/${manifestazione}/${giorno}/2/1/*/*/*/*/*`;
        const response = await axios.get(url);
        
        if (response.data?.data?.clasdella) {
          const pilotaFICR = response.data.data.clasdella.find(
            p => p.Numero === pilota.numero_gara
          );
          
          if (pilotaFICR) {
            await pool.query(
              `UPDATE piloti 
               SET classe = $1, moto = $2
               WHERE id = $3`,
              [
                pilotaFICR.Classe || pilotaFICR.ClasseDescr || '',
                pilotaFICR.Moto || '',
                pilota.id
              ]
            );
            aggiornati++;
          }
        }
      } catch (err) {
        errori++;
        console.error(`Errore pilota ${pilota.numero_gara}:`, err.message);
      }
    }
    
    res.json({
      success: true,
      totale_piloti: pilotiResult.rows.length,
      aggiornati: aggiornati,
      errori: errori,
      message: `Aggiornati ${aggiornati} piloti su ${pilotiResult.rows.length}`
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== TEMPI ====================

app.get('/api/tempi/:id_ps', async (req, res) => {
  const { id_ps } = req.params;
  
  try {
    const psInfo = await pool.query(`
      SELECT ps.*, e.id as evento_id, e.nome_evento
      FROM prove_speciali ps
      JOIN eventi e ON ps.id_evento = e.id
      WHERE ps.id = $1
    `, [id_ps]);
    
    if (psInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Prova speciale non trovata' });
    }
    
    const eventoId = psInfo.rows[0].evento_id;
    
    const tempiProva = await pool.query(`
      SELECT 
        t.id,
        t.tempo_secondi,
        t.penalita_secondi,
        p.numero_gara,
        p.nome,
        p.cognome,
        COALESCE(p.classe, '') as classe,
        COALESCE(p.moto, '') as moto,
        ps.nome_ps
      FROM tempi t
      JOIN piloti p ON t.id_pilota = p.id
      JOIN prove_speciali ps ON t.id_ps = ps.id
      WHERE t.id_ps = $1
      ORDER BY t.tempo_secondi ASC
    `, [id_ps]);
    
    // Query migliorata: filtra solo chi ha fatto TUTTE le prove fino a questa
    const tempiCumulativi = await pool.query(`
      WITH prove_fino_a_qui AS (
        SELECT COUNT(*) as num_prove
        FROM prove_speciali
        WHERE id_evento = $1 
          AND numero_ordine <= (SELECT numero_ordine FROM prove_speciali WHERE id = $2)
      )
      SELECT 
        p.numero_gara,
        p.nome,
        p.cognome,
        COALESCE(p.classe, '') as classe,
        COALESCE(p.moto, '') as moto,
        SUM(t.tempo_secondi + COALESCE(t.penalita_secondi, 0)) as tempo_totale,
        COUNT(DISTINCT t.id_ps) as prove_fatte
      FROM piloti p
      JOIN tempi t ON p.id = t.id_pilota
      JOIN prove_speciali ps ON t.id_ps = ps.id
      WHERE p.id_evento = $1 
        AND ps.numero_ordine <= (SELECT numero_ordine FROM prove_speciali WHERE id = $2)
      GROUP BY p.id, p.numero_gara, p.nome, p.cognome, p.classe, p.moto
      HAVING COUNT(DISTINCT t.id_ps) = (SELECT num_prove FROM prove_fino_a_qui)
      ORDER BY tempo_totale ASC
    `, [eventoId, id_ps]);
    
    const classificaDella = tempiProva.rows.map((row, index) => {
      const minuti = Math.floor(row.tempo_secondi / 60);
      const secondi = (row.tempo_secondi % 60).toFixed(2);
      
      let distacco = '';
      if (index > 0) {
        const diff = row.tempo_secondi - tempiProva.rows[0].tempo_secondi;
        distacco = `+${diff.toFixed(2)}s`;
      }
      
      return {
        posizione: index + 1,
        numero_gara: row.numero_gara,
        pilota: `${row.nome} ${row.cognome}`,
        classe: row.classe || '',
        moto: row.moto || '',
        tempo: `${minuti}'${secondi.padStart(5, '0')}"`,
        tempo_raw: row.tempo_secondi,
        distacco: distacco
      };
    });
    
    const classificaDopo = tempiCumulativi.rows.map((row, index) => {
      const minuti = Math.floor(row.tempo_totale / 60);
      const secondi = (row.tempo_totale % 60).toFixed(2);
      
      let distacco = '';
      if (index > 0) {
        const diff = row.tempo_totale - tempiCumulativi.rows[0].tempo_totale;
        const diffMin = Math.floor(diff / 60);
        const diffSec = (diff % 60).toFixed(2);
        distacco = `+${diffMin}'${diffSec.padStart(5, '0')}"`;
      }
      
      return {
        posizione: index + 1,
        numero_gara: row.numero_gara,
        pilota: `${row.nome} ${row.cognome}`,
        classe: row.classe || '',
        moto: row.moto || '',
        tempo: `${minuti}'${secondi.padStart(5, '0')}"`,
        tempo_raw: row.tempo_totale,
        distacco: distacco
      };
    });
    
    res.json({
      prova_info: psInfo.rows[0],
      classifica_della: classificaDella,
      classifica_dopo: classificaDopo
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/classifiche/:id_evento', async (req, res) => {
  const { id_evento } = req.params;
  
  try {
    const result = await pool.query(`
      WITH prove_evento AS (
        SELECT COUNT(*) as totale_prove
        FROM prove_speciali
        WHERE id_evento = $1
      )
      SELECT 
        p.numero_gara,
        p.nome,
        p.cognome,
        COALESCE(p.classe, '') as classe,
        COALESCE(p.moto, '') as moto,
        COALESCE(p.team, '') as team,
        SUM(t.tempo_secondi + COALESCE(t.penalita_secondi, 0)) as tempo_totale,
        COUNT(DISTINCT t.id_ps) as prove_completate,
        (SELECT totale_prove FROM prove_evento) as totale_prove_evento
      FROM piloti p
      JOIN tempi t ON p.id = t.id_pilota
      JOIN prove_speciali ps ON t.id_ps = ps.id
      WHERE p.id_evento = $1 AND ps.id_evento = $1
      GROUP BY p.id, p.numero_gara, p.nome, p.cognome, p.classe, p.moto, p.team
      HAVING COUNT(DISTINCT t.id_ps) = (SELECT totale_prove FROM prove_evento)
      ORDER BY tempo_totale ASC
    `, [id_evento]);
    
    const classificaFormattata = result.rows.map((row, index) => {
      const minuti = Math.floor(row.tempo_totale / 60);
      const secondi = (row.tempo_totale % 60).toFixed(2);
      
      let distacco = '';
      if (index > 0) {
        const diff = row.tempo_totale - result.rows[0].tempo_totale;
        const diffMinuti = Math.floor(diff / 60);
        const diffSecondi = (diff % 60).toFixed(2);
        distacco = `${diffMinuti}'${diffSecondi.padStart(5, '0')}"`;
      }
      
      return {
        posizione: index + 1,
        numero_gara: row.numero_gara,
        pilota: `${row.nome} ${row.cognome}`,
        classe: row.classe || '',
        moto: row.moto || '',
        team: row.team || '',
        tempo_totale: `${minuti}'${secondi.padStart(5, '0')}"`,
        tempo_totale_raw: row.tempo_totale,
        distacco: distacco,
        prove_completate: row.prove_completate,
        totale_prove: row.totale_prove_evento
      };
    });
    
    res.json(classificaFormattata);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    
    const classificaFormattata = result.rows.map((row, index) => {
      const minuti = Math.floor(row.tempo_totale / 60);
      const secondi = (row.tempo_totale % 60).toFixed(2);
      
      let distacco = '';
      if (index > 0) {
        const diff = row.tempo_totale - result.rows[0].tempo_totale;
        const diffMinuti = Math.floor(diff / 60);
        const diffSecondi = (diff % 60).toFixed(2);
        distacco = `${diffMinuti}'${diffSecondi.padStart(5, '0')}"`;
      }
      
      return {
        posizione: index + 1,
        numero_gara: row.numero_gara,
        pilota: `${row.nome} ${row.cognome}`,
        evento: row.nome_evento,
        tempo_totale: `${minuti}'${secondi.padStart(5, '0')}"`,
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

function convertiTempoFICR(tempoStr) {
  if (!tempoStr || tempoStr === '') return null;
  
  const match = tempoStr.match(/(\d+)'(\d+\.\d+)/);
  if (!match) return null;
  
  const minuti = parseInt(match[1]);
  const secondi = parseFloat(match[2]);
  
  return minuti * 60 + secondi;
}

app.post('/api/import-ficr', async (req, res) => {
  const { anno, codiceEquipe, manifestazione, giorno, prova, categoria, id_evento, id_ps } = req.body;
  
  try {
    const url = `https://apienduro.ficr.it/END/mpcache-5/get/clasps/${anno}/${codiceEquipe}/${manifestazione}/${giorno}/${prova}/${categoria}/*/*/*/*/*`;
    const response = await axios.get(url);
    
    if (!response.data || !response.data.data || !response.data.data.clasdella) {
      return res.status(404).json({ error: 'Dati non trovati su FICR' });
    }
    
    const piloti = response.data.data.clasdella;
    
    let pilotiImportati = 0;
    let pilotiAggiornati = 0;
    let tempiImportati = 0;
    
    for (const pilotaFICR of piloti) {
      let pilotaId;
      const pilotaEsistente = await pool.query(
        'SELECT id FROM piloti WHERE numero_gara = $1 AND id_evento = $2',
        [pilotaFICR.Numero, id_evento]
      );
      
      if (pilotaEsistente.rows.length > 0) {
        pilotaId = pilotaEsistente.rows[0].id;
        
        await pool.query(
          `UPDATE piloti 
           SET classe = COALESCE(NULLIF(classe, ''), $1),
               moto = COALESCE(NULLIF(moto, ''), $2)
           WHERE id = $3`,
          [
            pilotaFICR.Classe || pilotaFICR.ClasseDescr || '',
            pilotaFICR.Moto || '',
            pilotaId
          ]
        );
        pilotiAggiornati++;
      } else {
        const nuovoPilota = await pool.query(
          `INSERT INTO piloti (numero_gara, nome, cognome, team, nazione, id_evento, classe, moto)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            pilotaFICR.Numero,
            pilotaFICR.Nome,
            pilotaFICR.Cognome,
            pilotaFICR.Motoclub || '',
            pilotaFICR.Naz || '',
            id_evento,
            pilotaFICR.Classe || pilotaFICR.ClasseDescr || '',
            pilotaFICR.Moto || ''
          ]
        );
        pilotaId = nuovoPilota.rows[0].id;
        pilotiImportati++;
      }
      
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
      pilotiAggiornati,
      tempiImportati,
      totale: piloti.length
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CATEGORIE ====================

app.get('/api/categorie', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categorie ORDER BY nome_categoria');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
