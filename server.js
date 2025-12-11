// require('dotenv').config(); // DISABLED: Railway injects env vars directly
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS - Allow all origins
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// PostgreSQL Pool - Railway provides DATABASE_URL as environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test DB Connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully at:', res.rows[0].now);
    
    // Auto-migrazione: aggiungi colonne PDF se non esistono
    pool.query(`
      ALTER TABLE comunicati 
      ADD COLUMN IF NOT EXISTS pdf_allegato TEXT,
      ADD COLUMN IF NOT EXISTS pdf_nome VARCHAR(255);
    `).then(() => {
      console.log('Migrazione comunicati PDF completata');
      
      // Crea funzione get_next_comunicato_number se non esiste
      return pool.query(`
        CREATE OR REPLACE FUNCTION get_next_comunicato_number(p_codice_gara VARCHAR)
        RETURNS INTEGER AS $$
        DECLARE
          next_num INTEGER;
        BEGIN
          SELECT COALESCE(MAX(numero), 0) + 1 INTO next_num
          FROM comunicati
          WHERE codice_gara = p_codice_gara;
          RETURN next_num;
        END;
        $$ LANGUAGE plpgsql;
      `);
    }).then(() => {
      console.log('Funzione get_next_comunicato_number creata');
    }).catch(err => {
      console.error('Errore migrazione:', err);
    });
  }
});

// ==================== EVENTI ====================

// GET tutti gli eventi
app.get('/api/eventi', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM eventi ORDER BY data_inizio DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/eventi] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET evento singolo
app.get('/api/eventi/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM eventi WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crea evento
app.post('/api/eventi', async (req, res) => {
  try {
    const { 
      nome_evento, 
      codice_gara,
      data_inizio,
      data_fine, 
      luogo,
      descrizione 
    } = req.body;
    
    // UPSERT: aggiorna se esiste, crea se non esiste
    const result = await pool.query(
      `INSERT INTO eventi (nome_evento, codice_gara, data_inizio, data_fine, luogo, descrizione) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       ON CONFLICT (codice_gara) 
       DO UPDATE SET 
         nome_evento = EXCLUDED.nome_evento,
         data_inizio = EXCLUDED.data_inizio,
         data_fine = EXCLUDED.data_fine,
         luogo = EXCLUDED.luogo,
         descrizione = EXCLUDED.descrizione
       RETURNING *`,
      [nome_evento, codice_gara, data_inizio, data_fine || data_inizio, luogo, descrizione || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[POST /api/eventi] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE evento
app.delete('/api/eventi/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM eventi WHERE id = $1', [id]);
    res.json({ message: 'Evento eliminato' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PILOTI ====================

// GET tutti i piloti
app.get('/api/piloti', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM piloti ORDER BY id_evento, numero_gara');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET piloti per evento
app.get('/api/eventi/:id_evento/piloti', async (req, res) => {
  try {
    const { id_evento } = req.params;
    const result = await pool.query(
      'SELECT * FROM piloti WHERE id_evento = $1 ORDER BY numero_gara',
      [id_evento]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crea pilota
app.post('/api/piloti', async (req, res) => {
  try {
    const { numero_gara, nome, cognome, team, nazione, id_evento, classe, moto } = req.body;
    const result = await pool.query(
      'INSERT INTO piloti (numero_gara, nome, cognome, team, nazione, id_evento, classe, moto) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [numero_gara, nome, cognome, team, nazione, id_evento, classe, moto]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE pilota
app.delete('/api/piloti/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM piloti WHERE id = $1', [id]);
    res.json({ message: 'Pilota eliminato' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PROVE SPECIALI ====================

// GET prove per evento
app.get('/api/eventi/:id_evento/prove', async (req, res) => {
  try {
    const { id_evento } = req.params;
    const result = await pool.query(
      'SELECT * FROM prove_speciali WHERE id_evento = $1 ORDER BY numero_ordine',
      [id_evento]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crea prova speciale
app.post('/api/prove', async (req, res) => {
  try {
    const { nome_ps, numero_ordine, id_evento, stato } = req.body;
    const result = await pool.query(
      'INSERT INTO prove_speciali (nome_ps, numero_ordine, id_evento, stato) VALUES ($1, $2, $3, $4) RETURNING *',
      [nome_ps, numero_ordine, id_evento, stato || 'non_iniziata']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alias per compatibilità
app.post('/api/prove-speciali', async (req, res) => {
  try {
    const { nome_ps, numero_ordine, id_evento, stato } = req.body;
    const result = await pool.query(
      'INSERT INTO prove_speciali (nome_ps, numero_ordine, id_evento, stato) VALUES ($1, $2, $3, $4) RETURNING *',
      [nome_ps, numero_ordine, id_evento, stato || 'non_iniziata']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT aggiorna stato prova
app.put('/api/prove/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { stato } = req.body;
    const result = await pool.query(
      'UPDATE prove_speciali SET stato = $1 WHERE id = $2 RETURNING *',
      [stato, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE prova
app.delete('/api/prove/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM prove_speciali WHERE id = $1', [id]);
    res.json({ message: 'Prova eliminata' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== TEMPI ====================

// GET tempi per prova
app.get('/api/prove/:id_ps/tempi', async (req, res) => {
  try {
    const { id_ps } = req.params;
    const result = await pool.query(
      `SELECT t.*, p.numero_gara, p.nome, p.cognome, p.classe 
       FROM tempi t
       JOIN piloti p ON t.id_pilota = p.id
       WHERE t.id_ps = $1
       ORDER BY t.tempo_secondi`,
      [id_ps]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST inserisci tempo
app.post('/api/tempi', async (req, res) => {
  try {
    const { id_pilota, id_ps, tempo_secondi, penalita_secondi } = req.body;
    const result = await pool.query(
      'INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi) VALUES ($1, $2, $3, $4) RETURNING *',
      [id_pilota, id_ps, tempo_secondi, penalita_secondi || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLASSIFICHE ====================

// GET classifica per evento
app.get('/api/eventi/:id_evento/classifica', async (req, res) => {
  try {
    const { id_evento } = req.params;
    const result = await pool.query(
      `SELECT 
        p.id,
        p.numero_gara,
        p.nome,
        p.cognome,
        p.classe,
        p.team,
        SUM(t.tempo_secondi + t.penalita_secondi) as tempo_totale
       FROM piloti p
       LEFT JOIN tempi t ON p.id = t.id_pilota
       LEFT JOIN prove_speciali ps ON t.id_ps = ps.id
       WHERE p.id_evento = $1
       GROUP BY p.id
       ORDER BY tempo_totale ASC NULLS LAST`,
      [id_evento]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== IMPORT FICR ====================

// GET lista manifestazioni FICR
app.get('/api/ficr/manifestazioni', async (req, res) => {
  try {
    const url = 'https://apienduro.ficr.it/END/mpcache-5/get/manilista/2025';
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST import piloti da FICR
app.post('/api/ficr/import-piloti', async (req, res) => {
  try {
    const { id_evento, anno, id_manif, id_prova, giorno_prova } = req.body;
    
    const url = `https://apienduro.ficr.it/END/mpcache-5/get/iscbycog/${anno}/${id_manif}/${id_prova}/${giorno_prova}/*/1`;
    const response = await axios.get(url);
    
    if (!response.data?.data?.iscrdella) {
      return res.status(404).json({ error: 'Nessun pilota trovato' });
    }
    
    const piloti = response.data.data.iscrdella;
    let pilotiImportati = 0;
    let pilotiAggiornati = 0;
    
    for (const pilotaFICR of piloti) {
      const checkResult = await pool.query(
        'SELECT id FROM piloti WHERE numero_gara = $1 AND id_evento = $2',
        [pilotaFICR.Numero, id_evento]
      );
      
      if (checkResult.rows.length > 0) {
        await pool.query(
          `UPDATE piloti SET 
            nome = $1, cognome = $2, team = $3, nazione = $4, classe = $5, moto = $6
           WHERE id = $7`,
          [
            pilotaFICR.Nome,
            pilotaFICR.Cognome,
            pilotaFICR.Motoclub || '',
            pilotaFICR.Naz || '',
            pilotaFICR.Classe || '',
            pilotaFICR.Moto || '',
            checkResult.rows[0].id
          ]
        );
        pilotiAggiornati++;
      } else {
        await pool.query(
          `INSERT INTO piloti (numero_gara, nome, cognome, team, nazione, id_evento, classe, moto)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            pilotaFICR.Numero,
            pilotaFICR.Nome,
            pilotaFICR.Cognome,
            pilotaFICR.Motoclub || '',
            pilotaFICR.Naz || '',
            id_evento,
            pilotaFICR.Classe || '',
            pilotaFICR.Moto || ''
          ]
        );
        pilotiImportati++;
      }
    }
    
    res.json({ 
      success: true, 
      pilotiImportati,
      pilotiAggiornati,
      totale: piloti.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST import tempi da FICR
app.post('/api/ficr/import-tempi', async (req, res) => {
  try {
    const { id_ps, anno, id_manif, id_prova, giorno_prova, numero_prova } = req.body;
    
    const url = `https://apienduro.ficr.it/END/mpcache-5/get/clasps/${anno}/${id_manif}/${id_prova}/${giorno_prova}/${numero_prova}/1/*/*/*/*/*`;
    const response = await axios.get(url);
    
    if (!response.data?.data?.clasdella) {
      return res.status(404).json({ error: 'Nessun tempo trovato' });
    }
    
    const tempi = response.data.data.clasdella;
    let tempiImportati = 0;
    
    // Ottieni id_evento dalla prova
    const provaResult = await pool.query('SELECT id_evento FROM prove_speciali WHERE id = $1', [id_ps]);
    if (provaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Prova non trovata' });
    }
    const id_evento = provaResult.rows[0].id_evento;
    
    for (const tempoFICR of tempi) {
      const pilotaResult = await pool.query(
        'SELECT id FROM piloti WHERE numero_gara = $1 AND id_evento = $2',
        [tempoFICR.Numero, id_evento]
      );
      
      if (pilotaResult.rows.length === 0) continue;
      
      const id_pilota = pilotaResult.rows[0].id;
      const tempoStr = tempoFICR.Tempo;
      
      if (!tempoStr) continue;
      
      const match = tempoStr.match(/(\d+)'(\d+\.\d+)/);
      if (!match) continue;
      
      const tempoSecondi = parseInt(match[1]) * 60 + parseFloat(match[2]);
      
      await pool.query(
        `INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (id_pilota, id_ps) 
         DO UPDATE SET tempo_secondi = $3`,
        [id_pilota, id_ps, tempoSecondi]
      );
      
      tempiImportati++;
    }
    
    res.json({ success: true, tempiImportati });
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

// ==================== UTILITY ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ==================== IMPORT PILOTI DA FICR PER ISOLA VICENTINA ====================

app.get('/api/import-piloti-isola', async (req, res) => {
  const EVENTI = [
    { id: '03406500-2c1e-4053-8580-ef4e9e5de0bf', nome: 'Campionato' },
    { id: '8ef1e8a7-fc27-43f8-a3f2-d0694528a6e3', nome: 'Training' },
    { id: '372c0c07-fdad-44be-9ba4-27a3de6bf69f', nome: 'Regolarità' }
  ];
  
  try {
    let totaleImportati = 0;
    let totaleAggiornati = 0;
    
    for (const evento of EVENTI) {
      const url = 'https://apienduro.ficr.it/END/mpcache-5/get/iscbycog/2025/99/11/1/*/1';
      const response = await axios.get(url);
      
      if (!response.data?.data?.iscrdella) continue;
      
      const piloti = response.data.data.iscrdella;
      
      for (const pilotaFICR of piloti) {
        const checkResult = await pool.query(
          'SELECT id FROM piloti WHERE numero_gara = $1 AND id_evento = $2',
          [pilotaFICR.Numero, evento.id]
        );
        
        if (checkResult.rows.length > 0) {
          await pool.query(
            `UPDATE piloti SET 
              nome = $1, cognome = $2, team = $3, nazione = $4, classe = $5, moto = $6
             WHERE id = $7`,
            [
              pilotaFICR.Nome,
              pilotaFICR.Cognome,
              pilotaFICR.Motoclub || '',
              pilotaFICR.Naz || '',
              pilotaFICR.Classe || '',
              pilotaFICR.Moto || '',
              checkResult.rows[0].id
            ]
          );
          totaleAggiornati++;
        } else {
          await pool.query(
            `INSERT INTO piloti (numero_gara, nome, cognome, team, nazione, id_evento, classe, moto)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              pilotaFICR.Numero,
              pilotaFICR.Nome,
              pilotaFICR.Cognome,
              pilotaFICR.Motoclub || '',
              pilotaFICR.Naz || '',
              evento.id,
              pilotaFICR.Classe || '',
              pilotaFICR.Moto || ''
            ]
          );
          totaleImportati++;
        }
      }
    }
    
    res.json({ 
      success: true,
      pilotiImportati: totaleImportati,
      pilotiAggiornati: totaleAggiornati
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EXPORT REPLAY ====================
// FIX Chat 13: Gap e variazioni calcolati per ogni PS separatamente
  
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
      tempiPerPilota[t.id_pilota][`ps${t.numero_ordine}`] = parseFloat(t.tempo_secondi);
    });
    
    const numProve = proveResult.rows.length;
    const proveReali = proveResult.rows.map(p => p.numero_ordine);
    
    // ============================================
    // FIX: Pre-calcola storia per ogni pilota
    // Per ogni prova: tempo cumulativo, posizione, gap
    // ============================================
    
    // 6. Calcola tempi cumulativi per ogni pilota dopo ogni prova
    const pilotiConStoria = pilotiResult.rows.map(p => {
      const storia = {};
      let tempoCumulativo = 0;
      let proveCompletate = 0;
      
      for (let psIdx = 0; psIdx < numProve; psIdx++) {
        const numProva = proveReali[psIdx];
        const tempo = tempiPerPilota[p.id]?.[`ps${numProva}`];
        
        if (tempo) {
          tempoCumulativo += tempo;
          proveCompletate++;
          storia[psIdx] = {
            tempoCumulativo,
            tempoProva: tempo,
            completata: true,
            proveCompletate
          };
        } else {
          storia[psIdx] = {
            tempoCumulativo,
            tempoProva: null,
            completata: false,
            proveCompletate
          };
        }
      }
      
      return {
        id: p.id,
        num: p.numero_gara,
        nome: p.nome,
        cognome: p.cognome,
        classe: p.classe || '',
        moto: p.moto || '',
        storia,
        totalProveCompletate: proveCompletate
      };
    });
    
    // 7. Per ogni prova, calcola posizioni e gap progressivi
    for (let psIdx = 0; psIdx < numProve; psIdx++) {
      // Filtra piloti che hanno completato TUTTE le prove fino a questa
      const pilotiValidi = pilotiConStoria.filter(p => {
        for (let i = 0; i <= psIdx; i++) {
          if (!p.storia[i]?.completata) return false;
        }
        return true;
      });
      
      // Ordina per tempo cumulativo dopo questa prova
      pilotiValidi.sort((a, b) => a.storia[psIdx].tempoCumulativo - b.storia[psIdx].tempoCumulativo);
      
      // Assegna posizioni e gap
      pilotiValidi.forEach((p, idx) => {
        p.storia[psIdx].posizione = idx + 1;
        
        if (idx === 0) {
          p.storia[psIdx].gap = 0;
          p.storia[psIdx].gapStr = '0.0';
        } else {
          const gapSec = p.storia[psIdx].tempoCumulativo - pilotiValidi[idx - 1].storia[psIdx].tempoCumulativo;
          p.storia[psIdx].gap = gapSec;
          p.storia[psIdx].gapStr = `+${gapSec.toFixed(1)}`;
        }
        
        // Calcola variazione rispetto alla prova precedente
        if (psIdx === 0) {
          p.storia[psIdx].variazione = 0;
        } else if (p.storia[psIdx - 1]?.posizione) {
          p.storia[psIdx].variazione = p.storia[psIdx - 1].posizione - p.storia[psIdx].posizione;
        } else {
          p.storia[psIdx].variazione = 0;
        }
      });
      
      // Piloti non validi (ritirati) - nessuna posizione per questa prova
      pilotiConStoria.filter(p => !pilotiValidi.includes(p)).forEach(p => {
        if (!p.storia[psIdx]) p.storia[psIdx] = {};
        p.storia[psIdx].posizione = null;
        p.storia[psIdx].gap = null;
        p.storia[psIdx].gapStr = null;
        p.storia[psIdx].variazione = 0;
      });
    }
    
    // 8. Genera snapshots usando la storia pre-calcolata
    const snapshots = [];
    
    for (let psIdx = 0; psIdx < numProve; psIdx++) {
      const proveRichieste = psIdx + 1;
      
      // Separa attivi e ritirati per questo snapshot
      const pilotiAttivi = pilotiConStoria
        .filter(p => p.storia[psIdx]?.posizione !== null && p.storia[psIdx]?.posizione !== undefined)
        .sort((a, b) => a.storia[psIdx].posizione - b.storia[psIdx].posizione);
      
      const pilotiRitirati = pilotiConStoria
        .filter(p => {
          // Ha almeno una prova ma non tutte fino a questa
          const haAlmenoUna = p.totalProveCompletate > 0;
          const nonTutte = p.storia[psIdx]?.posizione === null || p.storia[psIdx]?.posizione === undefined;
          return haAlmenoUna && nonTutte;
        })
        .sort((a, b) => b.totalProveCompletate - a.totalProveCompletate);
      
      // Formatta classifica attivi con gap e variazioni PER OGNI PS
      const classificaAttivi = pilotiAttivi.map((p, idx) => {
        const tempoTotale = p.storia[psIdx].tempoCumulativo;
        const minutes = Math.floor(tempoTotale / 60);
        const seconds = tempoTotale % 60;
        const pos = p.storia[psIdx].posizione;
        
        // Dati PS: usa gap e variazione calcolati per OGNI prova
        const psData = {};
        for (let i = 0; i <= psIdx; i++) {
          const numProva = proveReali[i];
          // Gap specifico di quella prova (non il totale!)
          psData[`ps${i+1}`] = p.storia[i]?.gapStr || '--';
          psData[`ps${i+1}_time`] = p.storia[i]?.tempoProva || null;
          // Variazione specifica di quella prova
          psData[`var${i+1}`] = p.storia[i]?.variazione || 0;
          // Posizione in quella prova specifica
          psData[`pos${i+1}`] = p.storia[i]?.posizione || null;
        }
        
        // PS non ancora corse
        for (let i = psIdx + 1; i < numProve; i++) {
          psData[`ps${i+1}`] = null;
          psData[`ps${i+1}_time`] = null;
          psData[`var${i+1}`] = null;
          psData[`pos${i+1}`] = null;
        }
        
        return {
          pos,
          num: p.num,
          cognome: p.cognome,
          nome: p.nome,
          classe: p.classe,
          ...psData,
          totale: `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`,
          var: p.storia[psIdx]?.variazione || 0,  // var globale per compatibilità
          stato: 'attivo'
        };
      });
      
      // Formatta classifica ritirati
      const classificaRitirati = pilotiRitirati.map((p, idx) => {
        const lastCompleted = Object.values(p.storia).filter(s => s.completata).length;
        const tempoTotale = p.storia[psIdx]?.tempoCumulativo || 0;
        const minutes = Math.floor(tempoTotale / 60);
        const seconds = tempoTotale % 60;
        const posRit = pilotiAttivi.length + idx + 1;
        
        // Dati PS per ritirati
        const psData = {};
        for (let i = 0; i <= psIdx; i++) {
          const numProva = proveReali[i];
          if (p.storia[i]?.completata) {
            psData[`ps${i+1}`] = p.storia[i]?.gapStr || '+RIT';
          } else {
            psData[`ps${i+1}`] = 'RIT';
          }
          psData[`ps${i+1}_time`] = p.storia[i]?.tempoProva || null;
          psData[`var${i+1}`] = p.storia[i]?.variazione || 0;
          psData[`pos${i+1}`] = p.storia[i]?.posizione || null;
        }
        
        // PS non ancora corse
        for (let i = psIdx + 1; i < numProve; i++) {
          psData[`ps${i+1}`] = null;
          psData[`ps${i+1}_time`] = null;
          psData[`var${i+1}`] = null;
          psData[`pos${i+1}`] = null;
        }
        
        return {
          pos: posRit,
          num: p.num,
          cognome: p.cognome,
          nome: p.nome,
          classe: p.classe,
          ...psData,
          totale: `RIT (${lastCompleted}/${proveRichieste})`,
          var: 0,
          stato: 'ritirato'
        };
      });
      
      // Combina classifica
      const classifica = [...classificaAttivi, ...classificaRitirati];
      
      snapshots.push({
        step: psIdx + 1,
        descrizione: `Dopo ${proveResult.rows[psIdx].nome_ps}`,
        prova_corrente: psIdx + 1,
        classifica
      });
    }
    
    // 9. Ritorna JSON
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

// ==================== IMPORT UNIVERSALE TUTTE LE GARE ====================
app.get('/api/import-tempi-isola/:tipo_gara', async (req, res) => {
  const { tipo_gara } = req.params;
  
  const EVENTI_MAP = {
    'campionato': '03406500-2c1e-4053-8580-ef4e9e5de0bf',
    'training': '8ef1e8a7-fc27-43f8-a3f2-d0694528a6e3',
    'regolarita': '372c0c07-fdad-44be-9ba4-27a3de6bf69f'
  };
  
  const ID_EVENTO = EVENTI_MAP[tipo_gara];
  if (!ID_EVENTO) {
    return res.status(400).json({ error: 'Tipo gara non valido. Usa: campionato, training, regolarita' });
  }
  
  const prove = [2, 3, 5, 6, 8, 9, 11, 12];
  
  try {
    let totaleImportati = 0;
    let dettagli = [];
   
    for (const numeroProva of prove) {
      const provaResult = await pool.query(
        'SELECT id FROM prove_speciali WHERE id_evento = $1 AND nome_ps = $2',
        [ID_EVENTO, `Prova ${numeroProva}`]
      );
      
      if (provaResult.rows.length === 0) {
        dettagli.push({ prova: numeroProva, status: 'prova non trovata nel DB' });
        continue;
      }
      
      const id_ps = provaResult.rows[0].id;
      const url = `https://apienduro.ficr.it/END/mpcache-5/get/clasps/2025/99/11/1/${numeroProva}/1/*/*/*/*/*`;
      
      try {
        const response = await axios.get(url);
        
        if (!response.data?.data?.clasdella) {
          dettagli.push({ prova: numeroProva, status: 'nessun dato da FICR' });
          continue;
        }
        
        const piloti = response.data.data.clasdella;
        let importatiProva = 0;
        
        for (const pilotaFICR of piloti) {
          const pilotaResult = await pool.query(
            'SELECT id FROM piloti WHERE numero_gara = $1 AND id_evento = $2',
            [pilotaFICR.Numero, ID_EVENTO]
          );
      
          let pilotaId;
          if (pilotaResult.rows.length > 0) {
            pilotaId = pilotaResult.rows[0].id;
          } else {
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
    
          const tempoStr = pilotaFICR.Tempo;
          if (!tempoStr) continue;
      
          const match = tempoStr.match(/(\d+)'(\d+\.\d+)/);
          if (!match) continue;
        
          const tempoSecondi = parseInt(match[1]) * 60 + parseFloat(match[2]);
        
          await pool.query(
            `INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (id_pilota, id_ps) DO UPDATE SET tempo_secondi = $3`,
            [pilotaId, id_ps, tempoSecondi]
          );
          
          importatiProva++;
          totaleImportati++;
        }
        
        dettagli.push({ prova: numeroProva, status: 'ok', tempi: importatiProva });
        
      } catch (err) {
        dettagli.push({ prova: numeroProva, status: 'errore FICR API', error: err.message });
      }
    }
          
    res.json({ 
      success: true, 
      tipo_gara,
      tempi_importati: totaleImportati,
      dettagli 
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== NUOVO: LISTA MANIFESTAZIONI FICR ====================
app.get('/api/ficr/manifestazioni', async (req, res) => {
  try {
    const anno = req.query.anno || new Date().getFullYear();
    
    const url = `https://apienduro.ficr.it/END/mpcache-30/get/schedule/${anno}/*/*`;
    const response = await axios.get(url);
    
    // Estrai array data se presente
    const gare = response.data?.data || response.data;
    
    res.json(gare);
    
  } catch (err) {
    res.status(500).json({ error: 'Errore chiamata API FICR: ' + err.message });
  }
});

// ==================== NUOVO: IMPORT FICR GENERICO ====================
app.post('/api/import-ficr', async (req, res) => {
  try {
    const { 
      anno, 
      codiceEquipe, 
      manifestazione, 
      giorno, 
      prova, 
      categoria, 
      id_evento, 
      id_ps 
    } = req.body;

    // Validazione parametri
    if (!anno || !codiceEquipe || !manifestazione || !categoria || !id_evento || !id_ps) {
      return res.status(400).json({ error: 'Parametri mancanti' });
    }

    // API CLASPS - Sistema STANDARD Triveneto
    // URL: /clasps/ANNO/EQUIPE/MANIFESTAZIONE/GARA/PROVA/CATEGORIA/*/*/*/*/*
    // GARA = categoria richiesta (1=Campionato, 2=Training, 3=Epoca, etc.)
    // PROVA = 2 (sempre la prima prova cronometrata, 1 è controllo orario)
    // CATEGORIA = 1 (tutte le categorie piloti)
    const url = `https://apienduro.ficr.it/END/mpcache-5/get/clasps/${anno}/${codiceEquipe}/${manifestazione}/${categoria}/2/1/*/*/*/*/*`;
    
    console.log(`[IMPORT] Chiamata FICR CLASPS 2025: ${url}`);
    console.log(`[IMPORT] Gara richiesta: ${categoria}`);
    
    // HEADER OBBLIGATORI per API FICR
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://enduro.ficr.it',
      'Referer': 'https://enduro.ficr.it/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
      'Cache-Control': 'Private',
      'Pragma': 'no-cache'
    };
    
    const response = await axios.get(url, { headers });
    
    // API CLASPS ritorna: { code, status, message, data: { clasdella: [...] } }
    const dati = response.data?.data?.clasdella || [];

    console.log(`[IMPORT] Risposta FICR - Piloti trovati: ${dati.length}`);

    if (!dati || !Array.isArray(dati) || dati.length === 0) {
      console.log(`[IMPORT] Nessun dato trovato`);
      return res.status(404).json({ error: 'Nessun dato trovato da FICR' });
    }

    let pilotiImportati = 0;
    let tempiImportati = 0;

    console.log(`[IMPORT] Inizio import: ${dati.length} record da processare`);

    // 2. Importa piloti e tempi
    for (const record of dati) {
      try {
        // FICR usa "Numero" non "NumeroGara"
        const numeroGara = parseInt(record.Numero);
        const cognome = record.Cognome || '';
        const nome = record.Nome || '';
        const classe = record.Classe || '';
        const moto = record.Moto || '';
        const team = record.Motoclub || '';  // FICR usa "Motoclub"
        const nazione = record.Naz || 'ITA';  // FICR usa "Naz"

        console.log(`[IMPORT] Processo pilota #${numeroGara}: ${nome} ${cognome}`);

        // Verifica se pilota esiste
        let pilotaResult = await pool.query(
          'SELECT id FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
          [id_evento, numeroGara]
        );

        let pilotaId;
        if (pilotaResult.rows.length === 0) {
          // Crea pilota
          console.log(`[IMPORT] Creo nuovo pilota #${numeroGara}`);
          const insertResult = await pool.query(
            `INSERT INTO piloti (id_evento, numero_gara, cognome, nome, classe, moto, team, nazione)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [id_evento, numeroGara, cognome, nome, classe, moto, team, nazione]
          );
          pilotaId = insertResult.rows[0].id;
          pilotiImportati++;
          console.log(`[IMPORT] Pilota creato con ID: ${pilotaId}`);
        } else {
          pilotaId = pilotaResult.rows[0].id;
          console.log(`[IMPORT] Pilota #${numeroGara} già esistente: ${pilotaId}`);
        }

        // Importa tempo se presente
        const tempoStr = record.Tempo;
        if (tempoStr && tempoStr.includes("'")) {
          const match = tempoStr.match(/(\d+)'(\d+\.\d+)/);
          if (match) {
            const tempoSecondi = parseInt(match[1]) * 60 + parseFloat(match[2]);

            console.log(`[IMPORT] Salvo tempo per pilota ${pilotaId}: ${tempoSecondi}s`);
            
            await pool.query(
              `INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
               VALUES ($1, $2, $3, 0)
               ON CONFLICT (id_pilota, id_ps) DO UPDATE SET tempo_secondi = $3`,
              [pilotaId, id_ps, tempoSecondi]
            );
            tempiImportati++;
            console.log(`[IMPORT] Tempo salvato`);
          }
        }

      } catch (err) {
        console.error(`[IMPORT] Errore import record:`, err.message);
        console.error(`[IMPORT] Stack:`, err.stack);
      }
    }

    console.log(`[IMPORT] Completato: ${pilotiImportati} piloti, ${tempiImportati} tempi`);

    res.json({
      success: true,
      piloti_importati: pilotiImportati,
      tempi_importati: tempiImportati,
      totale_record: dati.length
    });

  } catch (err) {
    console.error('[IMPORT] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ENDPOINT COMUNICATI
// ============================================

// 1. CREA COMUNICATO
app.post('/api/comunicati', async (req, res) => {
  const { codice_gara, testo, pdf_allegato, pdf_nome } = req.body;
  
  if (!codice_gara || !testo) {
    return res.status(400).json({ error: 'Codice gara e testo obbligatori' });
  }

  try {
    const numeroResult = await pool.query(
      'SELECT get_next_comunicato_number($1) as numero',
      [codice_gara]
    );
    const numero = numeroResult.rows[0].numero;

    const result = await pool.query(
      `INSERT INTO comunicati (codice_gara, numero, testo, ora, data, pdf_allegato, pdf_nome)
       VALUES ($1, $2, $3, CURRENT_TIME, CURRENT_DATE, $4, $5)
       RETURNING *`,
      [codice_gara, numero, testo, pdf_allegato || null, pdf_nome || null]
    );

    const comunicato = result.rows[0];

    res.status(201).json({
      success: true,
      comunicato: {
        id: comunicato.id,
        numero: comunicato.numero,
        ora: comunicato.ora,
        data: comunicato.data,
        testo: comunicato.testo,
        codice_gara: comunicato.codice_gara,
        pdf_allegato: comunicato.pdf_allegato,
        pdf_nome: comunicato.pdf_nome
      }
    });
  } catch (error) {
    console.error('Errore creazione comunicato:', error);
    res.status(500).json({ error: 'Errore creazione comunicato' });
  }
});

// 2. LISTA COMUNICATI PER GARA
app.get('/api/comunicati/:codice_gara', async (req, res) => {
  const { codice_gara } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, numero, ora, data, testo, created_at, updated_at,
              pdf_allegato, pdf_nome,
              jsonb_array_length(letto_da) as num_letti
       FROM comunicati
       WHERE codice_gara = $1
       ORDER BY numero DESC`,
      [codice_gara]
    );

    res.json({ success: true, comunicati: result.rows });
  } catch (error) {
    console.error('Errore recupero comunicati:', error);
    res.status(500).json({ error: 'Errore recupero comunicati' });
  }
});

// 3. ELIMINA COMUNICATO
app.delete('/api/comunicati/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM comunicati WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Errore eliminazione:', error);
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

// 4. MODIFICA COMUNICATO
app.put('/api/comunicati/:id', async (req, res) => {
  const { id } = req.params;
  const { testo } = req.body;

  try {
    const result = await pool.query(
      `UPDATE comunicati SET testo = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, testo]
    );

    res.json({ success: true, comunicato: result.rows[0] });
  } catch (error) {
    console.error('Errore modifica:', error);
    res.status(500).json({ error: 'Errore modifica' });
  }
});

// 5. STATISTICHE
app.get('/api/comunicati/:codice_gara/stats', async (req, res) => {
  const { codice_gara } = req.params;

  try {
    const stats = await pool.query(
      `SELECT COUNT(*) as totale_comunicati, MAX(numero) as ultimo_numero
       FROM comunicati WHERE codice_gara = $1`,
      [codice_gara]
    );

    // Rimosso query piloti_gara (tabella non esiste)
    // TODO: implementare quando si fa import FICR

    res.json({
      success: true,
      stats: { 
        totale_comunicati: stats.rows[0].totale_comunicati,
        ultimo_numero: stats.rows[0].ultimo_numero,
        piloti_attivi: 0  // placeholder
      }
    });
  } catch (error) {
    console.error('Errore statistiche:', error);
    res.status(500).json({ error: 'Errore statistiche' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
