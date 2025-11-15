const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

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
// IMPORT FICR ENDPOINT
// ============================================

app.post('/api/import-ficr', async (req, res) => {
  try {
    const { url, id_evento } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Estrai parametri dall'URL
    // URL format: https://enduro.ficr.it/#/END/pdf/Campionato%20Regionale%20Enduro/2025/107/303/1
    const urlParts = url.split('/');
    const anno = urlParts[urlParts.length - 3];
    const codiceEquipe = urlParts[urlParts.length - 2];
    const manifestazione = urlParts[urlParts.length - 1];
    
    console.log(`Importing data for: ${anno}/${codiceEquipe}/${manifestazione}`);
    
    // Chiama API FICR per descrizione evento
    const descrizioneUrl = `https://apienduro.ficr.it/END/mpcache-30/get/descrizione/${anno}/${codiceEquipe}/${manifestazione}`;
    const descrizioneResponse = await axios.get(descrizioneUrl);
    
    if (descrizioneResponse.data.code !== 200 || !descrizioneResponse.data.data) {
      return res.status(400).json({ error: 'Invalid FICR data' });
    }
    
    const eventoData = descrizioneResponse.data.data[0];
    
    // Costruisci l'URL del PDF
    // Dal browser: https://enduro.ficr.it/#/END/pdf/Campionato%20Regionale%20Enduro/2025/107/303/1
    // URL reale PDF: https://dati.ficr.it/utilities/RAL/Campionato Regionale Enduro/2025/107/303/1
    const pdfPath = url.split('/END/pdf/')[1];
    const pdfUrl = `https://dati.ficr.it/utilities/RAL/${pdfPath}`;
    
    console.log(`Downloading PDF from: ${pdfUrl}`);
    
    // Scarica il PDF
    const pdfResponse = await axios.get(pdfUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000
    });
    
    console.log(`PDF downloaded, size: ${pdfResponse.data.byteLength} bytes`);
    
    // Parse PDF con pdfjs
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfResponse.data)
    });
    const pdfDocument = await loadingTask.promise;
    
    console.log(`PDF has ${pdfDocument.numPages} pages`);
    
    let text = '';
    for (let i = 1; i <= pdfDocument.numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      text += pageText + '\n';
    }
    
    console.log(`Extracted text length: ${text.length} characters`);
    
    // Estrai piloti dal testo del PDF
    // Pattern: numero nome cognome anno PAR CO1 CO2 ARR
    // Esempio: "101 PELLIZZARO Davide (PD) 1999 9.00 11.45 14.30 15.00"
    const pilotiRegex = /(\d+)\s+([A-Z]+)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+\(([A-Z]{2})\)\s+(\d{4})\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/g;
    
    const piloti = [];
    let match;
    
    while ((match = pilotiRegex.exec(text)) !== null) {
      piloti.push({
        numero_gara: parseInt(match[1]),
        cognome: match[2],
        nome: match[3],
        provincia: match[4],
        anno_nascita: parseInt(match[5]),
        par: match[6],
        co1: match[7],
        co2: match[8],
        arr: match[9]
      });
    }
    
    console.log(`Found ${piloti.length} piloti in PDF`);
    
    if (piloti.length === 0) {
      console.log('Sample text from PDF:', text.substring(0, 500));
      return res.status(400).json({ 
        error: 'No pilots found in PDF. Check PDF format.',
        sample_text: text.substring(0, 500)
      });
    }
    
    // Importa nel database
    let importedCount = 0;
    const errors = [];
    
    for (const pilota of piloti) {
      try {
        await pool.query(
          `INSERT INTO piloti (nome, cognome, numero_gara, categoria, id_evento, email, telefono)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (numero_gara, id_evento) DO NOTHING`,
          [
            pilota.nome,
            pilota.cognome,
            pilota.numero_gara,
            null,
            id_evento,
            null,
            null
          ]
        );
        importedCount++;
      } catch (error) {
        errors.push({
          pilota: `${pilota.numero_gara} ${pilota.nome} ${pilota.cognome}`,
          error: error.message
        });
      }
    }
    
    res.json({
      success: true,
      message: `Successfully imported ${importedCount} piloti from FICR`,
      evento: {
        nome: eventoData.ma_Descrizione1,
        localita: eventoData.ma_Localita,
        data: eventoData.ma_Data
      },
      piloti_trovati: piloti.length,
      piloti_importati: importedCount,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
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
        t.tempo_secondi,
        t.penalita_secondi,
        p.id as id_pilota,
        p.nome,
        p.cognome,
        p.numero_gara
      FROM tempi t
      JOIN piloti p ON t.id_pilota = p.id
      ORDER BY t.tempo_secondi ASC
    `);
    
    // Converti tempo_secondi in minuti, secondi, centesimi per il frontend
    const tempiFormatted = result.rows.map(tempo => {
      const tempoTotale = parseFloat(tempo.tempo_secondi) || 0;
      const minuti = Math.floor(tempoTotale / 60);
      const secondi = Math.floor(tempoTotale % 60);
      const centesimi = Math.round((tempoTotale % 1) * 100);
      
      return {
        ...tempo,
        tempo_minuti: minuti,
        tempo_secondi: secondi,
        tempo_centesimi: centesimi
      };
    });
    
    res.json(tempiFormatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create tempo
app.post('/api/tempi', async (req, res) => {
  try {
    const { id_pilota, id_ps, tempo_minuti, tempo_secondi, tempo_centesimi, penalita } = req.body;
    
    // Calcola tempo_secondi totale
    const tempoTotaleSecondi = (tempo_minuti * 60) + tempo_secondi + (tempo_centesimi / 100);
    
    const result = await pool.query(
      `INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id_pilota, id_ps, tempoTotaleSecondi, penalita || 0]
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
        SUM(t.tempo_secondi) as tempo_totale
      FROM piloti p
      LEFT JOIN tempi t ON p.id = t.id_pilota
      GROUP BY p.id, p.nome, p.cognome, p.numero_gara
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
