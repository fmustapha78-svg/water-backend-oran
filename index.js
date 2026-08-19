const mqtt = require('mqtt');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔹 Initialisation Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'https://hxlasxginwmphmgrinvv.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY; // Utiliser la clé service_role sur Render

const supabase = createClient(supabaseUrl, supabaseKey);

// 🔹 Configuration HiveMQ Cloud
const BROKER_URL = 'mqtts://92a6f58e0c8b4090a0eacfc30f19e310.s1.eu.hivemq.cloud:8883';
const USERNAME = process.env.MQTT_USER || 'ferhat.mustapha';
const PASSWORD = process.env.MQTT_PASS || 'Btsfermus.2020';

let waterState = 0; // Niveau d'eau en %

// 🔹 Connexion MQTT
const client = mqtt.connect(BROKER_URL, {
  username: USERNAME,
  password: PASSWORD,
  rejectUnauthorized: false
});

client.on('connect', () => {
  console.log('✅ Backend connecté à HiveMQ Cloud');
  client.subscribe('oran/water/pressure');
  console.log('📡 Abonné au topic : oran/water/pressure');
});

client.on('message', async (topic, message) => {
  const rawMsg = message.toString().trim();
  console.log('📩 Message reçu :', rawMsg);

  try {
    const payload = JSON.parse(rawMsg);
    
    if (payload.pressure_bar !== undefined) {
      // Conversion de la pression (0 à 3 bars) en pourcentage (0 à 100%)
      const maxPressure = 3.0; 
      let calculatedPercent = (payload.pressure_bar / maxPressure) * 100;
      
      waterState = Math.min(Math.max(calculatedPercent, 0), 100);
      
      console.log(`📊 ESP8266 -> Pression: ${payload.pressure_bar} Bar | Niveau: ${waterState.toFixed(1)}%`);

      // Enregistrement dans Supabase
      const { error } = await supabase
        .from('water_pressure_logs')
        .insert([
          {
            sensor_id: payload.device_id || payload.sensor_id || 'oran_001',
            pressure_bar: payload.pressure_bar
          }
        ]);

      if (error) {
        console.error('❌ Erreur Supabase :', error.message);
      } else {
        console.log('✅ Donnée enregistrée dans Supabase !');
      }

    } else if (payload.water !== undefined) {
      waterState = parseFloat(payload.water);
    }
  } catch (e) {
    const val = parseFloat(rawMsg);
    if (!isNaN(val)) {
      waterState = val;
      console.log(`🧪 Test manuel -> Niveau défini à : ${waterState}%`);
    } else {
      console.log('⚠️ Format de message non reconnu');
    }
  }
});

client.on('error', (err) => {
  console.error('❌ Erreur MQTT :', err);
});

// 🔹 Route API pour l'application mobile / web
app.get('/api/status', (req, res) => {
  res.json({
    water: waterState,
    status: waterState > 0 ? 'present' : 'absent'
  });
});

// 🔹 Lancement du serveur HTTP
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 API HTTP accessible sur le port ${PORT}`);
});