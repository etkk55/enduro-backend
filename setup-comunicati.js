const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function setup() {
  try {
    console.log('🔄 Rinomino vecchia tabella...');
    await pool.query('ALTER TABLE comunicati RENAME TO comunicati_old');
    
    console.log('✅ Creo nuova tabella comunicati...');
    await pool.query(`
      CREATE TABLE comunicati (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        codice_gara VARCHAR(20) NOT NULL,
        numero INTEGER NOT NULL,
        ora TIME NOT NULL DEFAULT CURRENT_TIME,
        data DATE NOT NULL DEFAULT CURRENT_DATE,
        testo TEXT NOT NULL,
        inviato_a JSONB DEFAULT '[]'::jsonb,
        letto_da JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(codice_gara, numero)
      )
    `);
    
    console.log('✅ Creo indici...');
    await pool.query('CREATE INDEX idx_comunicati_gara ON comunicati(codice_gara)');
    await pool.query('CREATE INDEX idx_comunicati_data ON comunicati(data DESC, ora DESC)');
    
    console.log('✅ Creo funzione numero automatico...');
    await pool.query(`
      CREATE OR REPLACE FUNCTION get_next_comunicato_number(gara_code VARCHAR)
      RETURNS INTEGER AS $$
      DECLARE
        next_num INTEGER;
      BEGIN
        SELECT COALESCE(MAX(numero), 0) + 1 INTO next_num
        FROM comunicati
        WHERE codice_gara = gara_code;
        RETURN next_num;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    console.log('✅ Creo tabella piloti_gara...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS piloti_gara (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        codice_gara VARCHAR(20) NOT NULL,
        numero_pilota INTEGER NOT NULL,
        nome VARCHAR(255),
        cognome VARCHAR(255),
        device_token VARCHAR(500),
        ultimo_accesso TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(codice_gara, numero_pilota)
      )
    `);
    
    await pool.query('CREATE INDEX IF NOT EXISTS idx_piloti_gara_codice ON piloti_gara(codice_gara)');
    
    console.log('✅ Inserisco dati di test...');
    await pool.query(`
      INSERT INTO piloti_gara (codice_gara, numero_pilota, nome, cognome)
      VALUES 
        ('VENEN010', 1, 'Mario', 'Rossi'),
        ('VENEN010', 23, 'Luigi', 'Verdi'),
        ('VENEN010', 45, 'Giuseppe', 'Bianchi')
      ON CONFLICT DO NOTHING
    `);
    
    console.log('\n🎉 SETUP COMPLETATO!\n');
    
    // Verifica
    const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'comunicati'
      ORDER BY ordinal_position
    `);
    
    console.log('📋 Nuova struttura tabella comunicati:');
    console.table(result.rows);
    
    pool.end();
  } catch (err) {
    console.error('❌ Errore:', err.message);
    pool.end();
  }
}

setup();
