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

// ==================== AGGIORNA NOMI PROVE DA FICR ====================
app.get('/api/aggiorna-nomi-prove/:id_evento', async (req, res) => {
  const { id_evento } = req.params;
  
  try {
    // 1. Recupera info evento
    const eventoResult = await pool.query('SELECT * FROM eventi WHERE id = $1', [id_evento]);
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    const evento = eventoResult.rows[0];
    const [manifestazione, giorno] = evento.codice_gara.split('-');
    const anno = new Date(evento.data_inizio).getFullYear();
    
    // 2. Determina categoria
    let categoria = 1; // Default: Campionato
    if (evento.nome_evento.toLowerCase().includes('training')) {
      categoria = 2;
    } else if (evento.nome_evento.toLowerCase().includes('regolarità') || evento.nome_evento.toLowerCase().includes('epoca')) {
      categoria = 3;
    }
    
    // 3. Determina equipe basandoti sulla manifestazione
    // Vestenanova = 303 -> equipe 107
    // Isola Vicentina = 11 -> equipe 99
    let equipe = 107; // Default Veneto
    if (manifestazione === '11') {
      equipe = 99; // Treviso per Isola Vicentina
    }
    
    // 4. Prova prima con mpcache-60, poi con mpcache-30
    let programResponse = null;
    let urlProgram = '';
    
    try {
      urlProgram = `https://apienduro.ficr.it/END/mpcache-60/get/program/${anno}/${equipe}/${manifestazione}/${categoria}`;
      programResponse = await axios.get(urlProgram);
    } catch (err) {
      try {
        urlProgram = `https://apienduro.ficr.it/END/mpcache-30/get/program/${anno}/${equipe}/${manifestazione}/${categoria}`;
        programResponse = await axios.get(urlProgram);
      } catch (err2) {
        return res.status(500).json({ 
          error: 'Errore chiamata API FICR', 
          url_tentato_60: `mpcache-60/.../${anno}/${equipe}/${manifestazione}/${categoria}`,
          url_tentato_30: `mpcache-30/.../${anno}/${equipe}/${manifestazione}/${categoria}`,
          errore: err2.message 
        });
      }
    }
    
    if (!programResponse.data?.data || programResponse.data.data.length === 0) {
      return res.status(404).json({ error: 'Nessuna prova trovata su FICR', url_usato: urlProgram });
    }
    
    const proveFICR = programResponse.data.data; // Array ordinato delle prove
    
    // 5. Recupera prove dal database (ordinate per numero_ordine)
    const proveDBResult = await pool.query(
      'SELECT * FROM prove_speciali WHERE id_evento = $1 ORDER BY numero_ordine ASC',
      [id_evento]
    );
    
    if (proveDBResult.rows.length === 0) {
      return res.status(404).json({ error: 'Nessuna prova trovata nel database per questo evento' });
    }
    
    const proveDB = proveDBResult.rows;
    
    // 6. Aggiorna i nomi delle prove
    let aggiornate = 0;
    const dettagli = [];
    
    for (let i = 0; i < Math.min(proveFICR.length, proveDB.length); i++) {
      const provaFICR = proveFICR[i];
      const provaDB = proveDB[i];
      
      const nomeNuovo = `${provaFICR.Sigla} ${provaFICR.Description}`;
      
      await pool.query(
        'UPDATE prove_speciali SET nome_ps = $1 WHERE id = $2',
        [nomeNuovo, provaDB.id]
      );
      
      aggiornate++;
      dettagli.push({
        posizione: i + 1,
        numero_ordine_db: provaDB.numero_ordine,
        nome_vecchio: provaDB.nome_ps,
        nome_nuovo: nomeNuovo,
        sigla: provaFICR.Sigla,
        stage_number_ficr: provaFICR.StageNumber
      });
    }
    
    res.json({
      success: true,
      totale_prove_ficr: proveFICR.length,
      totale_prove_db: proveDB.length,
      aggiornate: aggiornate,
      dettagli: dettagli,
      message: `Aggiornate ${aggiornate} prove con successo`,
      url_usato: urlProgram
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
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
        e.nome_evento
      FROM prove_speciali ps
      JOIN eventi e ON ps.id_evento = e.id
      ORDER BY e.data_inizio DESC, ps.numero_ordine
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prove-speciali', async (req, res) => {
  const { nome_ps, numero_ordine, id_evento, distanza_km, tipo_prova } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO prove_speciali (nome_ps, numero_ordine, id_evento, distanza_km, tipo_prova, stato)
       VALUES ($1, $2, $3, $4, $5, 'non_iniziata')
       RETURNING *`,
      [nome_ps, numero_ordine, id_evento, distanza_km || 0, tipo_prova || 'enduro']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/prove-speciali/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('DELETE FROM prove_speciali WHERE id = $1', [id]);
    res.json({ message: 'Prova speciale eliminata' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== TEMPI ====================

app.get('/api/tempi', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.id,
        t.tempo_secondi,
        t.penalita_secondi,
        p.numero_gara,
        p.nome as pilota_nome,
        p.cognome as pilota_cognome,
        ps.nome_ps,
        ps.numero_ordine,
        e.nome_evento
      FROM tempi t
      JOIN piloti p ON t.id_pilota = p.id
      JOIN prove_speciali ps ON t.id_ps = ps.id
      JOIN eventi e ON p.id_evento = e.id
      ORDER BY e.data_inizio DESC, ps.numero_ordine, t.tempo_secondi
    `);
    res.json(result.rows);
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

// ==================== EXPORT REPLAY ====================

app.get('/api/eventi/:id_evento/export-replay', async (req, res) => {
  const { id_evento } = req.params;
  
  try {
    // 1. Recupera info evento
    const eventoResult = await pool.query('SELECT * FROM eventi WHERE id = $1', [id_evento]);
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    const evento = eventoResult.rows[0];
    
    // 2. Recupera piloti
    const pilotiResult = await pool.query(
      'SELECT id, numero_gara, nome, cognome, classe, moto FROM piloti WHERE id_evento = $1 ORDER BY numero_gara',
      [id_evento]
    );
    
    // 3. Recupera prove
    const proveResult = await pool.query(
      'SELECT id, numero_ordine, nome_ps FROM prove_speciali WHERE id_evento = $1 ORDER BY numero_ordine',
      [id_evento]
    );
    
    // 4. Recupera tutti i tempi
    const tempiResult = await pool.query(
      `SELECT t.id_pilota, ps.numero_ordine, t.tempo_secondi
       FROM tempi t
       JOIN prove_speciali ps ON t.id_ps = ps.id
       WHERE ps.id_evento = $1`,
      [id_evento]
    );
    
    // 5. Organizza tempi per pilota
    const tempiPerPilota = {};
    tempiResult.rows.forEach(t => {
      if (!tempiPerPilota[t.id_pilota]) {
        tempiPerPilota[t.id_pilota] = {};
      }
      tempiPerPilota[t.id_pilota][`ps${t.numero_ordine}`] = t.tempo_secondi;
    });
console.log('=== DEBUG TEMPI ===');
console.log('Totale piloti con tempi:', Object.keys(tempiPerPilota).length);
const primoPilota = Object.keys(tempiPerPilota)[0];
console.log('Primo pilota ID:', primoPilota);
console.log('Tempi primo pilota:', tempiPerPilota[primoPilota]);    
    // 6. Genera snapshots progressivi
    const snapshots = [];
    const numProve = proveResult.rows.length;
    
    for (let psNum = 1; psNum <= numProve; psNum++) {
      // Calcola classifica parziale fino a questa prova
      const classificaParziale = pilotiResult.rows
        .map(p => {
          let tempoTotale = 0;
          const tempi_ps = {};
          
          for (let i = 1; i <= psNum; i++) {
            const tempo = tempiPerPilota[p.id]?.[`ps${i}`];
            if (tempo) {
              tempoTotale += tempo;
              tempi_ps[`ps${i}`] = tempo;
              tempi_ps[`ps${i}_time`] = tempo;
            }
          }
          
          return {
            id_pilota: p.id,
            num: p.numero_gara,
            nome: p.nome,
            cognome: p.cognome,
            classe: p.classe || '',
            moto: p.moto || '',
            tempo_totale_sec: tempoTotale,
            tempi_ps
          };
        })
        .filter(p => p.tempo_totale_sec > 0)
        .sort((a, b) => a.tempo_totale_sec - b.tempo_totale_sec);
      
      // Formatta classifica
      const classifica = classificaParziale.map((p, idx) => {
        const tempoTotale = p.tempo_totale_sec;
        const minutes = Math.floor(tempoTotale / 60);
        const seconds = tempoTotale % 60;
        const pos = idx + 1;
        
        // Dati PS
        const psData = {};
        for (let i = 1; i <= psNum; i++) {
          if (idx === 0) {
            psData[`ps${i}`] = '0.0';
          } else {
            const prevTempo = classificaParziale[idx - 1].tempo_totale_sec;
            const gap = tempoTotale - prevTempo;
            psData[`ps${i}`] = `+${gap.toFixed(1)}`;
          }
          psData[`ps${i}_time`] = p.tempi_ps[`ps${i}_time`] || null;
        }
        
        // PS non ancora corse
        for (let i = psNum + 1; i <= numProve; i++) {
          psData[`ps${i}`] = null;
          psData[`ps${i}_time`] = null;
        }
        
        return {
          pos,
          num: p.num,
          cognome: p.cognome,
          nome: p.nome,
          classe: p.classe,
          ...psData,
          totale: `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`,
          var: 0
        };
      });
      
      snapshots.push({
        step: psNum,
        descrizione: `Dopo ${proveResult.rows[psNum - 1].nome_ps}`,
        prova_corrente: psNum,
        classifica
      });
    }
    
    // 7. Ritorna JSON
    res.json({
      manifestazione: evento.nome_evento,
      prove: proveResult.rows.map(p => ({
        id: p.numero_ordine,
        nome: p.nome_ps
      })),
      piloti: pilotiResult.rows.map(p => ({
        num: p.numero_gara,
        cognome: p.cognome,
        nome: p.nome,
        classe: p.classe || '',
        id: p.id
      })),
      snapshots
    });
    
  } catch (err) {
    console.error('Errore export replay:', err);
    res.status(500).json({ error: err.message });
  }
});
// FIX TEMPORANEO - Crea prove Isola Vicentina
app.get('/api/fix-prove-isola', async (req, res) => {
  try {
    const eventi = [
      { id: '03406500-2c1e-4053-8580-ef4e9e5de0bf', nome: 'Campionato' },
      { id: '8ef1e8a7-fc27-43f8-a3f2-d0694528a6e3', nome: 'Training' },
      { id: '372c0c07-fdad-44be-9ba4-27a3de6bf69f', nome: 'Regolarità' }
    ];
    
    const prove = [2, 3, 5, 6, 8, 9, 11, 12];
    let createdCount = 0;
    
    for (const evento of eventi) {
      for (let i = 0; i < prove.length; i++) {
        await pool.query(
          `INSERT INTO prove_speciali (nome_ps, numero_ordine, id_evento, stato)
          VALUES ($1, $2, $3, 'non_iniziata')`,
          [`Prova ${prove[i]}`, i + 1, evento.id]
        );
        createdCount++;
      }
    }

    res.json({ success: true, prove_create: createdCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// IMPORT TEMPI ISOLA VICENTINA
app.get('/api/import-tempi-isola-campionato', async (req, res) => {
  const ID_EVENTO = '03406500-2c1e-4053-8580-ef4e9e5de0bf';
  const prove = [2, 3, 5, 6, 8, 9, 11, 12];
  
  try {
    let totaleImportati = 0;
    
    for (const numeroProva of prove) {
      // Trova ID prova nel DB
      const provaResult = await pool.query(
        'SELECT id FROM prove_speciali WHERE id_evento = $1 AND nome_ps = $2',
        [ID_EVENTO, `Prova ${numeroProva}`]
      );
      
      if (provaResult.rows.length === 0) continue;
      const id_ps = provaResult.rows[0].id;
      
      // Import da FICR
      const url = `https://apienduro.ficr.it/END/mpcache-5/get/clasps/2025/99/11/1/${numeroProva}/1/*/*/*/*/*`;
      const response = await axios.get(url);
      
      if (!response.data?.data?.clasdella) continue;
      
      const piloti = response.data.data.clasdella;
      
      for (const pilotaFICR of piloti) {
        // Trova pilota
        const pilotaResult = await pool.query(
          'SELECT id FROM piloti WHERE numero_gara = $1 AND id_evento = $2',
          [pilotaFICR.Numero, ID_EVENTO]
        );
        
        let pilotaId;
        if (pilotaResult.rows.length > 0) {
          pilotaId = pilotaResult.rows[0].id;
        } else {
          // Crea pilota
          const nuovoPilota = await pool.query(
            `INSERT INTO piloti (numero_gara, nome, cognome, team, nazione, id_evento, classe, moto)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              pilotaFICR.Numero,
              pilotaFICR.Nome,
              pilotaFICR.Cognome,
              pilotaFICR.Motoclub || '',
              pilotaFICR.Naz || '',
              ID_EVENTO,
              pilotaFICR.Classe || '',
              pilotaFICR.Moto || ''
            ]
          );
          pilotaId = nuovoPilota.rows[0].id;
        }
        
        // Converti tempo
        const tempoStr = pilotaFICR.Tempo;
        if (!tempoStr) continue;
        
        const match = tempoStr.match(/(\d+)'(\d+\.\d+)/);
        if (!match) continue;
        
        const tempoSecondi = parseInt(match[1]) * 60 + parseFloat(match[2]);
        
        // Inserisci tempo
        await pool.query(
          `INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
           VALUES ($1, $2, $3, 0)
           ON CONFLICT (id_pilota, id_ps) DO UPDATE SET tempo_secondi = $3`,
          [pilotaId, id_ps, tempoSecondi]
        );
        
        totaleImportati++;
      }
    }
    
    res.json({ success: true, tempi_importati: totaleImportati });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
