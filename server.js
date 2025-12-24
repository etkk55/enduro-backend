// require('dotenv').config(); // DISABLED: Railway injects env vars directly
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8080;
const FICR_BASE_URL = process.env.FICR_URL || 'https://apienduro.ficr.it';

// CORS - Allow all origins
app.use(cors());
app.use(express.json({ limit: '15mb' }));

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
      
      // NUOVO Chat 19: Aggiungi colonna codice_accesso per app ERTA
      return pool.query(`
        ALTER TABLE eventi 
        ADD COLUMN IF NOT EXISTS codice_accesso VARCHAR(20) UNIQUE;
      `);
    }).then(() => {
      console.log('Migrazione codice_accesso ERTA completata');
      
      // NUOVO Chat 20: Tabella messaggi_piloti per comunicazione bidirezionale
      return pool.query(`
        CREATE TABLE IF NOT EXISTS messaggi_piloti (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          codice_gara VARCHAR(50) NOT NULL,
          numero_pilota INTEGER NOT NULL,
          tipo VARCHAR(20) NOT NULL DEFAULT 'messaggio',
          testo TEXT,
          gps_lat DECIMAL(10, 8),
          gps_lon DECIMAL(11, 8),
          letto BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_messaggi_codice_gara ON messaggi_piloti(codice_gara);
        CREATE INDEX IF NOT EXISTS idx_messaggi_tipo ON messaggi_piloti(tipo);
      `);
    }).then(() => {
      console.log('Tabella messaggi_piloti creata');
      
      // NUOVO Chat 20: Tabella squadre per confronto classifiche
      return pool.query(`
        CREATE TABLE IF NOT EXISTS squadre (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          codice_gara VARCHAR(50) NOT NULL,
          nome_squadra VARCHAR(100) NOT NULL,
          creatore_numero INTEGER NOT NULL,
          membri INTEGER[] DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_squadre_codice_gara ON squadre(codice_gara);
        CREATE INDEX IF NOT EXISTS idx_squadre_creatore ON squadre(creatore_numero);
      `);
    }).then(() => {
      console.log('Tabella squadre creata');
      
      // NUOVO Chat 21: Colonne paddock e parametri GPS per sicurezza
      return pool.query(`
        ALTER TABLE eventi 
        ADD COLUMN IF NOT EXISTS paddock1_lat DECIMAL(10, 8),
        ADD COLUMN IF NOT EXISTS paddock1_lon DECIMAL(11, 8),
        ADD COLUMN IF NOT EXISTS paddock2_lat DECIMAL(10, 8),
        ADD COLUMN IF NOT EXISTS paddock2_lon DECIMAL(11, 8),
        ADD COLUMN IF NOT EXISTS paddock_raggio INTEGER DEFAULT 500,
        ADD COLUMN IF NOT EXISTS gps_frequenza INTEGER DEFAULT 30,
        ADD COLUMN IF NOT EXISTS allarme_fermo_minuti INTEGER DEFAULT 10,
        ADD COLUMN IF NOT EXISTS codice_ddg VARCHAR(20);
      `);
    }).then(() => {
      console.log('Migrazione paddock e GPS completata');
      
      // NUOVO Chat 21: Tabella posizioni_piloti per tracking GPS
      return pool.query(`
        CREATE TABLE IF NOT EXISTS posizioni_piloti (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          codice_gara VARCHAR(50) NOT NULL,
          numero_pilota INTEGER NOT NULL,
          lat DECIMAL(10, 8) NOT NULL,
          lon DECIMAL(11, 8) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_posizioni_codice_gara ON posizioni_piloti(codice_gara);
        CREATE INDEX IF NOT EXISTS idx_posizioni_pilota ON posizioni_piloti(numero_pilota);
        CREATE INDEX IF NOT EXISTS idx_posizioni_created ON posizioni_piloti(created_at DESC);
      `);
    }).then(() => {
      console.log('Tabella posizioni_piloti creata');
      
      // NUOVO: Colonna tipo per comunicati (comunicato, general_info, paddock_info)
      return pool.query(`
        ALTER TABLE comunicati 
        ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'comunicato';
      `);
    }).then(() => {
      console.log('Migrazione tipo comunicati completata');
      
      // Aggiorna funzione numerazione per considerare il tipo
      return pool.query(`
        CREATE OR REPLACE FUNCTION get_next_comunicato_number(p_codice_gara VARCHAR, p_tipo VARCHAR DEFAULT 'comunicato')
        RETURNS INTEGER AS $$
        DECLARE
          next_num INTEGER;
        BEGIN
          SELECT COALESCE(MAX(numero), 0) + 1 INTO next_num
          FROM comunicati
          WHERE codice_gara = p_codice_gara AND tipo = p_tipo;
          RETURN next_num;
        END;
        $$ LANGUAGE plpgsql;
      `);
    }).then(() => {
      console.log('Funzione get_next_comunicato_number aggiornata con tipo');
      
      // Modifica vincolo UNIQUE per includere tipo (permette numerazione separata per tipo)
      return pool.query(`
        DO $$
        BEGIN
          -- Rimuovi vecchio vincolo se esiste
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comunicati_codice_gara_numero_key') THEN
            ALTER TABLE comunicati DROP CONSTRAINT comunicati_codice_gara_numero_key;
          END IF;
          
          -- Crea nuovo vincolo con tipo (se non esiste già)
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comunicati_codice_gara_numero_tipo_key') THEN
            ALTER TABLE comunicati ADD CONSTRAINT comunicati_codice_gara_numero_tipo_key UNIQUE (codice_gara, numero, tipo);
          END IF;
        END $$;
      `);
    }).then(() => {
      console.log('Vincolo UNIQUE aggiornato per includere tipo');
      
      // NUOVO Chat 20: Tabella tempi_settore per orari teorici piloti
      return pool.query(`
        CREATE TABLE IF NOT EXISTS tempi_settore (
          id SERIAL PRIMARY KEY,
          id_evento UUID REFERENCES eventi(id) ON DELETE CASCADE,
          codice_gara VARCHAR(20),
          co1_attivo BOOLEAN DEFAULT true,
          co2_attivo BOOLEAN DEFAULT true,
          co3_attivo BOOLEAN DEFAULT false,
          tempo_par_co1 INTEGER,
          tempo_co1_co2 INTEGER,
          tempo_co2_co3 INTEGER,
          tempo_ultimo_arr INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(id_evento, codice_gara)
        );
      `);
    }).then(() => {
      console.log('Tabella tempi_settore creata');
      
      // NUOVO Chat 20: Colonna orario_partenza per piloti (da FICR)
      return pool.query(`
        ALTER TABLE piloti 
        ADD COLUMN IF NOT EXISTS orario_partenza VARCHAR(10);
      `);
    }).then(() => {
      console.log('Colonna orario_partenza aggiunta a piloti');
      
      // NUOVO Chat 20: Colonne aggiuntive per import XML iscritti
      return pool.query(`
        ALTER TABLE piloti 
        ADD COLUMN IF NOT EXISTS licenza_fmi VARCHAR(20),
        ADD COLUMN IF NOT EXISTS anno_nascita INTEGER;
      `);
    }).then(() => {
      console.log('Colonne licenza_fmi e anno_nascita aggiunte a piloti');
      
      // NUOVO Chat 21: Colonna codice_fmi per transcodifica FMI→FICR
      return pool.query(`
        ALTER TABLE eventi 
        ADD COLUMN IF NOT EXISTS codice_fmi VARCHAR(20);
      `);
    }).then(() => {
      console.log('Colonna codice_fmi aggiunta a eventi');
      
      // NUOVO Chat 21b: Campi configurazione FICR per import startlist
      return pool.query(`
        ALTER TABLE eventi 
        ADD COLUMN IF NOT EXISTS ficr_anno INTEGER,
        ADD COLUMN IF NOT EXISTS ficr_codice_equipe VARCHAR(10),
        ADD COLUMN IF NOT EXISTS ficr_manifestazione VARCHAR(10);
      `);
    }).then(() => {
      console.log('Campi FICR (anno, codice_equipe, manifestazione) aggiunti a eventi');
      
      // NUOVO Chat 22: Campo codice_accesso_pubblico per accesso pubblico ERTA
      return pool.query(`
        ALTER TABLE eventi 
        ADD COLUMN IF NOT EXISTS codice_accesso_pubblico VARCHAR(50);
      `);
    }).then(() => {
      console.log('Campo codice_accesso_pubblico aggiunto a eventi');
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
      descrizione,
      codice_accesso  // NUOVO Chat 19: per app ERTA
    } = req.body;
    
    // UPSERT: aggiorna se esiste, crea se non esiste
    const result = await pool.query(
      `INSERT INTO eventi (nome_evento, codice_gara, data_inizio, data_fine, luogo, descrizione, codice_accesso) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       ON CONFLICT (codice_gara) 
       DO UPDATE SET 
         nome_evento = EXCLUDED.nome_evento,
         data_inizio = EXCLUDED.data_inizio,
         data_fine = EXCLUDED.data_fine,
         luogo = EXCLUDED.luogo,
         descrizione = EXCLUDED.descrizione,
         codice_accesso = COALESCE(EXCLUDED.codice_accesso, eventi.codice_accesso)
       RETURNING *`,
      [nome_evento, codice_gara, data_inizio, data_fine || data_inizio, luogo, descrizione || null, codice_accesso || null]
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

// NUOVO Chat 19: PUT aggiorna codice_accesso per app ERTA
app.put('/api/eventi/:id/codice-accesso', async (req, res) => {
  try {
    const { id } = req.params;
    const { codice_accesso } = req.body;
    
    if (!codice_accesso || codice_accesso.length < 4) {
      return res.status(400).json({ error: 'Codice accesso deve essere almeno 4 caratteri' });
    }
    
    const result = await pool.query(
      'UPDATE eventi SET codice_accesso = $1 WHERE id = $2 RETURNING *',
      [codice_accesso.toUpperCase(), id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    res.json({ success: true, evento: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') { // Unique violation
      return res.status(400).json({ error: 'Codice accesso già in uso' });
    }
    res.status(500).json({ error: err.message });
  }
});

// NUOVO Chat 21: Aggiorna parametri paddock e GPS
app.put('/api/eventi/:id/parametri-gps', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      paddock1_lat, paddock1_lon, 
      paddock2_lat, paddock2_lon, 
      paddock_raggio, 
      gps_frequenza, 
      allarme_fermo_minuti,
      codice_ddg,
      codice_fmi,
      ficr_anno,
      ficr_codice_equipe,
      ficr_manifestazione,
      codice_accesso_pubblico  // NUOVO Chat 22: Accesso pubblico ERTA
    } = req.body;
    
    const result = await pool.query(
      `UPDATE eventi SET 
        paddock1_lat = $1, paddock1_lon = $2,
        paddock2_lat = $3, paddock2_lon = $4,
        paddock_raggio = $5,
        gps_frequenza = $6,
        allarme_fermo_minuti = $7,
        codice_ddg = $8,
        codice_fmi = $9,
        ficr_anno = $10,
        ficr_codice_equipe = $11,
        ficr_manifestazione = $12,
        codice_accesso_pubblico = $13
      WHERE id = $14 RETURNING *`,
      [
        paddock1_lat || null, paddock1_lon || null,
        paddock2_lat || null, paddock2_lon || null,
        paddock_raggio || 500,
        gps_frequenza || 30,
        allarme_fermo_minuti || 10,
        codice_ddg || null,
        codice_fmi || null,
        ficr_anno || null,
        ficr_codice_equipe || null,
        ficr_manifestazione || null,
        codice_accesso_pubblico || null,
        id
      ]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    res.json({ success: true, evento: result.rows[0] });
  } catch (err) {
    console.error('[PUT /api/eventi/:id/parametri-gps] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// NUOVO Chat 21: Salva posizione GPS pilota (chiamato da ERTA)
app.post('/api/app/posizione', async (req, res) => {
  try {
    const { codice_accesso, numero_pilota, lat, lon } = req.body;
    
    if (!codice_accesso || !numero_pilota || !lat || !lon) {
      return res.status(400).json({ success: false, error: 'Dati mancanti' });
    }
    
    // Trova evento
    const eventoResult = await pool.query(
      'SELECT codice_gara FROM eventi WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Evento non trovato' });
    }
    
    const codice_gara = eventoResult.rows[0].codice_gara;
    
    // Salva posizione
    await pool.query(
      'INSERT INTO posizioni_piloti (codice_gara, numero_pilota, lat, lon) VALUES ($1, $2, $3, $4)',
      [codice_gara, parseInt(numero_pilota), parseFloat(lat), parseFloat(lon)]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error('[POST /api/app/posizione] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore salvataggio posizione' });
  }
});

// NUOVO Chat 21: Ottieni ultima posizione di tutti i piloti
app.get('/api/eventi/:id/posizioni-piloti', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Ottieni codice_gara dell'evento
    const eventoResult = await pool.query('SELECT codice_gara FROM eventi WHERE id = $1', [id]);
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    const codice_gara = eventoResult.rows[0].codice_gara;
    
    // Ottieni ultima posizione per ogni pilota
    const result = await pool.query(`
      SELECT DISTINCT ON (numero_pilota) 
        numero_pilota, lat, lon, created_at
      FROM posizioni_piloti 
      WHERE codice_gara = $1
      ORDER BY numero_pilota, created_at DESC
    `, [codice_gara]);
    
    res.json({ success: true, posizioni: result.rows });
  } catch (err) {
    console.error('[GET /api/eventi/:id/posizioni-piloti] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// NUOVO Chat 21: Ottieni piloti fermi (per allarmi)
app.get('/api/eventi/:id/piloti-fermi', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Ottieni evento con parametri
    const eventoResult = await pool.query(
      'SELECT codice_gara, paddock1_lat, paddock1_lon, paddock2_lat, paddock2_lon, paddock_raggio, allarme_fermo_minuti FROM eventi WHERE id = $1',
      [id]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    const evento = eventoResult.rows[0];
    const sogliaMinuti = evento.allarme_fermo_minuti || 10;
    const raggioM = evento.paddock_raggio || 500;
    const raggioFermoM = 50; // Considera "fermo" se si è mosso meno di 50m
    
    // Funzione per calcolare distanza in metri (Haversine)
    const distanza = (lat1, lon1, lat2, lon2) => {
      const R = 6371000;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    };
    
    // Ottieni TUTTE le posizioni degli ultimi X*2 minuti per ogni pilota
    const posizioniResult = await pool.query(`
      SELECT numero_pilota, lat, lon, created_at
      FROM posizioni_piloti 
      WHERE codice_gara = $1 
        AND created_at > NOW() - INTERVAL '${sogliaMinuti * 2} minutes'
      ORDER BY numero_pilota, created_at ASC
    `, [evento.codice_gara]);
    
    // Ottieni ULTIMA posizione di TUTTI i piloti che hanno mai inviato GPS (per segnale perso)
    const ultimePosResult = await pool.query(`
      SELECT DISTINCT ON (numero_pilota) numero_pilota, lat, lon, created_at
      FROM posizioni_piloti 
      WHERE codice_gara = $1
      ORDER BY numero_pilota, created_at DESC
    `, [evento.codice_gara]);
    
    // Raggruppa posizioni recenti per pilota
    const posPerPilota = {};
    posizioniResult.rows.forEach(pos => {
      if (!posPerPilota[pos.numero_pilota]) {
        posPerPilota[pos.numero_pilota] = [];
      }
      posPerPilota[pos.numero_pilota].push(pos);
    });
    
    const pilotiFermi = [];
    const pilotiSegnalePerso = [];
    const now = new Date();
    
    // 1. Trova piloti con SEGNALE PERSO (non inviano GPS da X minuti)
    ultimePosResult.rows.forEach(pos => {
      const minutiDaUltimaPos = (now - new Date(pos.created_at)) / 60000;
      
      // Se non ha inviato posizione da più di X minuti
      if (minutiDaUltimaPos > sogliaMinuti) {
        // Verifica se NON è nel paddock
        let nelPaddock = false;
        
        if (evento.paddock1_lat && evento.paddock1_lon) {
          const dist1 = distanza(pos.lat, pos.lon, evento.paddock1_lat, evento.paddock1_lon);
          if (dist1 <= raggioM) nelPaddock = true;
        }
        
        if (!nelPaddock && evento.paddock2_lat && evento.paddock2_lon) {
          const dist2 = distanza(pos.lat, pos.lon, evento.paddock2_lat, evento.paddock2_lon);
          if (dist2 <= raggioM) nelPaddock = true;
        }
        
        if (!nelPaddock) {
          pilotiSegnalePerso.push({
            numero_pilota: pos.numero_pilota,
            tipo: 'segnale_perso',
            lat: pos.lat,
            lon: pos.lon,
            ultima_posizione: pos.created_at,
            minuti_senza_segnale: Math.round(minutiDaUltimaPos)
          });
        }
      }
    });
    
    // 2. Trova piloti FERMI (continuano a inviare ma non si muovono)
    Object.keys(posPerPilota).forEach(numeroPilota => {
      const posizioni = posPerPilota[numeroPilota];
      if (posizioni.length < 2) return;
      
      const primaPos = posizioni[0];
      const ultimaPos = posizioni[posizioni.length - 1];
      
      const minutiCoperti = (new Date(ultimaPos.created_at) - new Date(primaPos.created_at)) / 60000;
      
      if (minutiCoperti >= sogliaMinuti) {
        const movimento = distanza(primaPos.lat, primaPos.lon, ultimaPos.lat, ultimaPos.lon);
        
        if (movimento < raggioFermoM) {
          let nelPaddock = false;
          
          if (evento.paddock1_lat && evento.paddock1_lon) {
            const dist1 = distanza(ultimaPos.lat, ultimaPos.lon, evento.paddock1_lat, evento.paddock1_lon);
            if (dist1 <= raggioM) nelPaddock = true;
          }
          
          if (!nelPaddock && evento.paddock2_lat && evento.paddock2_lon) {
            const dist2 = distanza(ultimaPos.lat, ultimaPos.lon, evento.paddock2_lat, evento.paddock2_lon);
            if (dist2 <= raggioM) nelPaddock = true;
          }
          
          if (!nelPaddock) {
            pilotiFermi.push({
              numero_pilota: parseInt(numeroPilota),
              tipo: 'fermo',
              lat: ultimaPos.lat,
              lon: ultimaPos.lon,
              ultima_posizione: ultimaPos.created_at,
              minuti_fermo: Math.round(minutiCoperti),
              movimento_metri: Math.round(movimento)
            });
          }
        }
      }
    });
    
    // Ordina per gravità
    pilotiSegnalePerso.sort((a, b) => b.minuti_senza_segnale - a.minuti_senza_segnale);
    pilotiFermi.sort((a, b) => b.minuti_fermo - a.minuti_fermo);
    
    res.json({ 
      success: true, 
      piloti_fermi: pilotiFermi,
      piloti_segnale_perso: pilotiSegnalePerso
    });
  } catch (err) {
    console.error('[GET /api/eventi/:id/piloti-fermi] Error:', err.message);
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

// NUOVO Chat 21: DELETE tutti piloti di un evento
app.delete('/api/eventi/:id_evento/piloti', async (req, res) => {
  try {
    const { id_evento } = req.params;
    const result = await pool.query('DELETE FROM piloti WHERE id_evento = $1', [id_evento]);
    res.json({ 
      message: `Eliminati ${result.rowCount} piloti`,
      count: result.rowCount 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NUOVO Chat 21: Import piloti da FICR startlist (crea piloti + orari)
app.post('/api/eventi/:id_evento/import-piloti-ficr', async (req, res) => {
  try {
    const { id_evento } = req.params;
    
    // Recupera parametri FICR dall'evento
    const eventoRes = await pool.query('SELECT * FROM eventi WHERE id = $1', [id_evento]);
    if (eventoRes.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    const evento = eventoRes.rows[0];
    
    const anno = evento.ficr_anno || new Date().getFullYear();
    const equipe = evento.ficr_codice_equipe;
    const manif = evento.ficr_manifestazione;
    const codiceGara = evento.codice_gara; // es. "303-1", "303-2"
    
    if (!equipe || !manif) {
      return res.status(400).json({ 
        error: 'Parametri FICR non configurati. Configura Anno, Codice Equipe e Manifestazione.' 
      });
    }
    
    // Estrai categoria FICR dal codice_gara (303-1 -> 1, 303-2 -> 2)
    const categoriaFicr = codiceGara ? codiceGara.split('-')[1] : '1';
    
    // Chiama API FICR startlist
    const ficrUrl = `https://apienduro.ficr.it/END/mpcache-20/get/startlist/${anno}/${equipe}/${manif}/${categoriaFicr}/1/1/*/*/*/*/*`;
    console.log('Import piloti FICR URL:', ficrUrl);
    
    const response = await fetch(ficrUrl);
    if (!response.ok) {
      return res.status(502).json({ error: `Errore API FICR: ${response.status}` });
    }
    
    const jsonResponse = await response.json();
    // FICR restituisce { code: 200, status: true, data: [...] }
    const startlist = jsonResponse.data || jsonResponse;
    
    if (!startlist || !Array.isArray(startlist) || startlist.length === 0) {
      return res.json({ 
        message: 'Nessun pilota trovato nella startlist FICR',
        created: 0,
        updated: 0
      });
    }
    
    let created = 0;
    let updated = 0;
    
    for (const pilota of startlist) {
      const numeroGara = pilota.Numero;
      const cognome = pilota.Cognome;
      const nome = pilota.Nome;
      const classe = pilota.Classe || '';
      const moto = pilota.Moto || '';
      const team = pilota.Scuderia || pilota.MotoClub || '';
      const orarioPartenza = pilota.Orario || null;
      
      // Verifica se pilota esiste già
      const existingRes = await pool.query(
        'SELECT id FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
        [id_evento, numeroGara]
      );
      
      if (existingRes.rows.length > 0) {
        // Aggiorna pilota esistente
        await pool.query(`
          UPDATE piloti SET 
            cognome = $1, nome = $2, classe = $3, moto = $4, team = $5, orario_partenza = $6
          WHERE id_evento = $7 AND numero_gara = $8
        `, [cognome, nome, classe, moto, team, orarioPartenza, id_evento, numeroGara]);
        updated++;
      } else {
        // Crea nuovo pilota
        await pool.query(`
          INSERT INTO piloti (id_evento, numero_gara, cognome, nome, classe, moto, team, orario_partenza)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [id_evento, numeroGara, cognome, nome, classe, moto, team, orarioPartenza]);
        created++;
      }
    }
    
    res.json({
      message: `Import completato: ${created} creati, ${updated} aggiornati`,
      created,
      updated,
      total: startlist.length
    });
    
  } catch (err) {
    console.error('Errore import piloti FICR:', err);
    res.status(500).json({ error: err.message });
  }
});

// NUOVO Chat 22: Import FICR per TUTTE le gare fratelle (3 modalità)
app.post('/api/eventi/:id_evento/import-ficr-tutte', async (req, res) => {
  try {
    const { id_evento } = req.params;
    const { modalita } = req.body; // 'program' | 'entrylist' | 'startlist'
    
    if (!['program', 'entrylist', 'startlist'].includes(modalita)) {
      return res.status(400).json({ error: 'Modalità non valida. Usa: program, entrylist, startlist' });
    }
    
    // Recupera evento e parametri FICR
    const eventoRes = await pool.query('SELECT * FROM eventi WHERE id = $1', [id_evento]);
    if (eventoRes.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    const evento = eventoRes.rows[0];
    
    const anno = evento.ficr_anno || new Date().getFullYear();
    const equipe = evento.ficr_codice_equipe;
    const manif = evento.ficr_manifestazione;
    
    if (!equipe || !manif) {
      return res.status(400).json({ 
        error: 'Parametri FICR non configurati. Configura Anno, Codice Equipe e Manifestazione.' 
      });
    }
    
    // Trova TUTTE le gare fratelle (303-1, 303-2, 303-3)
    const prefisso = evento.codice_gara.split('-')[0];
    const gareFratelleRes = await pool.query(
      "SELECT * FROM eventi WHERE codice_gara LIKE $1 ORDER BY codice_gara",
      [prefisso + '-%']
    );
    const gareFratelle = gareFratelleRes.rows;
    
    console.log(`[IMPORT-FICR-TUTTE] Modalità: ${modalita}, Gare fratelle: ${gareFratelle.map(g => g.codice_gara).join(', ')}`);
    
    const risultati = {};
    
    for (const gara of gareFratelle) {
      // Estrai categoria dal codice gara (303-1 -> 1, 303-2 -> 2, etc.)
      const categoria = parseInt(gara.codice_gara.split('-')[1]) || 1;
      
      let apiUrl;
      let pilotiData = [];
      
      try {
        if (modalita === 'program') {
          // T-5: Usa entrylist per caricare piloti base (program contiene solo prove speciali)
          apiUrl = `https://apienduro.ficr.it/END/mpcache-30/get/entrylist/${anno}/${equipe}/${manif}/${categoria}/*/*/*/*/*/*/*`;
        } else if (modalita === 'entrylist') {
          // T-2: Numeri di gara
          apiUrl = `https://apienduro.ficr.it/END/mpcache-30/get/entrylist/${anno}/${equipe}/${manif}/${categoria}/*/*/*/*/*/*/*`;
        } else {
          // T-1: Ordine di partenza
          apiUrl = `https://apienduro.ficr.it/END/mpcache-20/get/startlist/${anno}/${equipe}/${manif}/${categoria}/1/1/*/*/*/*/*`;
        }
        
        console.log(`[IMPORT-FICR-TUTTE] ${gara.codice_gara} -> ${apiUrl}`);
        
        const apiRes = await fetch(apiUrl);
        if (apiRes.ok) {
          const jsonResponse = await apiRes.json();
          // FICR restituisce { code: 200, status: true, data: [...] }
          pilotiData = jsonResponse.data || jsonResponse;
          if (!Array.isArray(pilotiData)) pilotiData = [];
        }
      } catch (e) {
        console.log(`[IMPORT-FICR-TUTTE] Errore API per ${gara.codice_gara}:`, e.message);
      }
      
      if (!Array.isArray(pilotiData) || pilotiData.length === 0) {
        risultati[gara.codice_gara] = { created: 0, updated: 0, message: 'Nessun dato disponibile' };
        continue;
      }
      
      let created = 0;
      let updated = 0;
      
      for (const pilota of pilotiData) {
        const numeroGara = pilota.Numero;
        const cognome = pilota.Cognome || '';
        const nome = pilota.Nome || '';
        const classe = pilota.Classe || '';
        const moto = pilota.Moto || '';
        const team = pilota.Motoclub || pilota.Scuderia || pilota.MotoClub || '';
        const orarioPartenza = pilota.Orario || null;
        
        if (!numeroGara) continue;
        
        // Verifica se pilota esiste già
        const existingRes = await pool.query(
          'SELECT id FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
          [gara.id, numeroGara]
        );
        
        if (existingRes.rows.length > 0) {
          // Aggiorna pilota esistente
          if (modalita === 'startlist') {
            // Solo orario per startlist
            await pool.query(
              'UPDATE piloti SET orario_partenza = $1 WHERE id_evento = $2 AND numero_gara = $3',
              [orarioPartenza, gara.id, numeroGara]
            );
          } else {
            await pool.query(`
              UPDATE piloti SET 
                cognome = $1, nome = $2, classe = $3, moto = $4, team = $5, orario_partenza = COALESCE($6, orario_partenza)
              WHERE id_evento = $7 AND numero_gara = $8
            `, [cognome, nome, classe, moto, team, orarioPartenza, gara.id, numeroGara]);
          }
          updated++;
        } else {
          // Crea nuovo pilota
          await pool.query(`
            INSERT INTO piloti (id_evento, numero_gara, cognome, nome, classe, moto, team, orario_partenza)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [gara.id, numeroGara, cognome, nome, classe, moto, team, orarioPartenza]);
          created++;
        }
      }
      
      risultati[gara.codice_gara] = { created, updated, total: pilotiData.length };
    }
    
    // Calcola totali
    let totCreated = 0, totUpdated = 0;
    Object.values(risultati).forEach(r => {
      totCreated += r.created || 0;
      totUpdated += r.updated || 0;
    });
    
    res.json({
      success: true,
      modalita,
      risultati,
      totali: { created: totCreated, updated: totUpdated },
      message: `Import ${modalita}: ${totCreated} creati, ${totUpdated} aggiornati`
    });
    
  } catch (err) {
    console.error('[IMPORT-FICR-TUTTE] Errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// NUOVO Chat 22: Cancella piloti da TUTTE le gare fratelle
app.delete('/api/eventi/:id_evento/piloti-tutte', async (req, res) => {
  try {
    const { id_evento } = req.params;
    
    // Recupera evento
    const eventoRes = await pool.query('SELECT codice_gara FROM eventi WHERE id = $1', [id_evento]);
    if (eventoRes.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    
    // Trova TUTTE le gare fratelle
    const prefisso = eventoRes.rows[0].codice_gara.split('-')[0];
    const gareFratelleRes = await pool.query(
      "SELECT id, codice_gara FROM eventi WHERE codice_gara LIKE $1",
      [prefisso + '-%']
    );
    
    const risultati = {};
    let totale = 0;
    
    for (const gara of gareFratelleRes.rows) {
      const deleteRes = await pool.query('DELETE FROM piloti WHERE id_evento = $1', [gara.id]);
      risultati[gara.codice_gara] = deleteRes.rowCount;
      totale += deleteRes.rowCount;
    }
    
    res.json({
      success: true,
      message: `Eliminati ${totale} piloti da tutte le gare`,
      risultati,
      totale
    });
    
  } catch (err) {
    console.error('[DELETE-PILOTI-TUTTE] Errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// NUOVO Chat 22: Import completo da FICR (entrylist + startlist) per una categoria specifica
app.post('/api/eventi/:id_evento/import-completo-ficr', async (req, res) => {
  try {
    const { id_evento } = req.params;
    const { categoria } = req.body; // 1=Campionato, 2=Training, 3=Epoca
    
    if (!categoria) {
      return res.status(400).json({ error: 'Categoria richiesta (1, 2 o 3)' });
    }
    
    // Recupera parametri FICR dall'evento
    const eventoRes = await pool.query('SELECT * FROM eventi WHERE id = $1', [id_evento]);
    if (eventoRes.rows.length === 0) {
      return res.status(404).json({ error: 'Evento non trovato' });
    }
    const evento = eventoRes.rows[0];
    
    const anno = evento.ficr_anno || new Date().getFullYear();
    const equipe = evento.ficr_codice_equipe;
    const manif = evento.ficr_manifestazione;
    
    if (!equipe || !manif) {
      return res.status(400).json({ 
        error: 'Parametri FICR non configurati. Configura Anno, Codice Equipe e Manifestazione prima di importare.' 
      });
    }
    
    console.log(`[IMPORT-FICR] Evento ${id_evento}, Categoria ${categoria}, FICR: ${anno}/${equipe}/${manif}`);
    
    // 1. Chiama ENTRYLIST per ottenere i piloti
    const entrylistUrl = `https://apienduro.ficr.it/END/mpcache-30/get/entrylist/${anno}/${equipe}/${manif}/${categoria}/*/*/*/*/*/*/*`;
    console.log('[IMPORT-FICR] Chiamata entrylist:', entrylistUrl);
    
    const entrylistRes = await fetch(entrylistUrl);
    if (!entrylistRes.ok) {
      return res.status(502).json({ error: `Errore API FICR entrylist: ${entrylistRes.status}` });
    }
    const entrylistJson = await entrylistRes.json();
    // FICR restituisce { code: 200, status: true, data: [...] }
    const entrylist = entrylistJson.data || entrylistJson;
    
    // 2. Chiama STARTLIST per ottenere gli orari (se disponibili)
    const startlistUrl = `https://apienduro.ficr.it/END/mpcache-20/get/startlist/${anno}/${equipe}/${manif}/${categoria}/1/1/*/*/*/*/*`;
    console.log('[IMPORT-FICR] Chiamata startlist:', startlistUrl);
    
    let startlist = [];
    try {
      const startlistRes = await fetch(startlistUrl);
      if (startlistRes.ok) {
        const startlistJson = await startlistRes.json();
        startlist = startlistJson.data || startlistJson;
      }
    } catch (e) {
      console.log('[IMPORT-FICR] Startlist non disponibile:', e.message);
    }
    
    // Crea mappa orari per numero gara
    const orariMap = {};
    if (Array.isArray(startlist)) {
      for (const p of startlist) {
        if (p.Numero && p.Orario) {
          orariMap[p.Numero] = p.Orario;
        }
      }
    }
    
    console.log(`[IMPORT-FICR] Entrylist: ${entrylist?.length || 0} piloti, Startlist: ${Object.keys(orariMap).length} orari`);
    
    if (!entrylist || !Array.isArray(entrylist) || entrylist.length === 0) {
      return res.json({ 
        success: true,
        message: 'Nessun pilota trovato nella entrylist FICR per questa categoria',
        created: 0,
        updated: 0
      });
    }
    
    let created = 0;
    let updated = 0;
    
    for (const pilota of entrylist) {
      const numeroGara = pilota.Numero;
      const cognome = pilota.Cognome || '';
      const nome = pilota.Nome || '';
      const classe = pilota.Classe || '';
      const moto = pilota.Moto || '';
      const team = pilota.Scuderia || pilota.MotoClub || '';
      const orarioPartenza = orariMap[numeroGara] || null;
      
      if (!numeroGara) continue;
      
      // Verifica se pilota esiste già
      const existingRes = await pool.query(
        'SELECT id FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
        [id_evento, numeroGara]
      );
      
      if (existingRes.rows.length > 0) {
        // Aggiorna pilota esistente
        await pool.query(`
          UPDATE piloti SET 
            cognome = $1, nome = $2, classe = $3, moto = $4, team = $5, orario_partenza = $6
          WHERE id_evento = $7 AND numero_gara = $8
        `, [cognome, nome, classe, moto, team, orarioPartenza, id_evento, numeroGara]);
        updated++;
      } else {
        // Crea nuovo pilota
        await pool.query(`
          INSERT INTO piloti (id_evento, numero_gara, cognome, nome, classe, moto, team, orario_partenza)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [id_evento, numeroGara, cognome, nome, classe, moto, team, orarioPartenza]);
        created++;
      }
    }
    
    const orariMsg = Object.keys(orariMap).length > 0 ? ` (${Object.keys(orariMap).length} con orario)` : ' (orari non ancora disponibili)';
    
    res.json({
      success: true,
      message: `Import completato: ${created} creati, ${updated} aggiornati${orariMsg}`,
      created,
      updated,
      total: entrylist.length,
      orari_disponibili: Object.keys(orariMap).length
    });
    
  } catch (err) {
    console.error('[IMPORT-FICR] Errore:', err);
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
      'INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi) VALUES ($1, $2, $3, $4) ON CONFLICT (id_pilota, id_ps) DO UPDATE SET tempo_secondi = $3, penalita_secondi = $4 RETURNING *',
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
    const url = `${FICR_BASE_URL}/END/mpcache-5/get/manilista/2025`;
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
    
    const url = `${FICR_BASE_URL}/END/mpcache-5/get/iscbycog/${anno}/${id_manif}/${id_prova}/${giorno_prova}/*/1`;
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
    
    const url = `${FICR_BASE_URL}/END/mpcache-5/get/clasps/${anno}/${id_manif}/${id_prova}/${giorno_prova}/${numero_prova}/1/*/*/*/*/*`;
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
      const url = `${FICR_BASE_URL}/END/mpcache-5/get/iscbycog/2025/99/11/1/*/1`;
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
      'SELECT id, numero_gara, nome, cognome, classe, moto, team FROM piloti WHERE id_evento = $1 ORDER BY numero_gara',
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
        team: p.team || '',
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
      
      // FIX Chat 13: Calcola posizione per tempo SINGOLA PS (non cumulativo)
      // Filtra piloti che hanno completato QUESTA specifica prova
      const pilotiConTempoPS = pilotiConStoria.filter(p => p.storia[psIdx]?.tempoProva);
      // Ordina per tempo della singola prova
      pilotiConTempoPS.sort((a, b) => a.storia[psIdx].tempoProva - b.storia[psIdx].tempoProva);
      // Assegna posizione tempo PS
      pilotiConTempoPS.forEach((p, idx) => {
        p.storia[psIdx].posizioneTempoPS = idx + 1;
      });
      
      // Piloti non validi (ritirati) - nessuna posizione per questa prova
      pilotiConStoria.filter(p => !pilotiValidi.includes(p)).forEach(p => {
        if (!p.storia[psIdx]) p.storia[psIdx] = {};
        p.storia[psIdx].posizione = null;
        p.storia[psIdx].gap = null;
        p.storia[psIdx].gapStr = null;
        p.storia[psIdx].variazione = 0;
        // posizioneTempoPS già assegnata sopra se ha tempo
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
          // FIX: Posizione per TEMPO SINGOLA PS (non classifica generale)
          psData[`pos${i+1}`] = p.storia[i]?.posizioneTempoPS || null;
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
          moto: p.moto,
          team: p.team,
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
          // FIX: Posizione per TEMPO SINGOLA PS (non classifica generale)
          psData[`pos${i+1}`] = p.storia[i]?.posizioneTempoPS || null;
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
          moto: p.moto,
          team: p.team,
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
      const url = `${FICR_BASE_URL}/END/mpcache-5/get/clasps/2025/99/11/1/${numeroProva}/1/*/*/*/*/*`;
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
      const url = `${FICR_BASE_URL}/END/mpcache-5/get/clasps/2025/99/11/1/${numeroProva}/1/*/*/*/*/*`;
      
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
    
    const url = `${FICR_BASE_URL}/END/mpcache-30/get/schedule/${anno}/*/*`;
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
    // PROVA = numero prova da importare (2, 4, 6, etc. - i numeri dispari sono controlli orario)
    // CATEGORIA = 1 (tutte le categorie piloti)
    const url = `${FICR_BASE_URL}/END/mpcache-5/get/clasps/${anno}/${codiceEquipe}/${manifestazione}/${categoria}/${prova}/1/*/*/*/*/*`;
    
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
// NUOVO Chat 20: IMPORT XML ISCRITTI (da Comitato Enduro)
// ============================================
app.post('/api/import-xml-iscritti', async (req, res) => {
  try {
    const { id_evento, xml_content } = req.body;
    
    if (!id_evento || !xml_content) {
      return res.status(400).json({ error: 'Parametri mancanti: id_evento e xml_content richiesti' });
    }
    
    // NUOVO Chat 21b: Recupera codice_gara per filtrare per categoria
    const eventoRes = await pool.query('SELECT codice_gara FROM eventi WHERE id = $1', [id_evento]);
    const codiceGara = eventoRes.rows[0]?.codice_gara || '';
    const isTraining = codiceGara.includes('-2');  // 303-2 = Training
    const isEpoca = codiceGara.includes('-3');     // 303-3 = Epoca
    
    console.log(`[IMPORT-XML] Inizio import per evento ${id_evento}, codice_gara=${codiceGara}, isTraining=${isTraining}, isEpoca=${isEpoca}`);
    
    // Decodifica base64 se necessario
    let xmlText = xml_content;
    if (xml_content.includes('base64,')) {
      xmlText = Buffer.from(xml_content.split('base64,')[1], 'base64').toString('utf-8');
    } else if (!xml_content.includes('<')) {
      // Probabilmente è base64 puro
      try {
        xmlText = Buffer.from(xml_content, 'base64').toString('utf-8');
      } catch (e) {
        // Non è base64, usa così com'è
      }
    }
    
    // Parser semplice XML per estrarre conduttori
    // Cerca tutti i tag <conduttore>...</conduttore>
    const conduttoriMatch = xmlText.match(/<conduttore>[\s\S]*?<\/conduttore>/g);
    
    if (!conduttoriMatch || conduttoriMatch.length === 0) {
      return res.status(400).json({ error: 'Nessun conduttore trovato nel file XML' });
    }
    
    console.log(`[IMPORT-XML] Trovati ${conduttoriMatch.length} conduttori nel file`);
    
    let pilotiImportati = 0;
    let pilotiAggiornati = 0;
    let pilotiSaltati = 0;
    let errori = [];
    
    for (const conduttoreXml of conduttoriMatch) {
      try {
        // Estrai campi dal XML
        const getField = (field) => {
          const match = conduttoreXml.match(new RegExp(`<${field}>([^<]*)</${field}>`));
          return match ? match[1].trim() : '';
        };
        
        const ngara = parseInt(getField('ngara')) || null;
        const cognome = getField('cognome');
        const nome = getField('nome');
        const licenza = getField('licenza');
        const classe = getField('classe');
        const categoria = getField('categoria');
        const moto = getField('motociclo');
        const motoclub = getField('motoclub');
        const regione = getField('regione');
        const annoNascita = parseInt(getField('anno_nascita')) || null;
        
        if (!ngara || !cognome) {
          console.log(`[IMPORT-XML] Saltato: ngara=${ngara}, cognome=${cognome}`);
          continue;
        }
        
        // NUOVO Chat 21b: Filtra per categoria gara
        const isClasseTU = classe === 'TU';
        
        if (isTraining && !isClasseTU) {
          // Training: importa SOLO classe TU
          pilotiSaltati++;
          continue;
        }
        
        if (!isTraining && !isEpoca && isClasseTU) {
          // Campionato: importa TUTTI tranne classe TU
          pilotiSaltati++;
          continue;
        }
        
        if (isEpoca) {
          // Epoca: questo XML non contiene piloti Epoca, saltare tutto
          pilotiSaltati++;
          continue;
        }
        
        console.log(`[IMPORT-XML] Processo #${ngara} ${cognome} ${nome} (classe: ${classe})`);
        
        // Verifica se pilota esiste già
        const existingResult = await pool.query(
          'SELECT id FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
          [id_evento, ngara]
        );
        
        if (existingResult.rows.length > 0) {
          // UPDATE pilota esistente
          await pool.query(
            `UPDATE piloti SET 
              cognome = $1, nome = $2, classe = $3, moto = $4, team = $5, 
              nazione = $6, licenza_fmi = $7, anno_nascita = $8
            WHERE id_evento = $9 AND numero_gara = $10`,
            [cognome, nome, classe, moto, motoclub, regione || 'ITA', licenza, annoNascita, id_evento, ngara]
          );
          pilotiAggiornati++;
        } else {
          // INSERT nuovo pilota
          await pool.query(
            `INSERT INTO piloti (id_evento, numero_gara, cognome, nome, classe, moto, team, nazione, licenza_fmi, anno_nascita)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id_evento, ngara, cognome, nome, classe, moto, motoclub, regione || 'ITA', licenza, annoNascita]
          );
          pilotiImportati++;
        }
        
      } catch (err) {
        console.error(`[IMPORT-XML] Errore singolo conduttore:`, err.message);
        errori.push(err.message);
      }
    }
    
    console.log(`[IMPORT-XML] Completato: ${pilotiImportati} nuovi, ${pilotiAggiornati} aggiornati, ${pilotiSaltati} saltati (filtro categoria)`);
    
    res.json({
      success: true,
      piloti_importati: pilotiImportati,
      piloti_aggiornati: pilotiAggiornati,
      piloti_saltati: pilotiSaltati,
      totale_processati: conduttoriMatch.length,
      filtro: isTraining ? 'Solo classe TU (Training)' : isEpoca ? 'Epoca (non supportato)' : 'Esclusa classe TU',
      errori: errori.length > 0 ? errori : undefined
    });
    
  } catch (err) {
    console.error('[IMPORT-XML] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// NUOVO Chat 20: IMPORT ORARI PARTENZA DA FICR STARTLIST
// ============================================
app.post('/api/import-orari-ficr', async (req, res) => {
  try {
    const { id_evento, anno, codiceEquipe, manifestazione, categoria } = req.body;
    
    if (!id_evento || !anno || !codiceEquipe || !manifestazione || !categoria) {
      return res.status(400).json({ 
        error: 'Parametri mancanti: id_evento, anno, codiceEquipe, manifestazione, categoria richiesti' 
      });
    }
    
    // API STARTLIST FICR
    // Parametri: anno/equipe/manifestazione/giorno/prova/categoria/*/*/*/*/*
    // giorno=1, prova=1 (partenza), categoria come passato
    const url = `${FICR_BASE_URL}/END/mpcache-20/get/startlist/${anno}/${codiceEquipe}/${manifestazione}/1/1/${categoria}/*/*/*/*/*`;
    
    console.log(`[IMPORT-ORARI] Chiamata FICR startlist: ${url}`);
    
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://enduro.ficr.it',
      'Referer': 'https://enduro.ficr.it/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      'Cache-Control': 'Private',
      'Pragma': 'no-cache'
    };
    
    const response = await axios.get(url, { headers });
    
    // Startlist può essere in data.clasdella o direttamente in data
    let pilotiFicr = response.data?.data?.clasdella || response.data?.data || [];
    
    // Se è un oggetto, prova a estrarre l'array
    if (!Array.isArray(pilotiFicr) && typeof pilotiFicr === 'object') {
      pilotiFicr = Object.values(pilotiFicr).flat();
    }
    
    console.log(`[IMPORT-ORARI] Piloti trovati da FICR: ${pilotiFicr.length}`);
    
    if (!Array.isArray(pilotiFicr) || pilotiFicr.length === 0) {
      return res.status(404).json({ error: 'Nessun pilota trovato nella startlist FICR' });
    }
    
    let pilotiAggiornati = 0;
    let pilotiNonTrovati = [];
    
    for (const pilota of pilotiFicr) {
      try {
        const numero = parseInt(pilota.Numero);
        const orario = pilota.Orario || pilota.op_Orario;
        
        if (!numero || !orario) {
          console.log(`[IMPORT-ORARI] Saltato: numero=${numero}, orario=${orario}`);
          continue;
        }
        
        // Estrai solo HH:MM se orario è in formato ISO
        let orarioPartenza = orario;
        if (orario.includes('T')) {
          // Formato ISO: 2000-01-01T09:00:00.000Z
          const match = orario.match(/T(\d{2}:\d{2})/);
          if (match) {
            orarioPartenza = match[1];
          }
        }
        
        console.log(`[IMPORT-ORARI] Aggiorno #${numero} -> orario ${orarioPartenza}`);
        
        // UPDATE orario_partenza
        const updateResult = await pool.query(
          'UPDATE piloti SET orario_partenza = $1 WHERE id_evento = $2 AND numero_gara = $3',
          [orarioPartenza, id_evento, numero]
        );
        
        if (updateResult.rowCount > 0) {
          pilotiAggiornati++;
        } else {
          pilotiNonTrovati.push(numero);
        }
        
      } catch (err) {
        console.error(`[IMPORT-ORARI] Errore singolo pilota:`, err.message);
      }
    }
    
    console.log(`[IMPORT-ORARI] Completato: ${pilotiAggiornati} aggiornati, ${pilotiNonTrovati.length} non trovati`);
    
    res.json({
      success: true,
      piloti_aggiornati: pilotiAggiornati,
      piloti_non_trovati: pilotiNonTrovati.length > 0 ? pilotiNonTrovati : undefined,
      totale_ficr: pilotiFicr.length
    });
    
  } catch (err) {
    console.error('[IMPORT-ORARI] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ENDPOINT COMUNICATI
// ============================================

// 1. CREA COMUNICATO
app.post('/api/comunicati', async (req, res) => {
  const { codice_gara, testo, pdf_allegato, pdf_nome, tipo } = req.body;
  const tipoDoc = tipo || 'comunicato'; // default: comunicato
  
  if (!codice_gara || !testo) {
    return res.status(400).json({ error: 'Codice gara e testo obbligatori' });
  }

  // Valida tipo
  const tipiValidi = ['comunicato', 'general_info', 'paddock_info'];
  if (!tipiValidi.includes(tipoDoc)) {
    return res.status(400).json({ error: 'Tipo non valido. Usa: comunicato, general_info, paddock_info' });
  }

  try {
    const numeroResult = await pool.query(
      'SELECT get_next_comunicato_number($1, $2) as numero',
      [codice_gara, tipoDoc]
    );
    const numero = numeroResult.rows[0].numero;

    const result = await pool.query(
      `INSERT INTO comunicati (codice_gara, numero, testo, ora, data, pdf_allegato, pdf_nome, tipo)
       VALUES ($1, $2, $3, CURRENT_TIME, CURRENT_DATE, $4, $5, $6)
       RETURNING *`,
      [codice_gara, numero, testo, pdf_allegato || null, pdf_nome || null, tipoDoc]
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
        pdf_nome: comunicato.pdf_nome,
        tipo: comunicato.tipo
      }
    });
  } catch (error) {
    console.error('Errore creazione comunicato:', error);
    res.status(500).json({ error: 'Errore creazione comunicato' });
  }
});

// 2. LISTA COMUNICATI PER GARA (con filtro opzionale per tipo)
app.get('/api/comunicati/:codice_gara', async (req, res) => {
  const { codice_gara } = req.params;
  const { tipo } = req.query; // ?tipo=comunicato oppure general_info o paddock_info

  try {
    let query = `SELECT id, numero, ora, data, testo, created_at, updated_at,
            pdf_allegato, pdf_nome, tipo,
            jsonb_array_length(letto_da) as num_letti
     FROM comunicati
     WHERE codice_gara = $1`;
    
    const params = [codice_gara];
    
    // Se specificato tipo, filtra
    if (tipo) {
      query += ` AND tipo = $2`;
      params.push(tipo);
    }
    
    query += ` ORDER BY numero DESC`;

    const result = await pool.query(query, params);

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

// 5. STATISTICHE (con filtro opzionale per tipo)
app.get('/api/comunicati/:codice_gara/stats', async (req, res) => {
  const { codice_gara } = req.params;
  const { tipo } = req.query;

  try {
    let query = `SELECT COUNT(*) as totale_comunicati, MAX(numero) as ultimo_numero
       FROM comunicati WHERE codice_gara = $1`;
    const params = [codice_gara];
    
    if (tipo) {
      query += ` AND tipo = $2`;
      params.push(tipo);
    }
    
    const stats = await pool.query(query, params);

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

// ============================================
// SIMULAZIONE LIVE - Per test polling
// ============================================

// Stato simulazioni in memoria (per ogni evento)
const simulationState = {};

// Reset simulazione per un evento
app.post('/api/eventi/:id/simulate-reset', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Carica TUTTI i tempi dell'evento
    const tempiResult = await pool.query(
      `SELECT t.id, t.id_pilota, t.id_ps, t.tempo_secondi, t.penalita_secondi,
              p.numero_gara, p.nome, p.cognome, p.classe,
              ps.numero_ordine, ps.nome_ps
       FROM tempi t
       JOIN piloti p ON t.id_pilota = p.id
       JOIN prove_speciali ps ON t.id_ps = ps.id
       WHERE ps.id_evento = $1
       ORDER BY ps.numero_ordine, t.tempo_secondi`,
      [id]
    );
    
    if (tempiResult.rows.length === 0) {
      return res.status(404).json({ error: 'Nessun tempo trovato per questo evento' });
    }
    
    // Mescola i tempi in ordine casuale (simula arrivo random)
    const tempiShuffled = tempiResult.rows
      .map(t => ({ ...t, sortKey: Math.random() }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map(({ sortKey, ...t }) => t);
    
    // Salva stato simulazione
    simulationState[id] = {
      tempiTotali: tempiShuffled,
      tempiRilasciati: [],
      indiceCorrente: 0,
      inizioSimulazione: new Date(),
      ultimoPolling: null
    };
    
    res.json({
      success: true,
      message: 'Simulazione resettata',
      tempiTotali: tempiShuffled.length,
      tempiRilasciati: 0,
      tempiRimanenti: tempiShuffled.length
    });
    
  } catch (error) {
    console.error('Errore reset simulazione:', error);
    res.status(500).json({ error: error.message });
  }
});

// Polling simulato - restituisce batch di tempi
app.get('/api/eventi/:id/simulate-poll', async (req, res) => {
  const { id } = req.params;
  const batchSize = parseInt(req.query.batch) || 15; // Default 15 tempi per batch
  
  try {
    // Se non c'è simulazione attiva, la inizializza
    if (!simulationState[id]) {
      // Auto-reset
      const tempiResult = await pool.query(
        `SELECT t.id, t.id_pilota, t.id_ps, t.tempo_secondi, t.penalita_secondi,
                p.numero_gara, p.nome, p.cognome, p.classe,
                ps.numero_ordine, ps.nome_ps
         FROM tempi t
         JOIN piloti p ON t.id_pilota = p.id
         JOIN prove_speciali ps ON t.id_ps = ps.id
         WHERE ps.id_evento = $1
         ORDER BY ps.numero_ordine, t.tempo_secondi`,
        [id]
      );
      
      if (tempiResult.rows.length === 0) {
        return res.json({
          success: true,
          nuoviTempi: [],
          tempiTotali: 0,
          tempiRilasciati: 0,
          tempiRimanenti: 0,
          simulazioneCompleta: true
        });
      }
      
      const tempiShuffled = tempiResult.rows
        .map(t => ({ ...t, sortKey: Math.random() }))
        .sort((a, b) => a.sortKey - b.sortKey)
        .map(({ sortKey, ...t }) => t);
      
      simulationState[id] = {
        tempiTotali: tempiShuffled,
        tempiRilasciati: [],
        indiceCorrente: 0,
        inizioSimulazione: new Date(),
        ultimoPolling: null
      };
    }
    
    const state = simulationState[id];
    
    // Calcola quanti tempi rilasciare (random tra 50% e 100% del batch)
    const minBatch = Math.ceil(batchSize * 0.5);
    const actualBatch = Math.floor(Math.random() * (batchSize - minBatch + 1)) + minBatch;
    
    // Estrai prossimi tempi
    const startIdx = state.indiceCorrente;
    const endIdx = Math.min(startIdx + actualBatch, state.tempiTotali.length);
    const nuoviTempi = state.tempiTotali.slice(startIdx, endIdx);
    
    // Aggiorna stato
    state.indiceCorrente = endIdx;
    state.tempiRilasciati = state.tempiRilasciati.concat(nuoviTempi);
    state.ultimoPolling = new Date();
    
    const simulazioneCompleta = state.indiceCorrente >= state.tempiTotali.length;
    
    res.json({
      success: true,
      nuoviTempi: nuoviTempi,
      tempiTotali: state.tempiTotali.length,
      tempiRilasciati: state.tempiRilasciati.length,
      tempiRimanenti: state.tempiTotali.length - state.indiceCorrente,
      simulazioneCompleta: simulazioneCompleta,
      polling: {
        batchRichiesto: batchSize,
        batchEffettivo: nuoviTempi.length,
        ultimoPolling: state.ultimoPolling
      }
    });
    
  } catch (error) {
    console.error('Errore polling simulazione:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stato corrente simulazione
app.get('/api/eventi/:id/simulate-status', async (req, res) => {
  const { id } = req.params;
  
  const state = simulationState[id];
  
  if (!state) {
    return res.json({
      success: true,
      attiva: false,
      message: 'Nessuna simulazione attiva per questo evento'
    });
  }
  
  res.json({
    success: true,
    attiva: true,
    tempiTotali: state.tempiTotali.length,
    tempiRilasciati: state.tempiRilasciati.length,
    tempiRimanenti: state.tempiTotali.length - state.indiceCorrente,
    simulazioneCompleta: state.indiceCorrente >= state.tempiTotali.length,
    inizioSimulazione: state.inizioSimulazione,
    ultimoPolling: state.ultimoPolling
  });
});

// ============================================
// FINE SIMULAZIONE LIVE
// ============================================

// ============================================
// NUOVO Chat 19: API PER APP ERTA (Enduro Race Timing Assistant)
// ============================================

// 1. LOGIN APP - Validazione codice_accesso + numero pilota
app.post('/api/app/login', async (req, res) => {
  try {
    const { codice_accesso, numero_pilota } = req.body;
    
    if (!codice_accesso || numero_pilota === undefined || numero_pilota === null) {
      return res.status(400).json({ 
        success: false, 
        error: 'Codice gara e numero pilota richiesti' 
      });
    }
    
    // Trova evento con questo codice_accesso O codice_gara (FICR)
    const eventoResult = await pool.query(
      'SELECT * FROM eventi WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Codice gara non valido' 
      });
    }
    
    const evento = eventoResult.rows[0];
    
    // NUOVO Chat 21: Login DdG con codice configurabile o "0" come fallback
    const codiceDdG = evento.codice_ddg || '0';
    const inputPulito = String(numero_pilota).trim().toUpperCase();
    
    if (inputPulito === codiceDdG.toUpperCase() || inputPulito === '0') {
      return res.json({
        success: true,
        isDdG: true,
        pilota: {
          id: null,
          numero: inputPulito,
          nome: 'Direzione',
          cognome: 'Gara',
          classe: 'DdG',
          moto: '',
          team: ''
        },
        evento: {
          id: evento.id,
          nome: evento.nome_evento,
          codice_gara: evento.codice_gara,
          data: evento.data_inizio,
          luogo: evento.luogo,
          gps_frequenza: evento.gps_frequenza || 30,
          allarme_fermo_minuti: evento.allarme_fermo_minuti || 10
        }
      });
    }
    
    // Trova pilota con questo numero in questo evento
    const pilotaResult = await pool.query(
      'SELECT * FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
      [evento.id, parseInt(numero_pilota)]
    );
    
    if (pilotaResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: `Pilota #${numero_pilota} non trovato in questa gara` 
      });
    }
    
    const pilota = pilotaResult.rows[0];
    
    res.json({
      success: true,
      isDdG: false,
      pilota: {
        id: pilota.id,
        numero: pilota.numero_gara,
        nome: pilota.nome,
        cognome: pilota.cognome,
        classe: pilota.classe,
        moto: pilota.moto,
        team: pilota.team
      },
      evento: {
        id: evento.id,
        nome: evento.nome_evento,
        codice_gara: evento.codice_gara,
        data: evento.data_inizio,
        luogo: evento.luogo,
        // NUOVO Chat 21: Parametri GPS
        gps_frequenza: evento.gps_frequenza || 30,
        allarme_fermo_minuti: evento.allarme_fermo_minuti || 10
      }
    });
  } catch (err) {
    console.error('[POST /api/app/login] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// 2. MIEI TEMPI - Prestazioni pilota
app.get('/api/app/miei-tempi/:codice_accesso/:numero_pilota', async (req, res) => {
  try {
    const { codice_accesso, numero_pilota } = req.params;
    
    // Trova evento
    const eventoResult = await pool.query(
      'SELECT * FROM eventi WHERE codice_accesso = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice gara non valido' });
    }
    
    const evento = eventoResult.rows[0];
    
    // Trova pilota
    const pilotaResult = await pool.query(
      'SELECT * FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
      [evento.id, parseInt(numero_pilota)]
    );
    
    if (pilotaResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pilota non trovato' });
    }
    
    const pilota = pilotaResult.rows[0];
    
    // Recupera prove speciali
    const proveResult = await pool.query(
      'SELECT * FROM prove_speciali WHERE id_evento = $1 ORDER BY numero_ordine',
      [evento.id]
    );
    
    // Recupera tempi del pilota
    const tempiResult = await pool.query(
      `SELECT t.*, ps.nome_ps, ps.numero_ordine 
       FROM tempi t
       JOIN prove_speciali ps ON t.id_ps = ps.id
       WHERE t.id_pilota = $1
       ORDER BY ps.numero_ordine`,
      [pilota.id]
    );
    
    // Calcola classifica assoluta
    const classificaResult = await pool.query(
      `SELECT p.id, p.numero_gara, p.cognome, p.nome, p.classe,
              SUM(t.tempo_secondi) as tempo_totale
       FROM piloti p
       JOIN tempi t ON t.id_pilota = p.id
       WHERE p.id_evento = $1
       GROUP BY p.id
       HAVING SUM(t.tempo_secondi) > 0
       ORDER BY tempo_totale ASC`,
      [evento.id]
    );
    
    // Trova posizione assoluta
    const posAssoluta = classificaResult.rows.findIndex(r => r.id === pilota.id) + 1;
    const totPiloti = classificaResult.rows.length;
    
    // Calcola posizione di classe
    const pilotiClasse = classificaResult.rows.filter(r => r.classe === pilota.classe);
    const posClasse = pilotiClasse.findIndex(r => r.id === pilota.id) + 1;
    const totClasse = pilotiClasse.length;
    
    // Calcola tempo totale pilota
    const tempoTotale = tempiResult.rows.reduce((sum, t) => sum + parseFloat(t.tempo_secondi || 0), 0);
    
    // Formatta tempo
    const formatTempo = (sec) => {
      if (!sec || sec === 0) return '--';
      const mins = Math.floor(sec / 60);
      const secs = (sec % 60).toFixed(2);
      return `${mins}:${secs.padStart(5, '0')}`;
    };
    
    // Gap dal primo
    let gapPrimo = null;
    if (classificaResult.rows.length > 0 && posAssoluta > 1) {
      const primo = classificaResult.rows[0];
      gapPrimo = `+${formatTempo(tempoTotale - parseFloat(primo.tempo_totale))}`;
    }
    
    res.json({
      success: true,
      pilota: {
        numero: pilota.numero_gara,
        nome: pilota.nome,
        cognome: pilota.cognome,
        classe: pilota.classe,
        moto: pilota.moto
      },
      posizione_assoluta: posAssoluta || '-',
      totale_piloti: totPiloti,
      posizione_classe: posClasse || '-',
      totale_classe: totClasse,
      tempo_totale: formatTempo(tempoTotale),
      gap_primo: gapPrimo,
      prove: tempiResult.rows.map(t => ({
        ps: t.numero_ordine,
        nome: t.nome_ps,
        tempo: formatTempo(parseFloat(t.tempo_secondi)),
        penalita: t.penalita_secondi || 0
      })),
      ultimo_aggiornamento: new Date().toISOString()
    });
  } catch (err) {
    console.error('[GET /api/app/miei-tempi] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// 3. COMUNICATI APP - Lista comunicati per codice_accesso
app.get('/api/app/comunicati/:codice_accesso', async (req, res) => {
  try {
    const { codice_accesso } = req.params;
    const { after, tipo } = req.query; // timestamp per polling incrementale + tipo documento
    
    // Trova evento (accetta sia codice_accesso che codice_gara)
    const eventoResult = await pool.query(
      'SELECT * FROM eventi WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice gara non valido' });
    }
    
    const evento = eventoResult.rows[0];
    
    // Query comunicati (con filtro opzionale per polling e tipo)
    let query = `
      SELECT id, numero, ora, data, testo, tipo,
             CASE WHEN pdf_allegato IS NOT NULL THEN true ELSE false END as ha_pdf,
             pdf_nome, created_at
      FROM comunicati 
      WHERE codice_gara = $1
    `;
    const params = [evento.codice_gara];
    let paramIndex = 2;
    
    if (tipo) {
      query += ` AND tipo = $${paramIndex}`;
      params.push(tipo);
      paramIndex++;
    }
    
    if (after) {
      query += ` AND created_at > $${paramIndex}`;
      params.push(after);
    }
    
    query += ' ORDER BY numero DESC';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      evento: evento.nome_evento,
      comunicati: result.rows,
      totale: result.rows.length,
      ultimo_aggiornamento: new Date().toISOString()
    });
  } catch (err) {
    console.error('[GET /api/app/comunicati] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// 4. DOWNLOAD PDF COMUNICATO (per app)
app.get('/api/app/comunicati/:codice_accesso/pdf/:id', async (req, res) => {
  try {
    const { codice_accesso, id } = req.params;
    
    // Verifica codice_accesso
    const eventoResult = await pool.query(
      'SELECT codice_gara FROM eventi WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice gara non valido' });
    }
    
    // Recupera PDF
    const result = await pool.query(
      'SELECT pdf_allegato, pdf_nome FROM comunicati WHERE id = $1 AND codice_gara = $2',
      [id, eventoResult.rows[0].codice_gara]
    );
    
    if (result.rows.length === 0 || !result.rows[0].pdf_allegato) {
      return res.status(404).json({ success: false, error: 'PDF non trovato' });
    }
    
    res.json({
      success: true,
      pdf_base64: result.rows[0].pdf_allegato,
      nome: result.rows[0].pdf_nome
    });
  } catch (err) {
    console.error('[GET /api/app/comunicati/pdf] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// ============================================
// API ERTA OPEN - Accesso senza login (Chat 21)
// ============================================

// GET info evento + piloti + comunicati (NO LOGIN) - Aggrega per codice_fmi
app.get('/api/app/evento/:codice/open', async (req, res) => {
  try {
    const { codice } = req.params;
    const codiceUpper = codice.toUpperCase();
    
    // Prima cerca per codice_fmi (può restituire multiple gare)
    let eventiResult = await pool.query(
      `SELECT id, nome_evento, data_inizio, luogo, codice_gara, codice_accesso, codice_fmi 
       FROM eventi 
       WHERE UPPER(codice_fmi) = $1`,
      [codiceUpper]
    );
    
    // Se non trova per codice_fmi, cerca per codice_accesso o codice_gara (retrocompatibilità)
    if (eventiResult.rows.length === 0) {
      eventiResult = await pool.query(
        `SELECT id, nome_evento, data_inizio, luogo, codice_gara, codice_accesso, codice_fmi 
         FROM eventi 
         WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1`,
        [codiceUpper]
      );
    }
    
    if (eventiResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Evento non trovato' });
    }
    
    const eventi = eventiResult.rows;
    const eventoIds = eventi.map(e => e.id);
    const codiciGara = eventi.map(e => e.codice_gara);
    
    // Lista piloti aggregata da tutte le gare
    const pilotiResult = await pool.query(
      `SELECT p.numero_gara, p.cognome, p.nome, p.classe, p.moto, p.team, p.orario_partenza, e.codice_gara
       FROM piloti p
       JOIN eventi e ON p.id_evento = e.id
       WHERE p.id_evento = ANY($1)
       ORDER BY p.numero_gara`,
      [eventoIds]
    );
    
    // Comunicati aggregati da tutte le gare
    const comunicatiResult = await pool.query(
      `SELECT id, numero, ora, data, testo, tipo, codice_gara,
              CASE WHEN pdf_allegato IS NOT NULL THEN true ELSE false END as ha_pdf,
              pdf_nome
       FROM comunicati 
       WHERE codice_gara = ANY($1)
       ORDER BY created_at DESC`,
      [codiciGara]
    );
    
    // Raggruppa comunicati per tipo
    const comunicati = {
      comunicato: comunicatiResult.rows.filter(c => c.tipo === 'comunicato'),
      general_info: comunicatiResult.rows.filter(c => c.tipo === 'general_info'),
      paddock_info: comunicatiResult.rows.filter(c => c.tipo === 'paddock_info')
    };
    
    // Info manifestazione (prendi dal primo evento)
    const primoEvento = eventi[0];
    
    console.log(`[ERTA OPEN] Codice: ${codice}, Gare: ${eventi.length}, Piloti: ${pilotiResult.rows.length}`);
    
    res.json({
      success: true,
      codice_fmi: primoEvento.codice_fmi || codice,
      manifestazione: {
        luogo: primoEvento.luogo,
        data: primoEvento.data_inizio
      },
      gare: eventi.map(e => ({
        codice_gara: e.codice_gara,
        nome: e.nome_evento
      })),
      piloti: pilotiResult.rows,
      comunicati: comunicati,
      totale_piloti: pilotiResult.rows.length,
      totale_gare: eventi.length
    });
    
  } catch (err) {
    console.error('[GET /api/app/evento/:codice/open] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// ============================================
// NUOVO Chat 22: API ERTA PUBBLICO (senza autenticazione pilota)
// ============================================

// Funzione helper per trovare gare da codice FMI pubblico
async function trovaGareDaCodicePubblico(codice) {
  const codiceUpper = codice.toUpperCase().trim();
  
  // Cerca in codice_fmi
  let result = await pool.query(
    `SELECT * FROM eventi WHERE UPPER(codice_fmi) = $1`,
    [codiceUpper]
  );
  
  // Se non trova, cerca in codice_accesso_pubblico (può contenere multipli separati da virgola)
  if (result.rows.length === 0) {
    result = await pool.query(
      `SELECT * FROM eventi WHERE UPPER(codice_accesso_pubblico) LIKE $1`,
      [`%${codiceUpper}%`]
    );
  }
  
  // Fallback: cerca per codice_gara o codice_accesso
  if (result.rows.length === 0) {
    result = await pool.query(
      `SELECT * FROM eventi WHERE UPPER(codice_gara) = $1 OR UPPER(codice_accesso) = $1`,
      [codiceUpper]
    );
  }
  
  return result.rows;
}

// 1. LOGIN PUBBLICO - Solo codice FMI
app.post('/api/app/login-pubblico', async (req, res) => {
  try {
    const { codice_fmi } = req.body;
    
    if (!codice_fmi) {
      return res.status(400).json({ success: false, error: 'Codice FMI richiesto' });
    }
    
    const gare = await trovaGareDaCodicePubblico(codice_fmi);
    
    if (gare.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice non valido' });
    }
    
    res.json({
      success: true,
      isPublic: true,
      codice_fmi: codice_fmi.toUpperCase(),
      gare: gare.map(g => ({
        id: g.id,
        codice_gara: g.codice_gara,
        nome: g.nome_evento,
        data: g.data_inizio,
        luogo: g.luogo
      }))
    });
  } catch (err) {
    console.error('[POST /api/app/login-pubblico] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// 2. ISCRITTI PUBBLICO - Lista piloti ordinata per cognome
app.get('/api/app/pubblico/iscritti/:codice_fmi', async (req, res) => {
  try {
    const { codice_fmi } = req.params;
    const gare = await trovaGareDaCodicePubblico(codice_fmi);
    
    if (gare.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice non valido' });
    }
    
    const eventoIds = gare.map(g => g.id);
    
    const pilotiResult = await pool.query(
      `SELECT p.numero_gara, p.cognome, p.nome, p.classe, p.moto, p.team, e.codice_gara
       FROM piloti p
       JOIN eventi e ON p.id_evento = e.id
       WHERE p.id_evento = ANY($1)
       ORDER BY p.cognome, p.nome`,
      [eventoIds]
    );
    
    res.json({
      success: true,
      totale: pilotiResult.rows.length,
      piloti: pilotiResult.rows.map(p => ({
        numero: p.numero_gara,
        cognome: p.cognome,
        nome: p.nome,
        classe: p.classe,
        moto: p.moto,
        team: p.team,
        gara: p.codice_gara
      }))
    });
  } catch (err) {
    console.error('[GET /api/app/pubblico/iscritti] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// 3. ORDINE PARTENZA PUBBLICO - Lista piloti ordinata per orario
app.get('/api/app/pubblico/ordine/:codice_fmi', async (req, res) => {
  try {
    const { codice_fmi } = req.params;
    const gare = await trovaGareDaCodicePubblico(codice_fmi);
    
    if (gare.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice non valido' });
    }
    
    const eventoIds = gare.map(g => g.id);
    
    const pilotiResult = await pool.query(
      `SELECT p.numero_gara, p.cognome, p.nome, p.classe, p.orario_partenza, e.codice_gara
       FROM piloti p
       JOIN eventi e ON p.id_evento = e.id
       WHERE p.id_evento = ANY($1) AND p.orario_partenza IS NOT NULL
       ORDER BY p.orario_partenza, p.numero_gara`,
      [eventoIds]
    );
    
    res.json({
      success: true,
      totale: pilotiResult.rows.length,
      partenze: pilotiResult.rows.map(p => ({
        numero: p.numero_gara,
        cognome: p.cognome,
        nome: p.nome,
        classe: p.classe,
        orario: p.orario_partenza ? p.orario_partenza.substring(0, 5) : null,
        gara: p.codice_gara
      }))
    });
  } catch (err) {
    console.error('[GET /api/app/pubblico/ordine] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// 4. PROGRAMMA PUBBLICO - Prove speciali da FICR
app.get('/api/app/pubblico/programma/:codice_fmi', async (req, res) => {
  try {
    const { codice_fmi } = req.params;
    const gare = await trovaGareDaCodicePubblico(codice_fmi);
    
    if (gare.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice non valido' });
    }
    
    // Prende parametri FICR dalla prima gara
    const gara = gare[0];
    const anno = gara.ficr_anno || new Date().getFullYear();
    const equipe = gara.ficr_codice_equipe;
    const manif = gara.ficr_manifestazione;
    
    if (!equipe || !manif) {
      return res.json({
        success: true,
        prove: [],
        message: 'Parametri FICR non configurati'
      });
    }
    
    // Estrai categoria dal codice gara (303-1 -> 1)
    const categoria = parseInt(gara.codice_gara.split('-')[1]) || 1;
    
    // Chiama API FICR program
    const apiUrl = `https://apienduro.ficr.it/END/mpcache-30/get/program/${anno}/${equipe}/${manif}/${categoria}`;
    console.log('[PROGRAMMA PUBBLICO] Chiamata FICR:', apiUrl);
    
    try {
      const ficrRes = await fetch(apiUrl);
      if (ficrRes.ok) {
        const ficrData = await ficrRes.json();
        const prove = ficrData.data || ficrData || [];
        
        res.json({
          success: true,
          gara: gara.nome_evento,
          prove: Array.isArray(prove) ? prove.map(p => ({
            sigla: p.Sigla,
            descrizione: p.Description,
            lunghezza: p.Length,
            data: p.Data
          })) : []
        });
      } else {
        res.json({ success: true, prove: [], message: 'Programma non disponibile da FICR' });
      }
    } catch (ficrErr) {
      console.error('[PROGRAMMA PUBBLICO] Errore FICR:', ficrErr.message);
      res.json({ success: true, prove: [], message: 'Programma non disponibile' });
    }
  } catch (err) {
    console.error('[GET /api/app/pubblico/programma] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// 5. COMUNICATI PUBBLICO - Comunicati di gara
app.get('/api/app/pubblico/comunicati/:codice_fmi', async (req, res) => {
  try {
    const { codice_fmi } = req.params;
    const gare = await trovaGareDaCodicePubblico(codice_fmi);
    
    if (gare.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice non valido' });
    }
    
    const codiciGara = gare.map(g => g.codice_gara);
    
    const comunicatiResult = await pool.query(
      `SELECT id, numero, ora, data, testo, tipo, codice_gara,
              CASE WHEN pdf_allegato IS NOT NULL THEN true ELSE false END as ha_pdf,
              pdf_nome, created_at
       FROM comunicati
       WHERE codice_gara = ANY($1) AND (tipo = 'comunicato' OR tipo IS NULL)
       ORDER BY created_at DESC`,
      [codiciGara]
    );
    
    res.json({
      success: true,
      totale: comunicatiResult.rows.length,
      comunicati: comunicatiResult.rows.map(c => ({
        id: c.id,
        numero: c.numero,
        ora: c.ora,
        data: c.data,
        testo: c.testo,
        gara: c.codice_gara,
        ha_pdf: c.ha_pdf,
        pdf_nome: c.pdf_nome,
        created_at: c.created_at
      }))
    });
  } catch (err) {
    console.error('[GET /api/app/pubblico/comunicati] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// 6. SERVIZIO PUBBLICO - Comunicazioni di servizio (tipo = 'servizio')
app.get('/api/app/pubblico/servizio/:codice_fmi', async (req, res) => {
  try {
    const { codice_fmi } = req.params;
    const gare = await trovaGareDaCodicePubblico(codice_fmi);
    
    if (gare.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice non valido' });
    }
    
    const codiciGara = gare.map(g => g.codice_gara);
    
    const servizioResult = await pool.query(
      `SELECT id, numero, ora, data, testo, codice_gara,
              CASE WHEN pdf_allegato IS NOT NULL THEN true ELSE false END as ha_pdf,
              pdf_nome, created_at
       FROM comunicati
       WHERE codice_gara = ANY($1) AND tipo = 'servizio'
       ORDER BY created_at DESC`,
      [codiciGara]
    );
    
    res.json({
      success: true,
      totale: servizioResult.rows.length,
      comunicazioni: servizioResult.rows.map(c => ({
        id: c.id,
        numero: c.numero,
        ora: c.ora,
        data: c.data,
        testo: c.testo,
        gara: c.codice_gara,
        ha_pdf: c.ha_pdf,
        pdf_nome: c.pdf_nome,
        created_at: c.created_at
      }))
    });
  } catch (err) {
    console.error('[GET /api/app/pubblico/servizio] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore server' });
  }
});

// ============================================
// FINE API APP ERTA PUBBLICO
// ============================================

// ============================================
// FINE API APP ERTA
// ============================================

// ============================================
// NUOVO Chat 20: API BIDIREZIONALE - MESSAGGI PILOTI → DDG
// ============================================

// 1. SOS/EMERGENZA - Pilota invia emergenza
app.post('/api/app/sos', async (req, res) => {
  try {
    const { codice_accesso, numero_pilota, testo, gps_lat, gps_lon } = req.body;
    
    if (!codice_accesso || !numero_pilota) {
      return res.status(400).json({ success: false, error: 'Dati mancanti' });
    }
    
    // Trova evento
    const eventoResult = await pool.query(
      'SELECT codice_gara FROM eventi WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice gara non valido' });
    }
    
    const codice_gara = eventoResult.rows[0].codice_gara;
    
    // Inserisci emergenza
    const result = await pool.query(
      `INSERT INTO messaggi_piloti (codice_gara, numero_pilota, tipo, testo, gps_lat, gps_lon)
       VALUES ($1, $2, 'sos', $3, $4, $5)
       RETURNING *`,
      [codice_gara, parseInt(numero_pilota), testo || 'EMERGENZA SOS', gps_lat || null, gps_lon || null]
    );
    
    console.log(`🆘 SOS RICEVUTO: Pilota #${numero_pilota} - Gara ${codice_gara}`);
    
    res.json({ 
      success: true, 
      messaggio: result.rows[0],
      alert: 'SOS inviato alla Direzione Gara'
    });
  } catch (err) {
    console.error('[POST /api/app/sos] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore invio SOS' });
  }
});

// 2. MESSAGGIO - Pilota invia messaggio normale
app.post('/api/app/messaggio', async (req, res) => {
  try {
    const { codice_accesso, numero_pilota, tipo, testo, gps_lat, gps_lon } = req.body;
    
    if (!codice_accesso || !numero_pilota || !testo) {
      return res.status(400).json({ success: false, error: 'Dati mancanti' });
    }
    
    // Trova evento
    const eventoResult = await pool.query(
      'SELECT codice_gara FROM eventi WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice gara non valido' });
    }
    
    const codice_gara = eventoResult.rows[0].codice_gara;
    
    // Tipi validi: assistenza, pericolo, info, altro
    const tipoValido = ['assistenza', 'pericolo', 'info', 'altro'].includes(tipo) ? tipo : 'altro';
    
    // Inserisci messaggio
    const result = await pool.query(
      `INSERT INTO messaggi_piloti (codice_gara, numero_pilota, tipo, testo, gps_lat, gps_lon)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [codice_gara, parseInt(numero_pilota), tipoValido, testo, gps_lat || null, gps_lon || null]
    );
    
    console.log(`📝 Messaggio ricevuto: Pilota #${numero_pilota} - Tipo: ${tipoValido}`);
    
    res.json({ 
      success: true, 
      messaggio: result.rows[0],
      alert: 'Messaggio inviato alla Direzione Gara'
    });
  } catch (err) {
    console.error('[POST /api/app/messaggio] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore invio messaggio' });
  }
});

// 3. LISTA MESSAGGI - Per pannello admin DdG
app.get('/api/messaggi-piloti/:codice_gara', async (req, res) => {
  try {
    const { codice_gara } = req.params;
    const { solo_non_letti, tipo } = req.query;
    
    let query = `
      SELECT mp.*, p.nome, p.cognome, p.classe, p.moto
      FROM messaggi_piloti mp
      LEFT JOIN piloti p ON mp.numero_pilota = p.numero_gara 
        AND p.id_evento = (SELECT id FROM eventi WHERE codice_gara = $1 LIMIT 1)
      WHERE mp.codice_gara = $1
    `;
    const params = [codice_gara];
    
    if (solo_non_letti === 'true') {
      query += ' AND mp.letto = FALSE';
    }
    
    if (tipo) {
      query += ` AND mp.tipo = $${params.length + 1}`;
      params.push(tipo);
    }
    
    query += ' ORDER BY mp.created_at DESC';
    
    const result = await pool.query(query, params);
    
    // Conta non letti e SOS
    const countResult = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE letto = FALSE) as non_letti,
        COUNT(*) FILTER (WHERE tipo = 'sos' AND letto = FALSE) as sos_attivi
       FROM messaggi_piloti WHERE codice_gara = $1`,
      [codice_gara]
    );
    
    res.json({
      success: true,
      messaggi: result.rows,
      totale: result.rows.length,
      non_letti: parseInt(countResult.rows[0].non_letti),
      sos_attivi: parseInt(countResult.rows[0].sos_attivi)
    });
  } catch (err) {
    console.error('[GET /api/messaggi-piloti] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore recupero messaggi' });
  }
});

// 4. SEGNA COME LETTO
app.put('/api/messaggi-piloti/:id/letto', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'UPDATE messaggi_piloti SET letto = TRUE WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Messaggio non trovato' });
    }
    
    res.json({ success: true, messaggio: result.rows[0] });
  } catch (err) {
    console.error('[PUT /api/messaggi-piloti/letto] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore aggiornamento' });
  }
});

// 5. SEGNA TUTTI COME LETTI
app.put('/api/messaggi-piloti/:codice_gara/letti-tutti', async (req, res) => {
  try {
    const { codice_gara } = req.params;
    
    await pool.query(
      'UPDATE messaggi_piloti SET letto = TRUE WHERE codice_gara = $1',
      [codice_gara]
    );
    
    res.json({ success: true, message: 'Tutti i messaggi segnati come letti' });
  } catch (err) {
    console.error('[PUT /api/messaggi-piloti/letti-tutti] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore aggiornamento' });
  }
});

// ============================================
// FINE API BIDIREZIONALE
// ============================================

// ============================================
// NUOVO Chat 20: API SQUADRE
// ============================================

// 1. CREA SQUADRA
app.post('/api/app/squadra', async (req, res) => {
  try {
    const { codice_accesso, numero_pilota, nome_squadra, membri } = req.body;
    
    if (!codice_accesso || !numero_pilota || !nome_squadra) {
      return res.status(400).json({ success: false, error: 'Dati mancanti' });
    }
    
    // Trova evento
    const eventoResult = await pool.query(
      'SELECT codice_gara FROM eventi WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice gara non valido' });
    }
    
    const codice_gara = eventoResult.rows[0].codice_gara;
    
    // Verifica se il pilota ha già una squadra
    const esistente = await pool.query(
      `SELECT id FROM squadre WHERE codice_gara = $1 AND (creatore_numero = $2 OR $2 = ANY(membri))`,
      [codice_gara, parseInt(numero_pilota)]
    );
    
    if (esistente.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Sei già in una squadra' });
    }
    
    // Prepara membri (array di numeri, include creatore)
    let membriArray = [parseInt(numero_pilota)];
    if (membri && Array.isArray(membri)) {
      membri.forEach(m => {
        const num = parseInt(m);
        if (num && !membriArray.includes(num)) {
          membriArray.push(num);
        }
      });
    }
    
    // Crea squadra
    const result = await pool.query(
      `INSERT INTO squadre (codice_gara, nome_squadra, creatore_numero, membri)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [codice_gara, nome_squadra, parseInt(numero_pilota), membriArray]
    );
    
    console.log(`👥 Squadra creata: ${nome_squadra} - ${membriArray.length} membri`);
    
    res.json({ 
      success: true, 
      squadra: result.rows[0]
    });
  } catch (err) {
    console.error('[POST /api/app/squadra] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore creazione squadra' });
  }
});

// 2. OTTIENI SQUADRA DEL PILOTA
app.get('/api/app/squadra/:codice_accesso/:numero_pilota', async (req, res) => {
  try {
    const { codice_accesso, numero_pilota } = req.params;
    
    // Trova evento
    const eventoResult = await pool.query(
      'SELECT codice_gara FROM eventi WHERE UPPER(codice_accesso) = $1 OR UPPER(codice_gara) = $1',
      [codice_accesso.toUpperCase()]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Codice gara non valido' });
    }
    
    const codice_gara = eventoResult.rows[0].codice_gara;
    const numero = parseInt(numero_pilota);
    
    // Cerca squadra dove il pilota è creatore o membro
    const result = await pool.query(
      `SELECT * FROM squadre 
       WHERE codice_gara = $1 AND (creatore_numero = $2 OR $2 = ANY(membri))`,
      [codice_gara, numero]
    );
    
    if (result.rows.length === 0) {
      return res.json({ success: true, squadra: null });
    }
    
    const squadra = result.rows[0];
    
    // Ottieni info piloti membri
    const pilotiResult = await pool.query(
      `SELECT numero_gara, nome, cognome, classe, moto 
       FROM piloti 
       WHERE id_evento = (SELECT id FROM eventi WHERE codice_gara = $1 LIMIT 1)
       AND numero_gara = ANY($2)`,
      [codice_gara, squadra.membri]
    );
    
    res.json({
      success: true,
      squadra: {
        ...squadra,
        piloti: pilotiResult.rows
      }
    });
  } catch (err) {
    console.error('[GET /api/app/squadra] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore recupero squadra' });
  }
});

// 3. AGGIUNGI MEMBRO A SQUADRA
app.put('/api/app/squadra/:id/aggiungi', async (req, res) => {
  try {
    const { id } = req.params;
    const { numero_pilota } = req.body;
    
    if (!numero_pilota) {
      return res.status(400).json({ success: false, error: 'Numero pilota mancante' });
    }
    
    const numero = parseInt(numero_pilota);
    
    // Verifica che il pilota non sia già in un'altra squadra
    const squadraResult = await pool.query('SELECT * FROM squadre WHERE id = $1', [id]);
    if (squadraResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Squadra non trovata' });
    }
    
    const squadra = squadraResult.rows[0];
    
    // Verifica se pilota esiste nella gara
    const pilotaResult = await pool.query(
      `SELECT numero_gara FROM piloti 
       WHERE id_evento = (SELECT id FROM eventi WHERE codice_gara = $1 LIMIT 1)
       AND numero_gara = $2`,
      [squadra.codice_gara, numero]
    );
    
    if (pilotaResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pilota non trovato in questa gara' });
    }
    
    // Verifica se già in altra squadra
    const altraSquadra = await pool.query(
      `SELECT id FROM squadre WHERE codice_gara = $1 AND id != $2 AND $3 = ANY(membri)`,
      [squadra.codice_gara, id, numero]
    );
    
    if (altraSquadra.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Il pilota è già in un\'altra squadra' });
    }
    
    // Aggiungi membro
    const result = await pool.query(
      `UPDATE squadre SET membri = array_append(membri, $1) WHERE id = $2 AND NOT ($1 = ANY(membri)) RETURNING *`,
      [numero, id]
    );
    
    res.json({ success: true, squadra: result.rows[0] });
  } catch (err) {
    console.error('[PUT /api/app/squadra/aggiungi] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore aggiunta membro' });
  }
});

// 4. RIMUOVI MEMBRO DA SQUADRA
app.put('/api/app/squadra/:id/rimuovi', async (req, res) => {
  try {
    const { id } = req.params;
    const { numero_pilota } = req.body;
    
    const numero = parseInt(numero_pilota);
    
    // Verifica che non sia il creatore
    const squadraResult = await pool.query('SELECT * FROM squadre WHERE id = $1', [id]);
    if (squadraResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Squadra non trovata' });
    }
    
    if (squadraResult.rows[0].creatore_numero === numero) {
      return res.status(400).json({ success: false, error: 'Il creatore non può essere rimosso' });
    }
    
    // Rimuovi membro
    const result = await pool.query(
      `UPDATE squadre SET membri = array_remove(membri, $1) WHERE id = $2 RETURNING *`,
      [numero, id]
    );
    
    res.json({ success: true, squadra: result.rows[0] });
  } catch (err) {
    console.error('[PUT /api/app/squadra/rimuovi] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore rimozione membro' });
  }
});

// 5. CLASSIFICA SQUADRA (tempi e posizioni dei membri)
app.get('/api/app/classifica-squadra/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Ottieni squadra
    const squadraResult = await pool.query('SELECT * FROM squadre WHERE id = $1', [id]);
    if (squadraResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Squadra non trovata' });
    }
    
    const squadra = squadraResult.rows[0];
    const codice_gara = squadra.codice_gara;
    
    // Ottieni evento ID
    const eventoResult = await pool.query(
      'SELECT id FROM eventi WHERE codice_gara = $1',
      [codice_gara]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Evento non trovato' });
    }
    
    const eventoId = eventoResult.rows[0].id;
    
    // Ottieni lista prove speciali della gara
    const proveResult = await pool.query(
      'SELECT id, nome_ps, numero_ordine FROM prove_speciali WHERE id_evento = $1 ORDER BY numero_ordine',
      [eventoId]
    );
    const numProveTotali = proveResult.rows.length;
    const listaProve = proveResult.rows;
    
    // Ottieni classifica completa con conteggio prove
    const classificaResult = await pool.query(`
      SELECT 
        p.numero_gara,
        p.nome,
        p.cognome,
        p.classe,
        p.moto,
        COALESCE(SUM(t.tempo_secondi), 0) + COALESCE(SUM(t.penalita_secondi), 0) as tempo_totale,
        COUNT(t.id) as prove_completate
      FROM piloti p
      LEFT JOIN tempi t ON p.id = t.id_pilota
      WHERE p.id_evento = $1
      GROUP BY p.id, p.numero_gara, p.nome, p.cognome, p.classe, p.moto
      HAVING COUNT(t.id) > 0
      ORDER BY 
        COUNT(t.id) DESC,
        tempo_totale ASC
    `, [eventoId]);
    
    // Calcola posizioni assolute (solo chi ha completato tutte le prove prima)
    let posizione = 0;
    const classificaConPosizioni = classificaResult.rows.map((row, idx) => {
      posizione = idx + 1;
      return { 
        ...row, 
        posizione_assoluta: posizione,
        ritirato: parseInt(row.prove_completate) < numProveTotali
      };
    });
    
    // Filtra solo membri squadra
    let membriClassifica = classificaConPosizioni.filter(p => 
      squadra.membri.includes(p.numero_gara)
    );
    
    // Ordina: prima chi ha completato tutto, poi per tempo
    membriClassifica.sort((a, b) => {
      if (a.ritirato !== b.ritirato) return a.ritirato ? 1 : -1;
      return a.tempo_totale - b.tempo_totale;
    });
    
    membriClassifica.forEach((m, idx) => {
      m.posizione_squadra = idx + 1;
    });
    
    // Ottieni tempi dettagliati per ogni PS per i membri della squadra
    const tempiDettagliatiResult = await pool.query(`
      SELECT 
        p.numero_gara,
        ps.numero_ordine,
        ps.nome_ps,
        t.tempo_secondi,
        t.penalita_secondi
      FROM piloti p
      JOIN tempi t ON p.id = t.id_pilota
      JOIN prove_speciali ps ON t.id_ps = ps.id
      WHERE p.id_evento = $1 AND p.numero_gara = ANY($2)
      ORDER BY p.numero_gara, ps.numero_ordine
    `, [eventoId, squadra.membri]);
    
    // Ottieni TUTTI i tempi di TUTTI i piloti per calcolare posizioni assolute
    const tuttiTempiResult = await pool.query(`
      SELECT 
        p.numero_gara,
        ps.numero_ordine,
        t.tempo_secondi,
        t.penalita_secondi
      FROM piloti p
      JOIN tempi t ON p.id = t.id_pilota
      JOIN prove_speciali ps ON t.id_ps = ps.id
      WHERE p.id_evento = $1
      ORDER BY ps.numero_ordine, (t.tempo_secondi + COALESCE(t.penalita_secondi, 0)) ASC
    `, [eventoId]);
    
    // Calcola classifica per ogni PS (posizione assoluta)
    const classifichePerPS = {};
    tuttiTempiResult.rows.forEach(t => {
      const ps = t.numero_ordine;
      if (!classifichePerPS[ps]) classifichePerPS[ps] = [];
      classifichePerPS[ps].push({
        numero_gara: t.numero_gara,
        tempo: parseFloat(t.tempo_secondi) + parseFloat(t.penalita_secondi || 0)
      });
    });
    
    // Ordina per tempo e assegna posizioni
    Object.keys(classifichePerPS).forEach(ps => {
      classifichePerPS[ps].sort((a, b) => a.tempo - b.tempo);
      classifichePerPS[ps].forEach((p, idx) => {
        p.posizione = idx + 1;
      });
    });
    
    // Organizza tempi per pilota
    const tempiPerPilota = {};
    tempiDettagliatiResult.rows.forEach(t => {
      if (!tempiPerPilota[t.numero_gara]) {
        tempiPerPilota[t.numero_gara] = {};
      }
      const tempoTot = parseFloat(t.tempo_secondi) + parseFloat(t.penalita_secondi || 0);
      
      // Trova posizione assoluta per questa PS
      const classificaPS = classifichePerPS[t.numero_ordine] || [];
      const pilotaInClassifica = classificaPS.find(p => p.numero_gara === t.numero_gara);
      const posizioneAssoluta = pilotaInClassifica ? pilotaInClassifica.posizione : null;
      
      tempiPerPilota[t.numero_gara][t.numero_ordine] = {
        tempo: tempoTot,
        nome_prova: t.nome_ps,
        posizione_assoluta: posizioneAssoluta
      };
    });
    
    // Calcola mediana dei tempi squadra per ogni PS
    const medianePS = {};
    listaProve.forEach(ps => {
      const tempiSquadraPS = [];
      squadra.membri.forEach(num => {
        if (tempiPerPilota[num] && tempiPerPilota[num][ps.numero_ordine]) {
          tempiSquadraPS.push(tempiPerPilota[num][ps.numero_ordine].tempo);
        }
      });
      if (tempiSquadraPS.length > 0) {
        const sorted = [...tempiSquadraPS].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        medianePS[ps.numero_ordine] = sorted.length % 2 !== 0 
          ? sorted[mid] 
          : (sorted[mid - 1] + sorted[mid]) / 2;
      }
    });
    
    // Calcola miglior tempo per ogni PS (per evidenziare il migliore)
    const migliorTempoPS = {};
    listaProve.forEach(ps => {
      let minTempo = Infinity;
      squadra.membri.forEach(num => {
        if (tempiPerPilota[num] && tempiPerPilota[num][ps.numero_ordine]) {
          if (tempiPerPilota[num][ps.numero_ordine].tempo < minTempo) {
            minTempo = tempiPerPilota[num][ps.numero_ordine].tempo;
          }
        }
      });
      migliorTempoPS[ps.numero_ordine] = minTempo;
    });
    
    // Helper per formattare tempo
    const formatTempo = (sec) => {
      if (!sec || sec === 0) return '--';
      const min = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      const cent = Math.round((sec % 1) * 100);
      return `${min}:${s.toString().padStart(2, '0')}.${cent.toString().padStart(2, '0')}`;
    };
    
    // Formatta tempi e aggiungi dettagli PS
    membriClassifica.forEach(m => {
      const tot = parseFloat(m.tempo_totale);
      m.tempo_formattato = formatTempo(tot);
      m.prove_completate = parseInt(m.prove_completate);
      m.prove_totali = numProveTotali;
      
      // Gap dal primo della squadra (non ritirato)
      const primoNonRitirato = membriClassifica.find(x => !x.ritirato);
      if (m.posizione_squadra > 1 && primoNonRitirato && !m.ritirato) {
        const gap = tot - parseFloat(primoNonRitirato.tempo_totale);
        m.gap = '+' + formatTempo(gap);
      } else {
        m.gap = m.ritirato ? 'RIT' : '';
      }
      
      // Aggiungi tempi per ogni PS
      m.tempi_ps = {};
      listaProve.forEach(ps => {
        if (tempiPerPilota[m.numero_gara] && tempiPerPilota[m.numero_gara][ps.numero_ordine]) {
          const t = tempiPerPilota[m.numero_gara][ps.numero_ordine];
          const mediana = medianePS[ps.numero_ordine];
          const scostamento = mediana ? parseFloat((t.tempo - mediana).toFixed(2)) : null;
          
          m.tempi_ps[ps.numero_ordine] = {
            tempo: formatTempo(t.tempo),
            tempo_raw: t.tempo,
            nome: t.nome_prova,
            migliore: t.tempo === migliorTempoPS[ps.numero_ordine],
            posizione_assoluta: t.posizione_assoluta,
            scostamento: scostamento
          };
        } else {
          m.tempi_ps[ps.numero_ordine] = { tempo: '--', tempo_raw: null, nome: '', migliore: false, posizione_assoluta: null, scostamento: null };
        }
      });
    });
    
    // Prepara lista prove con nomi e mediane
    const proveInfo = listaProve.map(ps => ({
      numero: ps.numero_ordine,
      nome: ps.nome_ps || `PS${ps.numero_ordine}`,
      mediana: medianePS[ps.numero_ordine] || null
    }));
    
    res.json({
      success: true,
      squadra: {
        id: squadra.id,
        nome: squadra.nome_squadra,
        creatore: squadra.creatore_numero,
        totale_membri: squadra.membri.length
      },
      prove: proveInfo,
      classifica: membriClassifica,
      ultimo_aggiornamento: new Date().toISOString()
    });
  } catch (err) {
    console.error('[GET /api/app/classifica-squadra] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore calcolo classifica' });
  }
});

// 6. ELIMINA SQUADRA (solo creatore)
app.delete('/api/app/squadra/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { numero_pilota } = req.body;
    
    // Verifica che sia il creatore
    const squadraResult = await pool.query('SELECT * FROM squadre WHERE id = $1', [id]);
    if (squadraResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Squadra non trovata' });
    }
    
    if (squadraResult.rows[0].creatore_numero !== parseInt(numero_pilota)) {
      return res.status(403).json({ success: false, error: 'Solo il creatore può eliminare la squadra' });
    }
    
    await pool.query('DELETE FROM squadre WHERE id = $1', [id]);
    
    res.json({ success: true, message: 'Squadra eliminata' });
  } catch (err) {
    console.error('[DELETE /api/app/squadra] Error:', err.message);
    res.status(500).json({ success: false, error: 'Errore eliminazione squadra' });
  }
});

// ============================================
// DASHBOARD DDG MULTI-EVENTO
// ============================================

// Endpoint che restituisce SOS, piloti fermi e posizioni per tutti gli eventi "fratelli"
// (stesso prefisso codice_gara, es. 303-1, 303-2, 303-3)
app.get('/api/ddg/multi/:codice_gara', async (req, res) => {
  try {
    const { codice_gara } = req.params;
    
    // Estrai prefisso (tutto prima del trattino, es. "303" da "303-1")
    const prefisso = codice_gara.split('-')[0];
    
    // Trova tutti gli eventi con lo stesso prefisso
    const eventiResult = await pool.query(
      `SELECT id, codice_gara, nome_evento, paddock1_lat, paddock1_lon, paddock2_lat, paddock2_lon, 
              paddock_raggio, allarme_fermo_minuti
       FROM eventi 
       WHERE codice_gara LIKE $1 || '-%'
       ORDER BY codice_gara`,
      [prefisso]
    );
    
    if (eventiResult.rows.length === 0) {
      return res.json({ success: true, eventi: [], sos: [], piloti_fermi: [], piloti_segnale_perso: [], posizioni: [] });
    }
    
    const eventi = eventiResult.rows;
    const eventiIds = eventi.map(e => e.id);
    const codiciGara = eventi.map(e => e.codice_gara);
    
    // 1. SOS attivi da tutti gli eventi
    const sosResult = await pool.query(
      `SELECT mp.*, e.codice_gara, e.nome_evento
       FROM messaggi_piloti mp
       JOIN eventi e ON mp.codice_gara = e.codice_gara
       WHERE mp.codice_gara = ANY($1) AND mp.tipo = 'sos' AND mp.letto = false
       ORDER BY mp.created_at DESC`,
      [codiciGara]
    );
    
    // 2. Per ogni evento, calcola piloti fermi e segnale perso
    let tuttiPilotiFermi = [];
    let tuttiSegnalePerso = [];
    let tuttiPosizioni = [];
    
    for (const evento of eventi) {
      const allarmeMinuti = evento.allarme_fermo_minuti || 10;
      const raggioP = evento.paddock_raggio || 500;
      
      // Posizioni piloti
      const posResult = await pool.query(
        `SELECT DISTINCT ON (numero_pilota) numero_pilota, lat, lon, created_at
         FROM posizioni_piloti 
         WHERE codice_gara = $1
         ORDER BY numero_pilota, created_at DESC`,
        [evento.codice_gara]
      );
      
      for (const pos of posResult.rows) {
        // Verifica se nel paddock
        let inPaddock = false;
        if (evento.paddock1_lat && evento.paddock1_lon) {
          const dist1 = Math.sqrt(Math.pow((pos.lat - evento.paddock1_lat) * 111000, 2) + Math.pow((pos.lon - evento.paddock1_lon) * 85000, 2));
          if (dist1 < raggioP) inPaddock = true;
        }
        if (evento.paddock2_lat && evento.paddock2_lon) {
          const dist2 = Math.sqrt(Math.pow((pos.lat - evento.paddock2_lat) * 111000, 2) + Math.pow((pos.lon - evento.paddock2_lon) * 85000, 2));
          if (dist2 < raggioP) inPaddock = true;
        }
        
        const minutiFa = Math.floor((Date.now() - new Date(pos.created_at).getTime()) / 60000);
        
        // Segnale perso (no GPS da X minuti)
        if (minutiFa > allarmeMinuti && !inPaddock) {
          tuttiSegnalePerso.push({
            ...pos,
            codice_gara: evento.codice_gara,
            nome_evento: evento.nome_evento,
            minuti_senza_segnale: minutiFa
          });
        }
        
        // Aggiungi a posizioni
        tuttiPosizioni.push({
          ...pos,
          codice_gara: evento.codice_gara,
          nome_evento: evento.nome_evento,
          minuti_fa: minutiFa
        });
      }
      
      // Piloti fermi (movimento < 50m in X minuti)
      const fermiResult = await pool.query(
        `WITH posizioni_recenti AS (
          SELECT numero_pilota, lat, lon, created_at,
                 LAG(lat) OVER (PARTITION BY numero_pilota ORDER BY created_at) as prev_lat,
                 LAG(lon) OVER (PARTITION BY numero_pilota ORDER BY created_at) as prev_lon,
                 LAG(created_at) OVER (PARTITION BY numero_pilota ORDER BY created_at) as prev_time
          FROM posizioni_piloti
          WHERE codice_gara = $1 AND created_at > NOW() - INTERVAL '${allarmeMinuti * 2} minutes'
        )
        SELECT numero_pilota, lat, lon, created_at,
               SQRT(POW((lat - prev_lat) * 111000, 2) + POW((lon - prev_lon) * 85000, 2)) as distanza
        FROM posizioni_recenti
        WHERE prev_lat IS NOT NULL`,
        [evento.codice_gara]
      );
      
      // Raggruppa per pilota e verifica movimento
      const movimentoPiloti = {};
      for (const pos of fermiResult.rows) {
        if (!movimentoPiloti[pos.numero_pilota]) {
          movimentoPiloti[pos.numero_pilota] = { totale: 0, ultimaPos: pos };
        }
        movimentoPiloti[pos.numero_pilota].totale += parseFloat(pos.distanza) || 0;
        movimentoPiloti[pos.numero_pilota].ultimaPos = pos;
      }
      
      for (const [numero, data] of Object.entries(movimentoPiloti)) {
        if (data.totale < 50) {
          // Verifica non in paddock
          let inPaddock = false;
          if (evento.paddock1_lat && evento.paddock1_lon) {
            const dist1 = Math.sqrt(Math.pow((data.ultimaPos.lat - evento.paddock1_lat) * 111000, 2) + Math.pow((data.ultimaPos.lon - evento.paddock1_lon) * 85000, 2));
            if (dist1 < raggioP) inPaddock = true;
          }
          if (!inPaddock) {
            tuttiPilotiFermi.push({
              numero_pilota: parseInt(numero),
              lat: data.ultimaPos.lat,
              lon: data.ultimaPos.lon,
              codice_gara: evento.codice_gara,
              nome_evento: evento.nome_evento,
              movimento_totale: Math.round(data.totale)
            });
          }
        }
      }
    }
    
    res.json({
      success: true,
      eventi: eventi.map(e => ({ codice_gara: e.codice_gara, nome_evento: e.nome_evento })),
      sos: sosResult.rows,
      piloti_fermi: tuttiPilotiFermi,
      piloti_segnale_perso: tuttiSegnalePerso,
      posizioni: tuttiPosizioni
    });
    
  } catch (err) {
    console.error('[GET /api/ddg/multi] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// FINE API SQUADRE
// ============================================

// ============================================
// API TEMPI SETTORE - Chat 20
// ============================================

// GET tempi settore per evento
app.get('/api/eventi/:id/tempi-settore', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM tempi_settore WHERE id_evento = $1 ORDER BY codice_gara',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/eventi/:id/tempi-settore] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST/PUT tempi settore per gara specifica
app.post('/api/eventi/:id/tempi-settore', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      codice_gara, 
      co1_attivo, 
      co2_attivo, 
      co3_attivo,
      tempo_par_co1,
      tempo_co1_co2,
      tempo_co2_co3,
      tempo_ultimo_arr
    } = req.body;
    
    // Upsert - inserisci o aggiorna
    const result = await pool.query(`
      INSERT INTO tempi_settore (id_evento, codice_gara, co1_attivo, co2_attivo, co3_attivo, tempo_par_co1, tempo_co1_co2, tempo_co2_co3, tempo_ultimo_arr)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id_evento, codice_gara) 
      DO UPDATE SET 
        co1_attivo = EXCLUDED.co1_attivo,
        co2_attivo = EXCLUDED.co2_attivo,
        co3_attivo = EXCLUDED.co3_attivo,
        tempo_par_co1 = EXCLUDED.tempo_par_co1,
        tempo_co1_co2 = EXCLUDED.tempo_co1_co2,
        tempo_co2_co3 = EXCLUDED.tempo_co2_co3,
        tempo_ultimo_arr = EXCLUDED.tempo_ultimo_arr
      RETURNING *
    `, [id, codice_gara, co1_attivo, co2_attivo, co3_attivo, tempo_par_co1, tempo_co1_co2, tempo_co2_co3, tempo_ultimo_arr]);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[POST /api/eventi/:id/tempi-settore] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET orari teorici per pilota specifico
app.get('/api/app/orari-teorici/:codice_gara/:numero_pilota', async (req, res) => {
  try {
    const { codice_gara, numero_pilota } = req.params;
    
    // 1. Trova evento e tempi settore
    const eventoResult = await pool.query(
      'SELECT e.*, ts.* FROM eventi e LEFT JOIN tempi_settore ts ON e.id = ts.id_evento AND ts.codice_gara = $1 WHERE e.codice_gara = $1',
      [codice_gara]
    );
    
    if (eventoResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Evento non trovato' });
    }
    
    const evento = eventoResult.rows[0];
    
    // 2. Trova pilota con orario partenza
    const pilotaResult = await pool.query(
      'SELECT * FROM piloti WHERE id_evento = $1 AND numero_gara = $2',
      [evento.id, numero_pilota]
    );
    
    if (pilotaResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pilota non trovato' });
    }
    
    const pilota = pilotaResult.rows[0];
    
    // 3. Se non ci sono tempi settore configurati, restituisci solo partenza
    if (!evento.tempo_par_co1) {
      return res.json({
        success: true,
        pilota: {
          numero: pilota.numero_gara,
          cognome: pilota.cognome,
          nome: pilota.nome
        },
        orari_configurati: false,
        messaggio: 'Tempi settore non ancora configurati'
      });
    }
    
    // 4. Calcola orari teorici
    // L'orario partenza deve venire da FICR (campo orario_partenza nel pilota)
    // Per ora usiamo un campo che dovremo aggiungere, oppure calcoliamo dalla sequenza
    const orarioPartenza = pilota.orario_partenza || '09:00'; // Default, da implementare
    
    // Parsing orario partenza
    const [ore, minuti] = orarioPartenza.split(':').map(Number);
    let minTotali = ore * 60 + minuti;
    
    const orari = {
      partenza: orarioPartenza
    };
    
    // CO1
    if (evento.co1_attivo && evento.tempo_par_co1) {
      minTotali += evento.tempo_par_co1;
      orari.co1 = `${Math.floor(minTotali / 60).toString().padStart(2, '0')}:${(minTotali % 60).toString().padStart(2, '0')}`;
    }
    
    // CO2
    if (evento.co2_attivo && evento.tempo_co1_co2) {
      minTotali += evento.tempo_co1_co2;
      orari.co2 = `${Math.floor(minTotali / 60).toString().padStart(2, '0')}:${(minTotali % 60).toString().padStart(2, '0')}`;
    }
    
    // CO3
    if (evento.co3_attivo && evento.tempo_co2_co3) {
      minTotali += evento.tempo_co2_co3;
      orari.co3 = `${Math.floor(minTotali / 60).toString().padStart(2, '0')}:${(minTotali % 60).toString().padStart(2, '0')}`;
    }
    
    // Arrivo
    if (evento.tempo_ultimo_arr) {
      minTotali += evento.tempo_ultimo_arr;
      orari.arrivo = `${Math.floor(minTotali / 60).toString().padStart(2, '0')}:${(minTotali % 60).toString().padStart(2, '0')}`;
    }
    
    res.json({
      success: true,
      pilota: {
        numero: pilota.numero_gara,
        cognome: pilota.cognome,
        nome: pilota.nome
      },
      orari_configurati: true,
      orari: orari,
      checkpoint_attivi: {
        co1: evento.co1_attivo,
        co2: evento.co2_attivo,
        co3: evento.co3_attivo
      }
    });
    
  } catch (err) {
    console.error('[GET /api/app/orari-teorici] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// FINE API TEMPI SETTORE
// ============================================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
