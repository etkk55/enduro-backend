require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS - Allow all origins
app.use(cors());
app.use(express.json());

// PostgreSQL Pool
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
  }
});

// ==================== EVENTI ====================

// GET tutti gli eventi
app.get('/api/eventi', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM eventi ORDER BY data_evento DESC');
    res.json(result.rows);
  } catch (err) {
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
    const { nome_evento, data_evento, luogo } = req.body;
    const result = await pool.query(
      'INSERT INTO eventi (nome_evento, data_evento, luogo) VALUES ($1, $2, $3) RETURNING *',
      [nome_evento, data_evento, luogo]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
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
              tempoTotale += parseFloat(tempo);
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
    
    // Ritorna dati grezzi da FICR
    res.json(response.data);
    
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
    if (!anno || !codiceEquipe || !manifestazione || !giorno || !prova || !categoria || !id_evento || !id_ps) {
      return res.status(400).json({ error: 'Parametri mancanti' });
    }

    // 1. Chiamata API FICR
    const url = `https://apienduro.ficr.it/END/mpcache-5/get/clasps/${anno}/${codiceEquipe}/${manifestazione}/${giorno}/${prova}/${categoria}/*/*/*/*/*`;
    
    console.log(`[IMPORT] Chiamata FICR: ${url}`);
    
    const response = await axios.get(url);
    const dati = response.data;

    if (!dati || !Array.isArray(dati) || dati.length === 0) {
      return res.status(404).json({ error: 'Nessun dato trovato da FICR' });
    }

    let pilotiImportati = 0;
    let tempiImportati = 0;

    // 2. Importa piloti e tempi
    for (const record of dati) {
      try {
        const numeroGara = parseInt(record.NumeroGara);
        const cognome = record.Cognome || '';
        const nome = record.Nome || '';
        const classe = record.Classe || '';
        const moto = record.Moto || '';
        const team = record.Team || '';
        const nazione = record.Nazione || 'ITA';

        // Verifica se pilota esiste
        let pilotaResult = await pool.query(
          'SELECT id FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
          [id_evento, numeroGara]
        );

        let pilotaId;
        if (pilotaResult.rows.length === 0) {
          // Crea pilota
          const insertResult = await pool.query(
            `INSERT INTO piloti (id_evento, numero_gara, cognome, nome, classe, moto, team, nazione)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [id_evento, numeroGara, cognome, nome, classe, moto, team, nazione]
          );
          pilotaId = insertResult.rows[0].id;
          pilotiImportati++;
        } else {
          pilotaId = pilotaResult.rows[0].id;
        }

        // Importa tempo se presente
        const tempoStr = record.Tempo;
        if (tempoStr && tempoStr.includes("'")) {
          const match = tempoStr.match(/(\d+)'(\d+\.\d+)/);
          if (match) {
            const tempoSecondi = parseInt(match[1]) * 60 + parseFloat(match[2]);

            await pool.query(
              `INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
               VALUES ($1, $2, $3, 0)
               ON CONFLICT (id_pilota, id_ps) DO UPDATE SET tempo_secondi = $3`,
              [pilotaId, id_ps, tempoSecondi]
            );
            tempiImportati++;
          }
        }

      } catch (err) {
        console.error(`Errore import record:`, err.message);
      }
    }

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
