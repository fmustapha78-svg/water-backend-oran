require('dotenv').config(); //[cite: 1]
const mqtt = require('mqtt'); //[cite: 1]
const express = require('express'); //[cite: 1]
const helmet = require('helmet'); //[cite: 1]
const cors = require('cors'); //[cite: 1]
const rateLimit = require('express-rate-limit'); //[cite: 1]
const { createClient } = require('@supabase/supabase-js'); //[cite: 1]

const app = express(); //[cite: 1]
const PORT = process.env.PORT || 3000; //[cite: 1]

// Configuration pour le reverse proxy Render
app.set('trust proxy', 1); //[cite: 1]

// -----------------------------------------------------------------------------
// 1. VÉRIFICATION DES VARIABLES D'ENVIRONNEMENT
// -----------------------------------------------------------------------------
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_KEY', 'MQTT_HOST', 'MQTT_USER', 'MQTT_PASS']; //[cite: 1]
for (const envVar of requiredEnv) { //[cite: 1]
  if (!process.env[envVar]) { //[cite: 1]
    console.error(`[ERREUR] ${envVar} manquante.`); //[cite: 1]
    process.exit(1); //[cite: 1]
  }
}

// -----------------------------------------------------------------------------
// 2. MIDDLEWARES
// -----------------------------------------------------------------------------
app.use(helmet()); //[cite: 1]
app.use(cors({ origin: '*', methods: ['GET', 'POST'] })); //[cite: 1]
app.use(express.json({ limit: '10kb' })); //[cite: 1]

// Limite augmentée pour permettre la lecture "temps réel" de l'application (5s)
const limiter = rateLimit({ //[cite: 1]
  windowMs: 15 * 60 * 1000, //[cite: 1]
  max: 300, // Augmenté pour supporter 1 requête/5s (12/min * 15min = 180)[cite: 1]
  message: { error: 'Trop de requêtes.' } //[cite: 1]
});
app.use('/api/', limiter); //[cite: 1]

const authenticateApiKey = (req, res, next) => { //[cite: 1]
  if (process.env.API_KEY) { //[cite: 1]
    const apiKey = req.headers['x-api-key']; //[cite: 1]
    if (!apiKey || apiKey !== process.env.API_KEY) { //[cite: 1]
      return res.status(401).json({ error: 'Clé API invalide.' }); //[cite: 1]
    }
  }
  next(); //[cite: 1]
};

// -----------------------------------------------------------------------------
// 3. INITIALISATION
// -----------------------------------------------------------------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY); //[cite: 1]
let waterState = 0; // Pourcentage (0-100)[cite: 1]
let latestPressure = 0; // Pression brute en Bars[cite: 1]
let lastSaveTime = 0; // Pour limiter l'enregistrement Supabase à 1 min[cite: 1]

// -----------------------------------------------------------------------------
// 4. MQTT
// -----------------------------------------------------------------------------
let brokerUrl = process.env.MQTT_HOST; //[cite: 1]
if (!brokerUrl.startsWith('mqtts://') && !brokerUrl.startsWith('mqtt://')) { //[cite: 1]
  brokerUrl = `mqtts://${brokerUrl}:8883`; //[cite: 1]
}

const client = mqtt.connect(brokerUrl, { //[cite: 1]
  username: process.env.MQTT_USER, //[cite: 1]
  password: process.env.MQTT_PASS, //[cite: 1]
  rejectUnauthorized: true, //[cite: 1]
  reconnectPeriod: 5000 //[cite: 1]
});

client.on('connect', () => { //[cite: 1]
  console.log('✅ Connecté MQTT'); //[cite: 1]
  client.subscribe('oran/water/pressure'); //[cite: 1]
});

client.on('message', async (topic, message) => { //[cite: 1]
  const rawMsg = message.toString().trim(); //[cite: 1]
  try {
    const payload = JSON.parse(rawMsg); //[cite: 1]
    if (payload.pressure_bar !== undefined) { //[cite: 1]
      const pressure = parseFloat(payload.pressure_bar); //[cite: 1]
      if (isNaN(pressure)) return; //[cite: 1]

      // Mise à jour de l'état local INSTANTANÉE (toutes les 5s)
      latestPressure = pressure; //[cite: 1]
      const maxPressure = 2.0; // Aligné sur le dashboard Android (200 kPa)[cite: 1]
      waterState = Math.min(Math.max((pressure / maxPressure) * 100, 0), 100); //[cite: 1]
      console.log(`📡 Temps Réel -> Pression: ${pressure} Bar | ${waterState.toFixed(1)}%`); //[cite: 1]

      // ENREGISTREMENT SUPABASE LIMITÉ À 1 MINUTE
      const now = Date.now(); //[cite: 1]
      if (now - lastSaveTime >= 60000) { // 60 000 ms = 1 minute[cite: 1]
        lastSaveTime = now; //[cite: 1]
        const recordData = { //[cite: 1]
          sensor_id: payload.device_id || 'oran_001', //[cite: 1]
          pressure_bar: pressure, //[cite: 1]
          device_timestamp: payload.timestamp || new Date().toISOString() //[cite: 1]
        };

        const { error } = await supabase.from('water_pressure_logs').insert([recordData]); //[cite: 1]
        if (error) console.error('❌ Erreur DB:', error.message); //[cite: 1]
        else console.log('💾 Historique sauvegardé (1 min)'); //[cite: 1]
      }
    }
  } catch (e) { /* ignore */ } //[cite: 1]
});

// -----------------------------------------------------------------------------
// 5. ROUTES
// -----------------------------------------------------------------------------

// Route de Ping (Pour UptimeRobot / cron-job.org)
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

// Route de statut de l'application
app.get('/api/status', authenticateApiKey, (req, res) => { //[cite: 1]
  res.json({ //[cite: 1]
    pressure_bar: latestPressure, //[cite: 1]
    water: parseFloat(waterState.toFixed(1)), //[cite: 1]
    status: waterState > 0 ? 'present' : 'absent' //[cite: 1]
  });
});

app.listen(PORT, '0.0.0.0', () => { //[cite: 1]
  console.log(`🌐 Serveur sur port ${PORT}`); //[cite: 1]
});