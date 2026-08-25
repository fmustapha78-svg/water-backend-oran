require('dotenv').config();
const mqtt = require('mqtt');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration pour le reverse proxy Render
app.set('trust proxy', 1);

// -----------------------------------------------------------------------------
// 1. VÉRIFICATION DES VARIABLES D'ENVIRONNEMENT
// -----------------------------------------------------------------------------
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_KEY', 'MQTT_HOST', 'MQTT_USER', 'MQTT_PASS'];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.error(`[ERREUR] ${envVar} manquante.`);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 2. MIDDLEWARES
// -----------------------------------------------------------------------------
app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10kb' }));

// Limite augmentée pour permettre la lecture "temps réel" de l'application (5s)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // Augmenté pour supporter 1 requête/5s (12/min * 15min = 180)
  message: { error: 'Trop de requêtes.' }
});
app.use('/api/', limiter);

const authenticateApiKey = (req, res, next) => {
  if (process.env.API_KEY) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Clé API invalide.' });
    }
  }
  next();
};

// -----------------------------------------------------------------------------
// 3. INITIALISATION
// -----------------------------------------------------------------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let waterState = 0; // Pourcentage (0-100)
let latestPressure = 0; // Pression brute en Bars
let lastSaveTime = 0; // Pour limiter l'enregistrement Supabase à 1 min
let lastSeen = 0; // Timestamp du dernier message reçu

// -----------------------------------------------------------------------------
// 4. MQTT
// -----------------------------------------------------------------------------
let brokerUrl = process.env.MQTT_HOST;
if (!brokerUrl.startsWith('mqtts://') && !brokerUrl.startsWith('mqtt://')) {
  brokerUrl = `mqtts://${brokerUrl}:8883`;
}

const client = mqtt.connect(brokerUrl, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  reconnectPeriod: 5000
});

client.on('connect', () => {
  console.log('✅ Connecté MQTT');
  client.subscribe('oran/water/pressure');
});

client.on('message', async (topic, message) => {
  const rawMsg = message.toString().trim();
  try {
    const payload = JSON.parse(rawMsg);
    if (payload.pressure_bar !== undefined) {
      lastSeen = Date.now(); // On met à jour l'activité
      const pressure = parseFloat(payload.pressure_bar);
      if (isNaN(pressure)) return;

      // Mise à jour de l'état local INSTANTANÉE (toutes les 5s)
      latestPressure = pressure;
      const maxPressure = 4.0; // Mis à jour pour supporter 4.0 Bar
      waterState = Math.min(Math.max((pressure / maxPressure) * 100, 0), 100);
      console.log(`📡 Temps Réel -> Pression: ${pressure} Bar | ${waterState.toFixed(1)}%`);

      // ENREGISTREMENT SUPABASE LIMITÉ À 1 MINUTE
      const now = Date.now();
      if (now - lastSaveTime >= 60000) { // 60 000 ms = 1 minute
        lastSaveTime = now;
        // Générer un timestamp local (UTC+1) si l'ESP8266 ne l'envoie pas
        const getLocalTimestamp = () => {
          const now = new Date();
          // Ajustement pour UTC+1 (60 minutes)
          const localDate = new Date(now.getTime() + (60 * 60 * 1000));
          return localDate.toISOString().replace('T', ' ').substring(0, 19);
        };

        const recordData = {
          sensor_id: payload.device_id || 'oran_001',
          pressure_bar: pressure,
          device_timestamp: payload.timestamp || getLocalTimestamp()
        };

        const { error } = await supabase.from('water_pressure_logs').insert([recordData]);
        if (error) console.error('❌ Erreur DB:', error.message);
        else console.log('💾 Historique sauvegardé (1 min)');
      }
    }
  } catch (e) { /* ignore */ }
});

// -----------------------------------------------------------------------------
// 5. ROUTES
// -----------------------------------------------------------------------------

// Route de Ping (Pour UptimeRobot / cron-job.org)
app.get('/ping', (req, res) => {
  console.log(`[PING] Requête UptimeRobot reçue à ${new Date().toISOString()}`);
  res.status(200).send('OK');
});

// Route de statut de l'application
app.get('/api/status', authenticateApiKey, (req, res) => {
  const isOnline = (Date.now() - lastSeen) < 20000; // Hors ligne après 20s sans données
  res.json({
    pressure_bar: isOnline ? latestPressure : 0,
    water: isOnline ? parseFloat(waterState.toFixed(1)) : 0,
    status: isOnline ? 'online' : 'offline'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Serveur sur port ${PORT}`);
});