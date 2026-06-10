'use strict';
// ============================================================
// app.js - visualGPS : client WebSocket + layout adaptatif
// ============================================================
// Chef d'orchestre cote navigateur : ouvre la connexion WebSocket
// vers le backend, dispatche les messages recus vers les 4 onglets
// (Front Panel, Scatter, Position, NMEA), et gere le redimensionnement
// des vues. Aucune dependance de build : du JS "vanille" + les libs
// uPlot et Leaflet chargees globalement par index.html.
// ============================================================

// Port du backend WebSocket. Cette ligne est synchronisee avec
// GPS_WS_PORT par install.sh (ne pas reformater le debut de ligne).
const WS_PORT = 8765;

// URL WebSocket :
//  - ws://  sur une page HTTP, wss:// sur une page HTTPS (pas de mixed content)
//  - par defaut : connexion directe au backend sur WS_PORT
//  - deploiement HTTPS derriere reverse-proxy nginx : definir, AVANT le
//    chargement de app.js,  window.VGPS_WS_PATH = '/visualGPS/ws'
//    (voir README, section HTTPS)
function buildWsUrl() {
  const proto = (location.protocol === 'https:') ? 'wss://' : 'ws://';
  if (window.VGPS_WS_PATH) return proto + location.host + window.VGPS_WS_PATH;   // mode reverse-proxy
  return proto + (location.hostname || 'localhost') + ':' + WS_PORT;            // mode direct
}

const WS_RECONNECT_MS = 5000;   // delai de reconnexion WebSocket

// Instances globales (remplies a l'init).
let ws       = null;            // socket courante
let uplotLat = null;            // graphe latitude
let uplotLon = null;            // graphe longitude
let uplotAlt = null;            // graphe altitude

// Donnees des graphes en colonnes paralleles : [temps, lat, lon, alt].
const tsData   = [[], [], [], []];
const PLOT_MAX = 14400;   // 4h a 1Hz (aligne sur HISTORY_MAX du backend)

// Raccourci document.getElementById.
const $ = (id) => document.getElementById(id);

// ============================================================
// Onglets
// ============================================================
// Bascule la classe 'active' sur le bouton et le panneau cibles, et
// declenche le rafraichissement specifique de l'onglet affiche (les
// vues masquees ont une taille nulle, il faut les redimensionner au
// moment ou elles deviennent visibles).
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + target).classList.add('active');

      // Rafraichissement a l'affichage de chaque onglet.
      if (target === 'scatter')    { ScatterPlot.draw(); }
      if (target === 'frontpanel') { resizeSkyPlot(); resizeSatBars(); }
      if (target === 'position')   { resizePlots(); refreshPlots(); }
      if (target === 'nmea')       { renderNMEA(); }
    });
  });
}

// ============================================================
// Resize helpers (le HiDPI est gere DANS les modules canvas)
// ============================================================
// Ces fonctions calculent la taille CSS disponible et la passent aux
// modules, qui s'occupent eux-memes du backing store haute resolution.

function resizeSatBars() {
  const c = $('satbar-container');
  if (!c) return;
  SatBars.resize(c.clientWidth, c.clientHeight);
}

function resizeSkyPlot() {
  const c = $('skyplot-container');
  if (!c) return;
  const size = Math.min(c.clientWidth, c.clientHeight) - 20;   // carre, avec marge
  if (size < 10) return;
  SkyPlot.resize(size);
}

function resizePlots() {
  if (!uplotLat) return;
  const wrapper = $('plot-lat');
  if (!wrapper) return;
  const w = wrapper.clientWidth - 20;
  const h = Math.max(100, wrapper.clientHeight - 30);
  if (w < 10) return;
  uplotLat.setSize({ width: w, height: h });
  uplotLon.setSize({ width: w, height: h });
  uplotAlt.setSize({ width: w, height: h });
}

// Reinjecte les donnees courantes dans les 3 graphes (apres resize
// ou changement d'onglet).
function refreshPlots() {
  if (tsData[0].length === 0) return;
  uplotLat.setData([tsData[0], tsData[1]]);
  uplotLon.setData([tsData[0], tsData[2]]);
  uplotAlt.setData([tsData[0], tsData[3]]);
}

// ============================================================
// ResizeObserver
// ============================================================
// Reagit aux changements de taille des conteneurs (fenetre, split...).
// Pour le Position Plot, on ne redimensionne que si l'onglet est visible.
function initResizeObservers() {
  if (!window.ResizeObserver) return;
  new ResizeObserver(() => resizeSatBars()).observe($('satbar-container'));
  new ResizeObserver(() => resizeSkyPlot()).observe($('skyplot-container'));
  new ResizeObserver(() => ScatterPlot.draw()).observe($('scatter-map'));
  new ResizeObserver(() => {
    if ($('tab-position').classList.contains('active')) resizePlots();
  }).observe($('tab-position'));
}

// ============================================================
// Fix status
// ============================================================
// Traduit l'etat du fix en libelle + classe CSS pour le badge.
// stale (flux perdu) prime sur tout le reste.
function fixLabel(mode, valid, stale) {
  if (stale)               return { text: 'PAS DE SIGNAL', cls: 'fix-none' };
  if (mode === 3 && valid) return { text: 'GPS FIX 3D',    cls: 'fix-3d'   };
  if (mode === 2 && valid) return { text: 'GPS FIX 2D',    cls: 'fix-2d'   };
  return                          { text: 'NO FIX',        cls: 'fix-none' };
}

// Formate une valeur numerique (ou '---' si absente) avec decimales et unite.
function fmt(val, decimals, unit) {
  if (val === null || val === undefined) return '---';
  return parseFloat(val).toFixed(decimals) + (unit ? ' ' + unit : '');
}

// ============================================================
// Front Panel
// ============================================================
// Met a jour le badge de fix, l'heure UTC, les coordonnees, les DOP
// et les compteurs de satellites a partir d'un message 'update'.
function updateFrontPanel(data) {
  const is3D = (data.fixMode === 3 && data.fixValid && !data.stale);   // coordonnees affichables ?
  const fl   = fixLabel(data.fixMode, data.fixValid, data.stale);
  $('fix-status').textContent = fl.text;
  $('fix-status').className   = 'fix-badge ' + fl.cls;

  if (data.utcTime) {
    $('utc-time').textContent = (data.utcDate || '---') + '  ' + data.utcTime + ' UTC';
  }

  // Coordonnees : affichees seulement en fix 3D, sinon '---'. \u00b0 = degre.
  $('val-lat').textContent = is3D ? fmt(data.latitude,  8, '\u00b0')   : '---';
  $('val-lon').textContent = is3D ? fmt(data.longitude, 8, '\u00b0')   : '---';
  $('val-alt').textContent = is3D ? fmt(data.altitude,  3, 'M')        : '---';
  $('val-spd').textContent = is3D ? fmt(data.speed,     1, 'km/h')     : '---';

  // DOP : toujours affichees (utiles meme sans fix complet).
  $('val-pdop').textContent = fmt(data.pdop, 1);
  $('val-hdop').textContent = fmt(data.hdop, 1);
  $('val-vdop').textContent = fmt(data.vdop, 1);

  $('val-sats-tracked').textContent = data.satsTracked || '0';
  $('val-sats-view').textContent    = data.satsInView  || '0';

  // Nom du device : renseigne une seule fois (au premier message utile).
  if (data.device && $('sb-device').textContent === '---') {
    $('sb-device').textContent = data.device;
  }
}

// ============================================================
// uPlot (gere le HiDPI nativement)
// ============================================================
// Construit les options d'un graphe uPlot (axe X temporel formate en
// HH:MM, une seule serie de donnees, theme sombre).
function makeUPlotOpts(yLabel, color, width, height) {
  return {
    width:  width  || 800,
    height: height || 140,
    cursor: { show: true, drag: { x: false, y: false } },
    legend: { show: false },
    scales: { x: { time: false } },   // on gere nous-memes le formatage temporel
    axes: [
      {
        // Axe X : libelles HH:MM derives du timestamp (en secondes).
        stroke: '#4a6a90',
        ticks:  { stroke: '#1e3a5f', size: 4 },
        grid:   { stroke: '#1e3a5f', width: 1 },
        font:   '10px "Share Tech Mono", monospace',
        vals:   (u, splits) => splits.map((v) => {
          const d = new Date(v * 1000);
          return d.getHours().toString().padStart(2, '0') + ':' +
                 d.getMinutes().toString().padStart(2, '0');
        }),
      },
      {
        // Axe Y.
        stroke: color,
        ticks:  { stroke: '#1e3a5f', size: 4 },
        grid:   { stroke: '#1e3a5f', width: 1 },
        font:   '10px "Share Tech Mono", monospace',
        size:   72,
      },
    ],
    series: [
      {},   // serie 0 = axe X (temps)
      { label: yLabel, stroke: color, width: 1.2, points: { show: false } },
    ],
  };
}

// Instancie les 3 graphes (latitude / longitude / altitude).
function initUPlot() {
  const wrapper = $('plot-lat');
  const w = (wrapper ? wrapper.clientWidth : 800) - 20;
  const h = 140;
  uplotLat = new uPlot(makeUPlotOpts('Latitude',  '#5aacff', w, h), [[], []], $('plot-lat'));
  uplotLon = new uPlot(makeUPlotOpts('Longitude', '#f0a030', w, h), [[], []], $('plot-lon'));
  uplotAlt = new uPlot(makeUPlotOpts('Altitude',  '#40e090', w, h), [[], []], $('plot-alt'));
}

// Ajoute un point aux 3 series, borne la fenetre a PLOT_MAX, et met a
// jour l'affichage seulement si l'onglet Position est visible.
function pushPlotPoint(ts, lat, lon, alt) {
  if (lat === null) return;
  tsData[0].push(ts / 1000);                  // uPlot attend des secondes
  tsData[1].push(lat);
  tsData[2].push(lon);
  tsData[3].push(alt !== null ? alt : 0);
  if (tsData[0].length > PLOT_MAX) {
    tsData[0].shift(); tsData[1].shift(); tsData[2].shift(); tsData[3].shift();
  }
  if ($('tab-position').classList.contains('active')) {
    uplotLat.setData([tsData[0], tsData[1]]);
    uplotLon.setData([tsData[0], tsData[2]]);
    uplotAlt.setData([tsData[0], tsData[3]]);
  }
}

// Recharge tout l'historique recu du backend dans les graphes ET dans
// le scatter (appele a chaque connexion / reconnexion WebSocket).
function loadHistoryIntoPlot(history) {
  if (!history || !history.timestamps || history.timestamps.length === 0) return;
  tsData[0] = history.timestamps.map((t) => t / 1000);
  tsData[1] = [...history.latitudes];
  tsData[2] = [...history.longitudes];
  tsData[3] = history.altitudes.map((a) => (a !== null ? a : 0));
  if ($('tab-position').classList.contains('active')) refreshPlots();
  ScatterPlot.loadHistory(history);
}

// ============================================================
// NMEA Monitor
// ============================================================
// Journal defilant des dernieres trames brutes, colorees par type.
const nmeaLog  = [];
const NMEA_MAX = 300;   // nb de lignes conservees a l'ecran

// Couleur par type de trame (les 5 derniers caracteres du talker+type).
const NMEA_COLORS = {
  GNGGA: '#5aacff', GPGGA: '#5aacff',
  GNRMC: '#f0a030', GPRMC: '#f0a030',
  GPGSA: '#b06cff', GLGSA: '#e05050', GAGSA: '#40c070', GNGSA: '#b06cff',
  GPGSV: '#20c0a0', GLGSV: '#e06060', GAGSV: '#40d080',
  GNVTG: '#d08030', GPVTG: '#d08030',
};

// Echappe les caracteres HTML (les trames viennent d'une source externe :
// on ne les injecte jamais telles quelles dans le DOM).
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Met en forme une ligne NMEA : tag colore + reste de la trame.
function nmeaLineHtml(line) {
  const commaIdx = line.indexOf(',');
  if (commaIdx < 0) return '<span style="color:#4a6a90">' + escHtml(line) + '</span>';
  const tag   = line.slice(0, commaIdx);          // ex. "$GNGGA"
  const rest  = line.slice(commaIdx);
  const color = NMEA_COLORS[tag.slice(1)] || '#90aace';   // .slice(1) : enleve le '$'
  return '<span style="color:' + color + '">' + escHtml(tag) + '</span>' +
         '<span style="color:#c0d8f0">' + escHtml(rest) + '</span>';
}

// Ajoute une trame au journal (borne a NMEA_MAX), rerend si visible.
function appendNMEA(line) {
  if (!line || line.length < 5) return;
  nmeaLog.push(line);
  if (nmeaLog.length > NMEA_MAX) nmeaLog.shift();
  if ($('tab-nmea').classList.contains('active')) renderNMEA();
}

// Rerend tout le journal et fait defiler vers le bas.
function renderNMEA() {
  const el = $('nmea-receive');
  el.innerHTML = nmeaLog.map(nmeaLineHtml).join('\n');
  el.scrollTop = el.scrollHeight;
}

// ============================================================
// WebSocket
// ============================================================
// Ouvre la connexion, traite les messages 'history' et 'update', et
// se reconnecte automatiquement en cas de coupure.
function connectWS() {
  $('ws-status').textContent = 'Connexion...';
  $('ws-status').className   = 'ws-connecting';

  ws = new WebSocket(buildWsUrl());

  ws.onopen = () => {
    $('ws-status').textContent = 'Connecte';
    $('ws-status').className   = 'ws-connected';
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }   // ignore tout JSON invalide

    // Message initial : historique + buffer de trames.
    if (msg.type === 'history') {
      loadHistoryIntoPlot(msg.history);
      if (Array.isArray(msg.nmeaBuffer)) msg.nmeaBuffer.forEach(appendNMEA);
      return;
    }

    // Message periodique : etat courant.
    if (msg.type === 'update') {
      updateFrontPanel(msg);
      SatBars.draw(msg.satellites || []);
      SkyPlot.draw(msg.satellites || []);

      // Le scatter n'enregistre que les vrais fix 3D.
      if (msg.fixMode === 3 && msg.latitude !== null) {
        ScatterPlot.addPoint(msg.latitude, msg.longitude);
      }
      pushPlotPoint(msg.ts, msg.latitude, msg.longitude, msg.altitude);

      if (Array.isArray(msg.nmea)) msg.nmea.forEach(appendNMEA);
    }
  };

  ws.onclose = () => {
    $('ws-status').textContent = 'Deconnecte';
    $('ws-status').className   = 'ws-disconnected';
    setTimeout(connectWS, WS_RECONNECT_MS);   // reconnexion automatique
  };

  ws.onerror = () => {};   // l'evenement 'close' suit et gere la reconnexion
}

// ============================================================
// Init
// ============================================================
// Point d'entree : une fois le DOM pret, on initialise les modules,
// on dimensionne, on instancie les graphes et on se connecte.
document.addEventListener('DOMContentLoaded', () => {
  initTabs();

  // init AVANT resize (la taille des canvas est posee par les resize)
  SatBars.init($('canvas-satbars'));
  SkyPlot.init($('canvas-skyplot'));
  ScatterPlot.init($('scatter-map'));

  resizeSatBars();
  resizeSkyPlot();

  initUPlot();
  initResizeObservers();
  connectWS();
});
