require('dotenv').config();
const mqtt = require('mqtt');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// 1. VÉRIFICATION DES VARIABLES D'ENVIRONNEMENT CRITIQUES
// -----------------------------------------------------------------------------
const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'MQTT_HOST',
  'MQTT_USER',
  'MQTT_PASS'
];

for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.error(`[ERREUR CRITIQUE] La variable d'environnement ${envVar} est manquante.`);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 2. MIDDLEWARES DE SÉCURITÉ HTTP
// -----------------------------------------------------------------------------
// Protection des en-têtes HTTP
app.use(helmet());

// Configuration CORS (autorise l'accès client)
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST']
}));

// Limitation de taille du body pour éviter les DoS
app.use(express.json({ limit: '10kb' }));

// Limiteur de débit (Rate Limiting) sur les endpoints API
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // max 100 requêtes par 15 min par IP
  message: { error: 'Trop de requêtes, réessayez plus tard.' }
});
app.use('/api/', limiter);

// Middleware d'authentification par clé d'API facultatif pour sécuriser /api/status
const authenticateApiKey = (req, res, next) => {
  if (process.env.API_KEY) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Accès non autorisé : Clé API invalide.' });
    }
  }
  next();
};

// -----------------------------------------------------------------------------
// 3. INITIALISATION SUPABASE
// -----------------------------------------------------------------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -----------------------------------------------------------------------------
// 4. CONNEXION SÉCURISÉE MQTT (HiveMQ TLS)
// -----------------------------------------------------------------------------
let waterState = 0; // Niveau d'eau en %

// Formater le Broker Host si l'utilisateur spécifie seulement le domaine
let brokerUrl = process.env.MQTT_HOST;
if (!brokerUrl.startsWith('mqtts://') && !brokerUrl.startsWith('mqtt://')) {
  brokerUrl = `mqtts://${brokerUrl}:8883`;
}

const client = mqtt.connect(brokerUrl, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true, // TLS strict activé
  reconnectPeriod: 5000     // Reconnexion automatique
});

client.on('connect', () => {
  console.log('✅ Backend connecté en TLS à HiveMQ Cloud');
  client.subscribe('oran/water/pressure', (err) => {
    if (!err) {
      console.log('📡 Abonné avec succès au topic : oran/water/pressure');
    }
  });
});

client.on('message', async (topic, message) => {
  const rawMsg = message.toString().trim();
  console.log('📩 Message reçu sur topic :', topic);

  try {
    const payload = JSON.parse(rawMsg);

    if (payload.pressure_bar !== undefined) {
      const pressure = parseFloat(payload.pressure_bar);

      if (isNaN(pressure) || pressure < 0 || pressure > 20) {
        console.warn('⚠️ Valeur de pression invalide ignorée :', payload.pressure_bar);
        return;
      }

      // Conversion de la pression (0 à 3 bars) en pourcentage (0 à 100%)
      const maxPressure = 3.0;
      let calculatedPercent = (pressure / maxPressure) * 100;

      waterState = Math.min(Math.max(calculatedPercent, 0), 100);

      console.log(`📊 ESP8266 -> Pression: ${pressure} Bar | Niveau: ${waterState.toFixed(1)}%`);

      // Enregistrement dans Supabase
      const { error } = await supabase
        .from('water_pressure_logs')
        .insert([
          {
            sensor_id: payload.device_id || payload.sensor_id || 'oran_001',
            pressure_bar: pressure
          }
        ]);

      if (error) {
        console.error('❌ Erreur Supabase :', error.message);
      } else {
        console.log('✅ Donnée enregistrée dans Supabase !');
      }

    } else if (payload.water !== undefined) {
      const val = parseFloat(payload.water);
      if (!isNaN(val)) waterState = Math.min(Math.max(val, 0), 100);
    }
  } catch (e) {
    const val = parseFloat(rawMsg);
    if (!isNaN(val)) {
      waterState = Math.min(Math.max(val, 0), 100);
      console.log(`🧪 Test manuel -> Niveau défini à : ${waterState}%`);
    } else {
      console.warn('⚠️ Format de message non reconnu');
    }
  }
});

client.on('error', (err) => {
  console.error('❌ Erreur MQTT :', err.message);
});

// -----------------------------------------------------------------------------
// 5. API ROUTES
// -----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

app.get('/api/status', authenticateApiKey, (req, res) => {
  res.json({
    water: parseFloat(waterState.toFixed(1)),
    status: waterState > 0 ? 'present' : 'absent'
  });
});

// -----------------------------------------------------------------------------
// 6. LANCEMENT DU SERVEUR
// -----------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Serveur HTTP sécurisé accessible sur le port ${PORT}`);
});