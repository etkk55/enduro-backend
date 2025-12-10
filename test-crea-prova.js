const axios = require('axios');

const API_BASE = 'https://daring-eagerness-production-34de.up.railway.app/api';

// ID evento Isola Vicentina esistente
const ID_EVENTO = 'd304e826-5128-4554-b5b5-57c50a6acf90';

async function test() {
  try {
    console.log('Creo prova speciale per evento esistente...');
    const ps = await axios.post(`${API_BASE}/prove-speciali`, {
      nome_ps: 'Prova Test 1',
      numero_ordine: 2,
      id_evento: ID_EVENTO
    });
    console.log('✅ PROVA CREATA:', ps.data);
    
    console.log('\n🎉 TEST COMPLETATO!');
  } catch (err) {
    console.error('❌ ERRORE:', err.response?.data || err.message);
  }
}

test();
