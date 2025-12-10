const axios = require('axios');

const API_BASE = 'https://daring-eagerness-production-34de.up.railway.app/api';

const eventiDaEliminare = [
  'd304e826-5128-4554-b5b5-57c50a6acf90',
  '52a85054-3caa-4e20-b6aa-c7965b140c95',
  '91dae889-298b-4f8a-8a59-e27225e96d0e'
];

async function elimina() {
  for (const id of eventiDaEliminare) {
    try {
      await axios.delete(`${API_BASE}/eventi/${id}`);
      console.log(`✅ Eliminato evento ${id}`);
    } catch (err) {
      console.log(`❌ Errore ${id}: ${err.message}`);
    }
  }
  console.log('✅ Fatto!');
}

elimina();
