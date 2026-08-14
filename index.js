const mqtt = require('mqtt');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔹 Informations HiveMQ
const BROKER_URL = 'mqtts://ffe7ee4e59c342ec8d655e8c9d74d81e.s1.eu.hivemq.cloud:8883';
const USERNAME = 'ferhat.mustapha';
const PASSWORD = 'Btsfermus.2020';

let waterState = 0; // Niveau en % (0 à 100)

// 🔹 Connexion MQTT
const client = mqtt.connect(BROKER_URL, {
  username: USERNAME,
  password: PASSWORD
});

client.on('connect', () => {
  console.log('✅ Backend connecté à HiveMQ');
  client.subscribe('oran/water/pressure');
  console.log('📡 Abonné au topic oran/water/pressure');
});

client.on('message', (topic, message) => {
  const rawMsg = message.toString().trim();
  console.log('📩 Message reçu :', rawMsg);

  try {
    // 1. Essai de lecture au format JSON (ESP8266)
    const payload = JSON.parse(rawMsg);
    
    if (payload.pressure_bar !== undefined) {
      // Conversion de la pression (ex: 0 à 3 bars) en pourcentage (0 à 100%)
      const maxPressure = 3.0; // Pression max du capteur
      let calculatedPercent = (payload.pressure_bar / maxPressure) * 100;
      
      // Limiter la valeur entre 0% et 100%
      waterState = Math.min(Math.max(calculatedPercent, 0), 100);
      
      console.log(`📊 ESP8266 -> Pression: ${payload.pressure_bar} Bar | Niveau: ${waterState.toFixed(1)}%`);
    } else if (payload.water !== undefined) {
      waterState = parseFloat(payload.water);
    }
  } catch (e) {
    // 2. Si ce n'est pas du JSON, traitement texte simple (ex: test via MQTT Explorer)
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

// 🔹 API HTTP pour l'application Android
app.get('/api/status', (req, res) => {
  res.json({
    water: waterState,
    status: waterState > 0 ? 'present' : 'absent'
  });
});

// 🔹 Démarrage du serveur
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 API HTTP accessible sur http://0.0.0.0:${PORT}/api/status`);
});