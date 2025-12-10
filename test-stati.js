const axios = require('axios');

const API_BASE = 'https://daring-eagerness-production-34de.up.railway.app/api';
const ID_EVENTO = 'd304e826-5128-4554-b5b5-57c50a6acf90';

const stati = ['attiva', 'non_iniziata', 'in_corso', 'completata', 'non iniziata'];

async function test() {
  for (const stato of stati) {
    try {
      console.log(`\nProvo stato: "${stato}"...`);
      await axios.post(`${API_BASE}/prove-speciali`, {
        nome_ps: `Test ${stato}`,
        numero_ordine: Math.floor(Math.random() * 1000),
        id_evento: ID_EVENTO,
        stato: stato
      });
      console.log(`✅ "${stato}" FUNZIONA!`);
      return;
    } catch (err) {
      console.log(`❌ "${stato}" non funziona`);
    }
  }
  console.log('\n❌ Nessuno stato funziona!');
}

test();
