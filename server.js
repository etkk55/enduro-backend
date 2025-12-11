// ============================================
// SIMULAZIONE LIVE - Per test polling
// Aggiungere PRIMA di app.listen()
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
              ps.numero_prova, ps.nome as nome_prova
       FROM tempi t
       JOIN piloti p ON t.id_pilota = p.id
       JOIN prove_speciali ps ON t.id_ps = ps.id
       WHERE ps.id_evento = $1
       ORDER BY ps.numero_prova, t.tempo_secondi`,
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
                ps.numero_prova, ps.nome as nome_prova
         FROM tempi t
         JOIN piloti p ON t.id_pilota = p.id
         JOIN prove_speciali ps ON t.id_ps = ps.id
         WHERE ps.id_evento = $1
         ORDER BY ps.numero_prova, t.tempo_secondi`,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
