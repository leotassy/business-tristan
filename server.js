import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const HOST = '0.0.0.0';

const PIN = process.env.AUCTION_PIN || '123456';
const ADMIN_PIN = process.env.AUCTION_ADMIN_PIN || '12345678';

const DEFAULT_STEPS = [
  { below: 101, buttons: [5, 10, 20], auto: 10 },
  { below: 200, buttons: [10, 20, 50], auto: 10 },
  { below: 300, buttons: [10, 20, 50], auto: 20 },
  { below: 500, buttons: [20, 50, 100], auto: 50 },
  { below: 1000, buttons: [50, 100, 200], auto: 50 },
  { below: 2000, buttons: [100, 200, 500], auto: 100 },
  { below: null, buttons: [100, 200, 500], auto: 200 },
];

function now() {
  return new Date().toISOString();
}

function loadInitialLots() {
  const lotsFile = path.join(__dirname, 'lots.json');
  if (fs.existsSync(lotsFile)) {
    const data = JSON.parse(fs.readFileSync(lotsFile, 'utf8'));
    return data.map((lot, index) => ({
      number: String(lot.number),
      title: String(lot.title),
      description: String(lot.description),
      position: index,
      price: 0,
      status: 'upcoming',
      leader: 'external',
      version: 0,
    }));
  }
  return [];
}

// In-memory data storage
let lots = loadInitialLots();
let orders = [];
let events = [];
let batches = new Map();
let archives = [];
let settings = {
  sale: {
    id: crypto.randomUUID(),
    title: 'Vente de démonstration',
    closed: false,
  },
  steps: JSON.parse(JSON.stringify(DEFAULT_STEPS)),
};

const clerkSessions = new Map();
const adminSessions = new Map();
const attempts = new Map();
const adminAttempts = new Map();

function amount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 99999999) {
    throw new Error('Montant entier attendu, entre 1 et 99 999 999 €.');
  }
  return value;
}

function suggestedStep(price) {
  for (const row of settings.steps) {
    if (row.below === null || price < row.below) {
      return row.auto;
    }
  }
  return 10;
}

function recommendation(lot, step = null) {
  if (lot.status === 'sold' || lot.status === 'passed' || !lot.price) {
    return { reason: 'Validez le prix initial du lot.' };
  }
  if (lot.leader !== 'external') {
    return { reason: 'Un ordre mène déjà. Attendez une nouvelle enchère de la salle ou du live.' };
  }
  const bidStep = step === null || step === undefined ? suggestedStep(lot.price) : amount(step);
  const eligible = orders
    .filter((o) => o.lot === lot.number && o.maximum > lot.price)
    .sort((a, b) => a.created.localeCompare(b.created));

  const distinctMaximums = new Set(eligible.map((o) => o.maximum));
  if (distinctMaximums.size > 1) {
    return { reason: 'Plusieurs ordres peuvent enchérir : arbitrage à valider avec le commissaire-priseur.' };
  }
  if (eligible.length === 0) {
    return { reason: 'Aucun ordre disponible au-dessus du prix actuel.' };
  }
  const order = eligible[0];
  const target = Math.min(lot.price + bidStep, order.maximum);
  return {
    amount: target,
    orderId: order.id,
    reference: order.id.slice(0, 8),
    step: bidStep,
    reason: 'Confirmez uniquement après annonce de l’enchère.',
  };
}

function state() {
  const result = [];
  const sortedLots = [...lots].sort((a, b) => a.position - b.position);
  for (const lot of sortedLots) {
    const lotOrders = orders.filter((o) => o.lot === lot.number);
    const lotEvents = events.filter((e) => e.lot === lot.number).sort((a, b) => b.id - a.id);
    const lastEvent = lotEvents[0];
    result.push({
      ...lot,
      orders: lotOrders.length,
      history: lotEvents.map((e) => ({ message: e.message, time: e.time })),
      canUndo: Boolean(lastEvent && lastEvent.reversible),
    });
  }
  return result;
}

function getPublic() {
  return {
    sale: settings.sale,
    steps: settings.steps,
  };
}

function snapshot() {
  return {
    ...getPublic(),
    lots: [...lots].sort((a, b) => a.position - b.position),
    orders: orders.map((o) => ({ ...o })),
    events: events.map((e) => ({ ...e })),
  };
}

function archive() {
  if (!settings.sale.closed) {
    const snap = snapshot();
    archives.unshift({
      id: settings.sale.id,
      title: settings.sale.title,
      closed: now(),
      payload: JSON.stringify({ ...snap, sale: { ...settings.sale, closed: true } }),
    });
    settings.sale = { ...settings.sale, closed: true };
  }
  return settings.sale;
}

function newSale(title) {
  if (!settings.sale.closed) {
    throw new Error('Clôturez et archivez la vente avant d’en créer une nouvelle.');
  }
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) {
    throw new Error('Nom de vente requis (120 caractères maximum).');
  }
  orders = [];
  events = [];
  for (const lot of lots) {
    lot.price = 0;
    lot.status = 'upcoming';
    lot.leader = 'external';
    lot.version += 1;
  }
  settings.sale = {
    id: crypto.randomUUID(),
    title: title.trim(),
    closed: false,
  };
}

function validateSteps(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20) {
    throw new Error('Entre 1 et 20 tranches sont nécessaires.');
  }
  let previous = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') throw new Error('Tranche invalide.');
    const bound = row.below;
    const buttons = row.buttons;
    const auto = row.auto;

    if (i === rows.length - 1) {
      if (bound !== null && bound !== undefined) {
        throw new Error('La dernière tranche doit être sans limite.');
      }
    } else {
      if (typeof bound !== 'number' || !Number.isInteger(bound) || bound <= previous || bound > 99999999) {
        throw new Error('Les seuils doivent être croissants.');
      }
    }
    if (bound !== null && bound !== undefined) previous = bound;

    if (
      !Array.isArray(buttons) ||
      buttons.length < 1 ||
      buttons.length > 5 ||
      buttons.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 99999999) ||
      new Set(buttons).size !== buttons.length
    ) {
      throw new Error('Chaque tranche demande 1 à 5 pas positifs distincts.');
    }
    if (typeof auto !== 'number' || !Number.isInteger(auto) || !buttons.includes(auto)) {
      throw new Error('Le pas automatique doit figurer dans les boutons.');
    }
  }
  return rows;
}

function checkRateLimit(map, ip) {
  const record = map.get(ip) || { count: 0, until: 0 };
  const currentTime = Date.now();
  if (record.until > currentTime) {
    return false;
  }
  return true;
}

function recordFailure(map, ip) {
  const currentTime = Date.now();
  const record = map.get(ip) || { count: 0, until: 0 };
  const count = record.until > currentTime ? record.count + 1 : 1;
  const until = count >= 5 ? currentTime + 60000 : 0;
  map.set(ip, { count, until });
}

function recordSuccess(map, ip) {
  map.delete(ip);
}

function isClerkAuthenticated(req) {
  const queryToken = req.query?.token;
  if (queryToken && typeof queryToken === 'string') {
    const expiry = clerkSessions.get(queryToken);
    if (expiry && expiry > Date.now()) return true;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const expiry = clerkSessions.get(token);
    if (expiry && expiry > Date.now()) return true;
  }
  const token = req.cookies?.clerk;
  if (!token) return false;
  const expiry = clerkSessions.get(token);
  return expiry && expiry > Date.now();
}

function isAdminAuthenticated(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const expiry = adminSessions.get(token);
    if (expiry && expiry > Date.now()) return true;
  }
  const token = req.cookies?.admin;
  if (!token) return false;
  const expiry = adminSessions.get(token);
  return expiry && expiry > Date.now();
}

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// Security & headers middleware
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// GET /api/catalog
app.get('/api/catalog', (req, res) => {
  const sorted = [...lots].sort((a, b) => a.position - b.position);
  res.json({
    ...getPublic(),
    lots: sorted.map((x) => ({
      number: x.number,
      title: x.title,
      description: x.description,
      status: x.status,
    })),
  });
});

// GET /api/lots
app.get('/api/lots', (req, res) => {
  const sorted = [...lots].sort((a, b) => a.position - b.position);
  res.json(
    sorted.map((x) => ({
      number: x.number,
      title: x.title,
      description: x.description,
      status: x.status,
    }))
  );
});

// GET /api/state
app.get('/api/state', (req, res) => {
  if (!isClerkAuthenticated(req)) {
    return res.status(401).json({ error: 'Connectez-vous à la console secrétaire.' });
  }
  res.json({
    lots: state(),
    ...getPublic(),
  });
});

// GET /api/admin/current
app.get('/api/admin/current', (req, res) => {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Connexion administrateur requise.' });
  }
  res.json(snapshot());
});

// GET /api/admin/archives
app.get('/api/admin/archives', (req, res) => {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Connexion administrateur requise.' });
  }
  res.json(
    archives.map((r) => ({
      id: r.id,
      title: r.title,
      closed: r.closed,
    }))
  );
});

// GET /api/admin/archive/:id
app.get('/api/admin/archive/:id', (req, res) => {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Connexion administrateur requise.' });
  }
  const id = req.params.id;
  const found = archives.find((a) => a.id === id);
  if (!found) {
    return res.status(404).json({ error: 'Archive introuvable.' });
  }
  res.json(JSON.parse(found.payload));
});

// POST /api/login
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(attempts, ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une minute.' });
  }
  const submittedPin = String(req.body?.pin || '');
  if (submittedPin !== PIN) {
    recordFailure(attempts, ip);
    return res.status(403).json({ error: 'Code incorrect.' });
  }
  recordSuccess(attempts, ip);
  const token = crypto.randomBytes(32).toString('hex');
  clerkSessions.set(token, Date.now() + 43200 * 1000);
  res.cookie('clerk', token, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: 43200 * 1000,
  });
  res.json({ ok: true, token });
});

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(adminAttempts, ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une minute.' });
  }
  const submittedCode = String(req.body?.admin_code || '');
  if (submittedCode !== ADMIN_PIN) {
    recordFailure(adminAttempts, ip);
    return res.status(403).json({ error: 'Code administrateur requis ou incorrect.' });
  }
  recordSuccess(adminAttempts, ip);
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + 1800 * 1000);
  res.cookie('admin', token, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: 1800 * 1000,
  });
  res.json({ ok: true, token });
});

// POST /api/admin/logout
app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies?.admin;
  if (token) adminSessions.delete(token);
  res.cookie('admin', '', {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  res.json({ ok: true });
});

// POST /api/batch
app.post('/api/batch', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(adminAttempts, ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une minute.' });
  }
  const code = req.body?.admin_code;
  if (typeof code !== 'string' || code !== ADMIN_PIN) {
    recordFailure(adminAttempts, ip);
    return res.status(403).json({ error: 'Code administrateur requis ou incorrect.' });
  }
  recordSuccess(adminAttempts, ip);

  if (req.body?.deposit_confirmed !== true) {
    return res.status(400).json({ error: 'L’administrateur doit confirmer la vérification de la caution en personne.' });
  }

  const data = req.body;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!data?.id || !uuidRegex.test(data.id)) {
    return res.status(400).json({ error: 'Identifiant invalide.' });
  }
  const key = data.id.toLowerCase();
  const payload = { ...data };
  delete payload.admin_code;
  delete payload.deposit_confirmed;
  const sortedPayloadStr = JSON.stringify(payload, Object.keys(payload).sort());

  const old = batches.get(key);
  if (old) {
    if (old.payload !== sortedPayloadStr) {
      return res.status(400).json({ error: 'Identifiant déjà utilisé : recommencez après vérification.' });
    }
    return res.status(200).json(old.result);
  }

  if (settings.sale.closed || data.sale_id !== settings.sale.id) {
    return res.status(400).json({ error: 'La vente a changé ou est clôturée. Recommencez votre dépôt.' });
  }

  const contact = {};
  const limits = { name: 60, last_name: 80, phone: 40, email: 254 };
  for (const [field, limit] of Object.entries(limits)) {
    const value = data[field];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
      return res.status(400).json({ error: 'Coordonnées incomplètes ou trop longues.' });
    }
    contact[field] = value.trim();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (!/^\+[0-9]{7,15}$/.test(contact.phone)) {
    return res.status(400).json({ error: 'Téléphone international invalide.' });
  }

  const address = data.address_details;
  if (!address || typeof address !== 'object') {
    return res.status(400).json({ error: 'Adresse requise.' });
  }
  const clean = {};
  const addressLimits = { street: 160, extra: 160, postal: 30, city: 100, country: 80 };
  for (const [field, limit] of Object.entries(addressLimits)) {
    const v = address[field] || '';
    if (typeof v !== 'string' || v.trim().length > limit || (['street', 'city', 'country'].includes(field) && !v.trim())) {
      return res.status(400).json({ error: 'Adresse incomplète ou trop longue.' });
    }
    clean[field] = v.trim();
  }

  const items = data.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    return res.status(400).json({ error: 'Choisissez entre 1 et 100 lots.' });
  }

  const seen = new Set();
  const created = now();
  const resultOrders = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      return res.status(400).json({ error: 'Ordre invalide.' });
    }
    const number = item.lot;
    const max = item.maximum;
    if (typeof number !== 'string' || seen.has(number)) {
      return res.status(400).json({ error: 'Un seul ordre par lot dans ce dépôt.' });
    }
    seen.add(number);
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 99999999) {
      return res.status(400).json({ error: 'Plafond entier positif requis.' });
    }
    const lot = lots.find((l) => l.number === number);
    if (!lot || ['sold', 'passed'].includes(lot.status) || max <= lot.price) {
      return res.status(400).json({ error: `Lot ${number} indisponible ou plafond dépassé. Modifiez votre sélection.` });
    }
  }

  // All items validated, perform insertions
  for (const item of items) {
    const oid = crypto.randomUUID();
    orders.push({
      id: oid,
      lot: item.lot,
      name: contact.name,
      maximum: item.maximum,
      created,
      last_name: contact.last_name,
      phone: contact.phone,
      email: contact.email,
      address: Object.values(clean).filter(Boolean).join(', '),
      approved_at: created,
      batch_id: key,
      address_details: JSON.stringify(clean),
    });
    resultOrders.push({ id: oid, lot: item.lot });
  }

  const receipt = {
    id: key,
    sale_id: settings.sale.id,
    created,
    orders: resultOrders,
  };
  batches.set(key, {
    id: key,
    sale_id: settings.sale.id,
    payload: sortedPayloadStr,
    result: receipt,
  });
  res.status(201).json(receipt);
});

// POST /api/orders
app.post('/api/orders', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(adminAttempts, ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une minute.' });
  }
  const code = req.body?.admin_code;
  if (typeof code !== 'string' || code !== ADMIN_PIN) {
    recordFailure(adminAttempts, ip);
    return res.status(403).json({ error: 'Code administrateur requis ou incorrect.' });
  }
  recordSuccess(adminAttempts, ip);

  if (req.body?.deposit_confirmed !== true) {
    return res.status(400).json({ error: 'L’administrateur doit confirmer la vérification de la caution en personne.' });
  }

  const data = req.body;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!data?.id || !uuidRegex.test(data.id)) {
    return res.status(400).json({ error: 'Identifiant invalide.' });
  }
  const key = data.id;
  const name = data.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
    return res.status(400).json({ error: 'Prénom requis (60 caractères maximum).' });
  }

  const contact = {};
  for (const [field, limit] of [
    ['last_name', 80],
    ['phone', 40],
    ['email', 254],
    ['address', 500],
  ]) {
    const value = data[field];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
      return res.status(400).json({
        error: 'Nom, téléphone, email et adresse sont obligatoires et doivent respecter les longueurs maximales.',
      });
    }
    contact[field] = value.trim();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  const phone = contact.phone;
  const digits = phone.replace(/\D/g, '');
  if (!/^[+0-9 ().-]+$/.test(phone) || digits.length < 7 || digits.length > 15) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  }

  let max;
  try {
    max = amount(data.maximum);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const number = data.lot;
  const previous = orders.find((o) => o.id === key);
  if (previous) {
    if (
      previous.lot !== number ||
      previous.name !== name.trim() ||
      previous.maximum !== max ||
      Object.keys(contact).some((k) => previous[k] !== contact[k])
    ) {
      return res.status(400).json({ error: 'Identifiant déjà utilisé pour un autre ordre.' });
    }
    return res.status(200).json({ id: key, created: previous.created });
  }

  if (settings.sale.closed) {
    return res.status(400).json({ error: 'Vente clôturée. Créez une nouvelle vente dans l’espace administrateur.' });
  }

  const lot = lots.find((l) => l.number === number);
  if (!lot || ['sold', 'passed'].includes(lot.status)) {
    return res.status(400).json({ error: 'Ce lot n’accepte plus d’ordres.' });
  }
  if (max <= lot.price) {
    return res.status(400).json({ error: 'Le plafond doit dépasser le prix actuel.' });
  }

  const created = now();
  orders.push({
    id: key,
    lot: number,
    name: name.trim(),
    maximum: max,
    created,
    last_name: contact.last_name,
    phone: contact.phone,
    email: contact.email,
    address: contact.address,
    approved_at: created,
    batch_id: '',
    address_details: '',
  });

  res.status(201).json({ id: key, created });
});

// POST /api/recommend
app.post('/api/recommend', (req, res) => {
  if (!isClerkAuthenticated(req)) {
    return res.status(401).json({ error: 'Session secrétaire expirée. Reconnectez-vous.' });
  }
  const lot = lots.find((l) => l.number === req.body?.lot);
  if (!lot) {
    return res.status(400).json({ error: 'Lot introuvable.' });
  }
  res.json(recommendation(lot, req.body?.step));
});

// POST /api/action
app.post('/api/action', (req, res) => {
  if (!isClerkAuthenticated(req)) {
    return res.status(401).json({ error: 'Session secrétaire expirée. Reconnectez-vous.' });
  }
  if (settings.sale.closed) {
    return res.status(400).json({ error: 'Vente clôturée. Créez une nouvelle vente dans l’espace administrateur.' });
  }
  const lot = lots.find((l) => l.number === req.body?.lot);
  if (!lot) {
    return res.status(400).json({ error: 'Lot introuvable.' });
  }
  if (req.body?.version !== lot.version) {
    return res.status(409).json({ error: 'Ce lot a changé. Vérifiez le nouveau prix avant de recommencer.' });
  }

  const action = req.body?.action;
  let price = lot.price;
  let status = lot.status;
  let leader = lot.leader;
  const before = JSON.stringify(lot);
  let reversible = 1;
  let message = '';

  try {
    if (action === 'undo') {
      const lotEvents = events.filter((e) => e.lot === lot.number).sort((a, b) => b.id - a.id);
      const lastEvent = lotEvents[0];
      if (!lastEvent || !lastEvent.reversible) {
        throw new Error('Aucune action à corriger.');
      }
      const old = JSON.parse(lastEvent.before_state);
      price = old.price;
      status = old.status;
      leader = old.leader;
      message = 'Correction : annulation de « ' + lastEvent.message + ' »';
      reversible = 0;
    } else {
      if (status === 'sold' || status === 'passed') {
        throw new Error('Lot clôturé.');
      }
      if (action === 'price') {
        price = amount(req.body?.price);
        status = 'active';
        leader = 'external';
        message = `Prix salle / live : ${price} €`;
      } else if (action === 'defend') {
        const proposal = recommendation(lot, req.body?.step);
        if (
          !proposal.amount ||
          proposal.amount !== req.body?.expectedAmount ||
          proposal.orderId !== req.body?.orderId
        ) {
          throw new Error('Proposition modifiée. Vérifiez les ordres et réessayez.');
        }
        price = proposal.amount;
        leader = proposal.orderId;
        status = 'active';
        message = `Ordre anonyme ${proposal.reference} défendu à ${price} €`;
      } else if (action === 'sold' || action === 'passed') {
        if (action === 'sold' && price <= 0) {
          throw new Error('Validez un prix avant l’adjudication.');
        }
        status = action;
        message = action === 'sold' ? `Adjugé à ${price} €` : 'Lot passé';
      } else {
        throw new Error('Action inconnue.');
      }
    }

    lot.price = price;
    lot.status = status;
    lot.leader = leader;
    lot.version += 1;
    events.push({
      id: events.length + 1,
      lot: lot.number,
      message,
      time: now(),
      before_state: before,
      reversible,
    });

    res.json({ lots: state(), ...getPublic() });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Données invalides.' });
  }
});

// POST /api/admin/close
app.post('/api/admin/close', (req, res) => {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Connexion administrateur requise.' });
  }
  if (req.body?.sale_id !== settings.sale.id) {
    return res.status(400).json({ error: 'La vente a changé. Rechargez la page.' });
  }
  archive();
  res.json(getPublic());
});

// POST /api/admin/new
app.post('/api/admin/new', (req, res) => {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Connexion administrateur requise.' });
  }
  if (req.body?.sale_id !== settings.sale.id) {
    return res.status(400).json({ error: 'La vente a changé. Rechargez la page.' });
  }
  try {
    newSale(req.body?.title);
    res.json(getPublic());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/admin/steps
app.post('/api/admin/steps', (req, res) => {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Connexion administrateur requise.' });
  }
  if (req.body?.sale_id !== settings.sale.id) {
    return res.status(400).json({ error: 'La vente a changé. Rechargez la page.' });
  }
  if (settings.sale.closed) {
    return res.status(400).json({ error: 'Créez une nouvelle vente avant de modifier les pas.' });
  }
  try {
    const valid = validateSteps(req.body?.steps);
    settings.steps = valid;
    res.json(getPublic());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/reset
app.post('/api/reset', (req, res) => {
  if (!isClerkAuthenticated(req)) {
    return res.status(401).json({ error: 'Session secrétaire expirée. Reconnectez-vous.' });
  }
  if (req.body?.confirm !== 'RESET') {
    return res.status(400).json({ error: 'Confirmation de réinitialisation requise.' });
  }
  archive();
  newSale('Vente de démonstration');
  orders = [];
  events = [];
  res.json({ lots: state(), ...getPublic() });
});

// Page routes
app.get('/connexion', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get(['/acheteur', '/buyer.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'buyer.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get(['/', '/index.html'], (req, res) => {
  if (isClerkAuthenticated(req)) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'login.html'));
  }
});

// Static assets
app.use(express.static(__dirname));

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ error: 'Page introuvable.' });
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

let server = null;
if (isMainModule) {
  server = app.listen(PORT, HOST, () => {
    console.log(`Serveur démarré sur http://${HOST}:${PORT}`);
    console.log(`Console secrétaire : http://127.0.0.1:${PORT}/`);
    console.log(`Page acheteur : http://127.0.0.1:${PORT}/acheteur`);
    console.log(`Page administration : http://127.0.0.1:${PORT}/admin`);
    console.log(`Code secrétaire : ${PIN}`);
    console.log(`Code administrateur : ${ADMIN_PIN}`);
  });
}

export { app, server, lots, settings, orders, events, clerkSessions, adminSessions, PIN, ADMIN_PIN };
