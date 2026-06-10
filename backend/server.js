'use strict';

// ============================================================
// visualGPS - Backend NMEA -> WebSocket
// ============================================================
// Role : lire en continu les trames NMEA 0183 emises par un
// recepteur GPS sur un port serie, les analyser, et diffuser
// l'etat courant (position, satellites, qualite du fix...) en
// temps reel a tous les navigateurs connectes via WebSocket.
//
// Choix d'architecture : pas de gpsd. On parle directement au
// port serie avec la lib `serialport`. Plus simple a deboguer et
// sans dependance systeme pour un recepteur unique.
//
// Point cle : l'etat diffuse est reconstruit par CYCLE NMEA
// COMPLET (technique du double buffer). Un recepteur emet a 1 Hz
// une rafale de trames (GGA, GSA, GSV, RMC...) qui decrivent
// ensemble UN instant. On parse cette rafale dans un objet
// temporaire `cycle`, et on ne la bascule dans l'etat diffuse
// `state` qu'a la frontiere de cycle (l'arrivee de la trame GGA
// suivante). Consequences :
//   - on ne diffuse jamais un cycle a moitie rempli ;
//   - le set de satellites est repeuple a neuf a chaque cycle,
//     donc pas de satellites "fantomes" qui resteraient affiches ;
//   - le nombre de satellites en vue est le total reel, toutes
//     constellations confondues (et non le compte de la derniere
//     constellation recue).
// ============================================================

// ---- Configuration via variables d'environnement -----------
// (definies dans l'unit systemd ; valeurs par defaut sinon)
const SERIAL_PORT = process.env.GPS_DEVICE   || '/dev/ttyUSB0';        // device serie du GPS
const SERIAL_BAUD = parseInt(process.env.GPS_BAUD || '9600', 10);      // debit serie (9600 par defaut sur la plupart des recepteurs)
const WS_PORT     = parseInt(process.env.GPS_WS_PORT || '8765', 10);   // port d'ecoute du serveur WebSocket
// Par defaut on ecoute sur toutes les interfaces (0.0.0.0), pour que le
// dashboard soit accessible depuis le LAN (cas usuel : machine headless
// consultee a distance). Pour restreindre a la boucle locale, mettre
// GPS_WS_HOST=127.0.0.1 (voir README, section Installation).
const WS_HOST     = process.env.GPS_WS_HOST  || '0.0.0.0';             // interface d'ecoute du WebSocket

// ---- Constantes de fonctionnement --------------------------
const RECONNECT_MS = 5000;   // delai avant retry d'ouverture du port serie
const BROADCAST_MS = 1000;   // periode de diffusion de l'etat aux clients (1 Hz)
const STALE_MS     = 5000;   // au-dela, le flux GPS est considere perdu
const NMEA_BUF_MAX = 200;    // trames brutes gardees pour les nouveaux clients
const HISTORY_MAX  = 14400;  // 4h a 1Hz

// ---- Dependances npm ---------------------------------------
const { SerialPort }      = require('serialport');                 // acces port serie
const { ReadlineParser }  = require('@serialport/parser-readline'); // decoupe le flux serie en lignes
const { WebSocketServer } = require('ws');                          // serveur WebSocket

// ============================================================
// Etat diffuse : reflet du DERNIER cycle NMEA complet
// ============================================================
// C'est cette structure qui est serialisee et envoyee aux clients.
// Elle n'est mise a jour qu'en bloc, dans commitCycle().
const state = {
  fixMode:     1,      // 1=pas de fix, 2=fix 2D, 3=fix 3D (depuis GSA)
  fixQuality:  0,      // indicateur de qualite GGA (0=invalide, 1=GPS, 2=DGPS...)
  fixValid:    false,  // statut RMC (A=valide, V=void)
  latitude:    null,   // degres decimaux (signe : S/W negatifs)
  longitude:   null,   // degres decimaux
  altitude:    null,   // metres (au-dessus du geoide)
  speed:       null,   // vitesse sol en km/h
  course:      null,   // route sur le fond en degres
  pdop:        null,   // dilution de precision : position
  hdop:        null,   // dilution de precision : horizontale
  vdop:        null,   // dilution de precision : verticale
  satsTracked: 0,      // satellites utilises dans le calcul (champ GGA)
  satsInView:  0,      // satellites en vue, total toutes constellations
  utcTime:     null,   // "HH:MM:SS"
  utcDate:     null,   // "AAAA-MM-JJ"
  satellites:  [],   // tableau fige du dernier cycle
};

// Historique des positions 3D (nouveaux clients + Position Plot)
// Stocke en colonnes paralleles (plus compact a serialiser que des objets).
const history = {
  timestamps: [],
  latitudes:  [],
  longitudes: [],
  altitudes:  [],
};

// Buffer des dernieres trames brutes (pour les nouveaux clients)
const nmeaBuffer = [];
// Trames accumulees depuis le dernier broadcast
let nmeaPending = [];
// Horodatage de la derniere trame valide recue (detection staleness)
let lastNmeaTs = 0;

// ============================================================
// Cycle courant en construction (double buffer)
// ============================================================
// freshCycle() fabrique un objet vierge pour accumuler les trames
// d'UN cycle NMEA. On y ecrit pendant tout le cycle, puis on le
// bascule dans `state` via commitCycle() et on repart d'un cycle neuf.
function freshCycle() {
  return {
    fixMode:     1,
    fixQuality:  0,
    fixValid:    false,
    latitude:    null,
    longitude:   null,
    altitude:    null,
    speed:       null,
    course:      null,
    pdop:        null,
    hdop:        null,
    vdop:        null,
    satsTracked: 0,
    utcTime:     null,
    utcDate:     null,
    satellites:  {},          // indexes par system_prn, ce cycle uniquement
    activePRNs:  new Set(),   // PRNs listes dans les GSA de ce cycle
  };
}

let cycle = freshCycle();

// ============================================================
// Utilitaires NMEA
// ============================================================

// Verifie le checksum d'une trame NMEA. Le checksum est le XOR de
// tous les octets entre '$' et '*', exprime en hexa sur 2 chiffres
// apres l'etoile. On rejette toute trame dont le checksum est faux.
function checksumValid(sentence) {
  const star = sentence.lastIndexOf('*');
  if (star < 0) return false;                                   // pas d'etoile -> trame incomplete
  const body = sentence.slice(1, star);                         // contenu entre '$' et '*'
  const expected = sentence.slice(star + 1, star + 3).toUpperCase(); // les 2 chiffres hexa attendus
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i); // XOR cumulatif
  return cs.toString(16).toUpperCase().padStart(2, '0') === expected;
}

// Convertit une coordonnee NMEA (format ddmm.mmmm / dddmm.mmmm)
// en degres decimaux signes. `hemi` est N/S/E/W ; S et W -> negatif.
// Les minutes occupent toujours les 2 chiffres avant le point decimal.
function nmeaToDeg(raw, hemi) {
  if (!raw || raw.length === 0) return null;
  const dot = raw.indexOf('.');
  if (dot < 2) return null;                          // format inattendu
  const deg = parseFloat(raw.slice(0, dot - 2));     // partie degres
  const min = parseFloat(raw.slice(dot - 2));        // partie minutes (mm.mmmm)
  if (Number.isNaN(deg) || Number.isNaN(min)) return null;
  let val = deg + min / 60;                           // degres + minutes/60
  if (hemi === 'S' || hemi === 'W') val = -val;       // hemisphere sud/ouest -> negatif
  return parseFloat(val.toFixed(8));                  // 8 decimales : ~1mm de resolution
}

// Traduit le prefixe de talker NMEA (les 2 lettres apres '$') en
// nom de constellation lisible.
function systemFromPrefix(prefix) {
  switch (prefix) {
    case 'GP': return 'GPS';
    case 'GL': return 'GLONASS';
    case 'GA': return 'Galileo';
    case 'GB': return 'BeiDou';
    case 'GN': return 'GNSS';     // trame combinee multi-constellations
    default:   return 'Unknown';
  }
}

// parseFloat tolerant : '' / undefined / NaN -> null
// Evite de propager des NaN dans l'etat quand un champ est vide.
function num(field) {
  if (field === undefined || field === '') return null;
  const v = parseFloat(field);
  return Number.isNaN(v) ? null : v;
}

// ============================================================
// Parsers NMEA -> ecrivent dans `cycle`
// ============================================================
// Chaque parser ecrit dans l'objet `cycle` (et JAMAIS dans `state`
// directement). C'est commitCycle() qui publiera l'ensemble.

// GGA : Global Positioning System Fix Data (position + altitude).
// Champs : [1]=heure UTC, [2]=lat, [3]=N/S, [4]=lon, [5]=E/W,
// [6]=qualite, [7]=nb sats utilises, [8]=HDOP, [9]=altitude.
function parseGGA(fields) {
  const quality = parseInt(fields[6], 10);
  cycle.fixQuality = Number.isNaN(quality) ? 0 : quality;
  if (cycle.fixQuality > 0) {                          // position exploitable seulement si qualite > 0
    cycle.latitude    = nmeaToDeg(fields[2], fields[3]);
    cycle.longitude   = nmeaToDeg(fields[4], fields[5]);
    cycle.altitude    = num(fields[9]);
    cycle.hdop        = num(fields[8]);
    const used        = parseInt(fields[7], 10);
    cycle.satsTracked = Number.isNaN(used) ? 0 : used;
  }
  const t = fields[1];                                 // heure UTC "hhmmss.sss"
  if (t && t.length >= 6) {
    cycle.utcTime = t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6);
  }
}

// RMC : Recommended Minimum (position, vitesse, cap, date).
// Champs : [1]=heure, [2]=statut (A/V), [3]=lat, [4]=N/S, [5]=lon,
// [6]=E/W, [7]=vitesse sol (noeuds), [8]=cap, [9]=date "jjmmaa".
function parseRMC(fields) {
  cycle.fixValid = (fields[2] === 'A');                // A=actif/valide, V=void
  if (cycle.fixValid) {
    cycle.latitude  = nmeaToDeg(fields[3], fields[4]);
    cycle.longitude = nmeaToDeg(fields[5], fields[6]);
    const sog = num(fields[7]);                 // vitesse sol en noeuds
    cycle.speed  = sog === null ? null : parseFloat((sog * 1.852).toFixed(2)); // noeuds -> km/h
    cycle.course = num(fields[8]);
  }
  const t = fields[1];
  if (t && t.length >= 6) {
    cycle.utcTime = t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6);
  }
  const d = fields[9];                                 // date "jjmmaa"
  if (d && d.length === 6) {
    cycle.utcDate = '20' + d.slice(4, 6) + '-' + d.slice(2, 4) + '-' + d.slice(0, 2); // -> "AAAA-MM-JJ"
  }
}

// GSA : DOP et satellites actifs.
// Champs : [2]=mode fix (1/2/3), [3..14]=12 slots de PRN utilises,
// [15]=PDOP, [16]=HDOP, [17]=VDOP.
function parseGSA(fields) {
  const mode = parseInt(fields[2], 10);         // 1=no fix, 2=2D, 3=3D
  // En multi-constellations il y a plusieurs GSA par cycle ; on garde
  // le mode le plus eleve rencontre (un 3D quelque part = fix 3D).
  if (!Number.isNaN(mode) && mode > cycle.fixMode) cycle.fixMode = mode;

  for (let i = 3; i <= 14; i++) {               // 12 slots de PRN
    if (fields[i] && fields[i] !== '') cycle.activePRNs.add(fields[i].trim());
  }

  const pdop = num(fields[15]);
  const hdop = num(fields[16]);
  const vdop = num(fields[17]);
  if (pdop !== null) cycle.pdop = pdop;
  if (hdop !== null) cycle.hdop = hdop;
  if (vdop !== null) cycle.vdop = vdop;
}

// GSV : Satellites in View (positions des satellites).
// Apres l'index 4, blocs repetes de 4 champs : PRN, elevation,
// azimut, SNR. Plusieurs trames GSV par constellation et par cycle.
function parseGSV(fields, prefix) {
  const system = systemFromPrefix(prefix);
  // Blocs de 4 champs (prn, elevation, azimut, snr) a partir de l'index 4
  for (let i = 4; i + 2 < fields.length; i += 4) {
    const prn = fields[i] ? fields[i].trim() : '';
    if (!prn) continue;
    const snr = parseInt(fields[i + 3], 10);
    // Cle "systeme_prn" : evite les collisions entre constellations
    // qui peuvent reutiliser les memes numeros de PRN.
    cycle.satellites[system + '_' + prn] = {
      prn,
      system,
      elevation: parseInt(fields[i + 1], 10) || 0,
      azimuth:   parseInt(fields[i + 2], 10) || 0,
      snr:       Number.isNaN(snr) ? 0 : snr,
      tracked:   false,                          // calcule au commit
    };
  }
}

// ============================================================
// Commit du cycle -> etat diffuse (atomique, frontiere GGA)
// ============================================================
// Bascule en une fois tout le contenu de `cycle` dans `state`.
// C'est le seul endroit qui ecrit dans `state`, ce qui garantit
// qu'un client ne voit jamais un cycle partiellement parse.
function commitCycle() {
  const sats = Object.values(cycle.satellites);
  // Flag "tracked" finalise ici : independant de l'ordre des trames
  // (les GSV ont pu arriver avant les GSA, ou inversement).
  for (const sat of sats) sat.tracked = cycle.activePRNs.has(sat.prn);

  state.fixMode     = cycle.fixMode;
  state.fixQuality  = cycle.fixQuality;
  state.fixValid    = cycle.fixValid;
  state.latitude    = cycle.latitude;
  state.longitude   = cycle.longitude;
  state.altitude    = cycle.altitude;
  state.speed       = cycle.speed;
  state.course      = cycle.course;
  state.pdop        = cycle.pdop;
  state.hdop        = cycle.hdop;
  state.vdop        = cycle.vdop;
  state.utcTime     = cycle.utcTime;
  state.utcDate     = cycle.utcDate;
  state.satsTracked = cycle.satsTracked;
  // Le GSV n'arrive PAS a chaque cycle : sur les puces MT3333 (modules
  // Adafruit), la position sort a 1Hz mais les GSV tous les 5 fixes
  // (~ toutes les 5s). On ne remplace donc le set de satellites QUE si ce
  // cycle a apporte des GSV ; sinon on conserve le dernier set connu, faute
  // de quoi la vue se viderait 4 cycles sur 5. L'anti-fantome reste assure :
  // a chaque rafale GSV le set est reconstruit a neuf, donc un satellite qui
  // decroche finit par disparaitre.
  if (sats.length > 0) {
    state.satsInView = sats.length;    // total reel toutes constellations
    state.satellites = sats;           // remplacement complet -> pas de fantomes
  }

  // On n'archive une position que si elle correspond a un vrai fix 3D.
  if (state.fixMode === 3 && state.latitude !== null) pushHistory();
}

// Ajoute la position courante a l'historique et borne ce dernier a
// HISTORY_MAX points (fenetre glissante : on jette les plus vieux).
function pushHistory() {
  history.timestamps.push(Date.now());
  history.latitudes.push(state.latitude);
  history.longitudes.push(state.longitude);
  history.altitudes.push(state.altitude);
  if (history.timestamps.length > HISTORY_MAX) {
    history.timestamps.shift();
    history.latitudes.shift();
    history.longitudes.shift();
    history.altitudes.shift();
  }
}

// ============================================================
// Dispatch NMEA
// ============================================================
// Point d'entree pour chaque ligne recue du port serie. Valide,
// bufferise, puis aiguille vers le bon parser selon le type de trame.
function parseNMEA(raw) {
  const line = raw.trim();
  if (!line.startsWith('$')) return;        // ignore tout ce qui n'est pas une trame NMEA
  if (!checksumValid(line)) return;         // rejette les trames corrompues

  lastNmeaTs = Date.now();                  // on a recu quelque chose de valide -> flux vivant

  nmeaPending.push(line);                   // pour le prochain broadcast
  nmeaBuffer.push(line);                    // pour les nouveaux clients
  if (nmeaBuffer.length > NMEA_BUF_MAX) nmeaBuffer.shift();

  const body   = line.slice(1, line.lastIndexOf('*')); // sans '$' ni checksum
  const fields = body.split(',');
  const tag    = fields[0];                 // ex. "GNGGA"
  const prefix = tag.slice(0, 2);           // ex. "GN" (talker / constellation)
  const type   = tag.slice(2);              // ex. "GGA" (type de trame)

  switch (type) {
    case 'GGA':
      // GGA ouvre un nouveau cycle : on fige le precedent puis on repart
      commitCycle();
      cycle = freshCycle();
      parseGGA(fields);
      break;
    case 'RMC': parseRMC(fields);          break;
    case 'GSA': parseGSA(fields);          break;
    case 'GSV': parseGSV(fields, prefix);  break;
    default:                               break;  // autres trames (VTG, GLL...) ignorees
  }
}

// ============================================================
// Port serie
// ============================================================
let serialPort   = null;    // instance SerialPort courante
let retryTimer   = null;    // timer de reconnexion en cours
let shuttingDown = false;   // passe a true pendant l'arret propre

// Ouvre le port serie et cable les handlers. En cas d'echec ou de
// fermeture inopinee, replanifie une tentative dans RECONNECT_MS
// (utile si le device USB disparait puis revient).
function openSerial() {
  if (shuttingDown) return;
  console.log('[serial] Ouverture de ' + SERIAL_PORT + ' @ ' + SERIAL_BAUD + ' baud');

  serialPort = new SerialPort({
    path:     SERIAL_PORT,
    baudRate: SERIAL_BAUD,
    autoOpen: false,           // on ouvre nous-memes pour gerer l'erreur
  });

  // Le ReadlineParser regroupe les octets en lignes completes (\r\n).
  const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  serialPort.open((err) => {
    if (err) {
      console.error('[serial] Erreur : ' + err.message);
      console.log('[serial] Retry dans ' + RECONNECT_MS + 'ms');
      retryTimer = setTimeout(openSerial, RECONNECT_MS);
      return;
    }
    console.log('[serial] Port ouvert : ' + SERIAL_PORT);
  });

  // Chaque ligne complete -> parseNMEA. On encapsule dans un try/catch
  // pour qu'une trame exotique ne fasse pas tomber tout le process.
  parser.on('data', (line) => {
    try { parseNMEA(line); } catch (e) {
      console.error('[nmea] ' + e.message + ' | ' + line);
    }
  });

  serialPort.on('close', () => {
    if (shuttingDown) return;
    console.warn('[serial] Port ferme. Retry dans ' + RECONNECT_MS + 'ms');
    retryTimer = setTimeout(openSerial, RECONNECT_MS);
  });

  serialPort.on('error', (err) => {
    console.error('[serial] ' + err.message);
  });
}

// ============================================================
// WebSocket
// ============================================================
// Serveur WS qui pousse l'etat a tous les clients. Ecoute sur
// WS_HOST:WS_PORT (toutes interfaces par defaut, cf. README Installation).
const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });
console.log('[ws] WebSocket sur ' + WS_HOST + ':' + WS_PORT);

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log('[ws] Client connecte : ' + ip);

  // A la connexion, on envoie tout de suite l'historique et les
  // dernieres trames brutes, pour que le client demarre avec du contenu.
  ws.send(JSON.stringify({
    type:       'history',
    history:    history,
    nmeaBuffer: nmeaBuffer,
  }));

  ws.on('close', () => console.log('[ws] Client deconnecte : ' + ip));
  ws.on('error', (err) => console.error('[ws] ' + err.message));
});

// Construit le message 'update' diffuse periodiquement. Gere aussi la
// detection de flux perdu (stale) : si plus aucune trame depuis
// STALE_MS, on renvoie un etat "pas de signal" plutot que de figer
// la derniere position connue indefiniment.
function buildPayload() {
  const now   = Date.now();
  const stale = (now - lastNmeaTs) > STALE_MS;
  const is3D  = (!stale && state.fixMode === 3 && state.latitude !== null);

  const nmea  = nmeaPending;   // trames accumulees depuis le dernier envoi
  nmeaPending = [];            // ... qu'on vide pour repartir a zero

  return {
    type:        'update',
    ts:          now,
    device:      SERIAL_PORT,
    stale:       stale,
    fixMode:     stale ? 1 : state.fixMode,
    fixQuality:  stale ? 0 : state.fixQuality,
    fixValid:    stale ? false : state.fixValid,
    // Coordonnees uniquement si fix 3D confirme (sinon null).
    latitude:    is3D ? state.latitude  : null,
    longitude:   is3D ? state.longitude : null,
    altitude:    is3D ? state.altitude  : null,
    speed:       is3D ? state.speed     : null,
    course:      is3D ? state.course    : null,
    utcTime:     state.utcTime,
    utcDate:     state.utcDate,
    pdop:        stale ? null : state.pdop,
    hdop:        stale ? null : state.hdop,
    vdop:        stale ? null : state.vdop,
    satsTracked: stale ? 0 : state.satsTracked,
    satsInView:  stale ? 0 : state.satsInView,
    satellites:  stale ? [] : state.satellites,
    nmea:        nmea,
  };
}

// Boucle de diffusion (1 Hz). Si personne n'ecoute, on jette les
// trames en attente pour ne pas accumuler indefiniment.
setInterval(() => {
  if (wss.clients.size === 0) { nmeaPending = []; return; }
  const payload = JSON.stringify(buildPayload());
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(payload); // on n'ecrit que sur les sockets ouvertes
  });
}, BROADCAST_MS);

// ============================================================
// Demarrage + arret propre
// ============================================================
openSerial();   // on lance la lecture serie

// Arret propre (SIGTERM de systemd, Ctrl-C en interactif). Ferme le
// port serie et le serveur WS, avec un filet de securite qui force
// la sortie au bout de 2s si quelque chose bloque.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[main] Arret propre');

  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  if (serialPort && serialPort.isOpen) {
    serialPort.close((err) => {
      if (err) console.error('[serial] Erreur fermeture : ' + err.message);
    });
  }

  wss.clients.forEach((client) => client.terminate());
  wss.close(() => {
    console.log('[main] WebSocket ferme');
    process.exit(0);
  });

  // unref() : ce timer n'empeche pas le process de sortir plus tot.
  setTimeout(() => { process.exit(0); }, 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
