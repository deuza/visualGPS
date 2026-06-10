'use strict';
// ============================================================
// scatter.js - Leaflet/OSM + cercles de precision
// ============================================================
// Trace le nuage des positions recues sur une carte OpenStreetMap,
// avec la position moyenne, des cercles de precision (10..500m) et
// une erreur horizontale RMS. Pour un recepteur statique, ce nuage
// materialise la dispersion du fix autour de la position vraie.
// Module autonome (IIFE), API publique en bas.
// ============================================================

const ScatterPlot = (() => {

  const MAX_POINTS  = 90000;     // plafond dur du nuage (fenetre glissante)
  const DOT_COLOR   = '#5aacff'; // couleur des points
  const DOT_RADIUS  = 4;         // rayon d'un point (px)
  const DOT_OPACITY = 0.65;      // opacite d'un point

  // Cercles de precision affiches autour de la position moyenne.
  const PRECISION_RINGS = [
    { r: 10,  color: '#40e090', dash: [],     label: '10m'  },
    { r: 50,  color: '#5aacff', dash: [6, 4], label: '50m'  },
    { r: 100, color: '#f0a030', dash: [6, 4], label: '100m' },
    { r: 200, color: '#e05050', dash: [4, 4], label: '200m' },
    { r: 500, color: '#b06cff', dash: [4, 4], label: '500m' },
  ];

  let map          = null;   // instance Leaflet
  let dotLayer     = null;   // calque qui contient les points
  let ringLayers   = [];     // cercles de precision (recrees a chaque maj)
  let centerMarker = null;   // marqueur de la position moyenne
  let statsControl = null;   // overlay texte (erreur + nb echantillons)
  let points       = [];     // { lat, lon, marker } - marker garde pour retrait
  let avgLat       = null;   // latitude moyenne
  let avgLon       = null;   // longitude moyenne
  let horizErr     = 0;      // erreur horizontale RMS (m)

  // Cree un point (cercle Leaflet) et l'ajoute au calque.
  function dotMarker(lat, lon) {
    return L.circleMarker([lat, lon], {
      radius:      DOT_RADIUS,
      color:       DOT_COLOR,
      fillColor:   DOT_COLOR,
      fillOpacity: DOT_OPACITY,
      weight:      0,
    }).addTo(dotLayer);
  }

  // Ajoute un point et borne reellement la couche : on retire le
  // marqueur le plus ancien quand on depasse MAX_POINTS (sinon la
  // couche Leaflet grossit sans fin -> fuite memoire + redraw lourd).
  function pushPoint(lat, lon) {
    const marker = dotMarker(lat, lon);
    points.push({ lat, lon, marker });
    if (points.length > MAX_POINTS) {
      const old = points.shift();                       // plus ancien point
      if (old && old.marker) dotLayer.removeLayer(old.marker); // retire son marqueur
    }
  }

  // Initialise la carte (appele une fois ; recree proprement si rappele).
  function init(containerEl) {
    if (map) { map.remove(); map = null; }

    map = L.map(containerEl, {
      zoomControl:        true,
      attributionControl: true,
      preferCanvas:       true,    // rendu canvas : tient des dizaines de milliers de points
    });

    // Fond de carte OSM. maxNativeZoom/maxZoom : voir commentaires.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:   '\u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxNativeZoom: 19,   // OSM standard ne sert pas au-dela de z19...
      maxZoom:       22,   // ...mais on autorise le sur-zoom par upscaling
    }).addTo(map);

    dotLayer = L.layerGroup().addTo(map);   // calque dedie aux points

    // Overlay texte en haut a gauche (stats).
    statsControl = L.control({ position: 'topleft' });
    statsControl.onAdd = () => {
      const div = L.DomUtil.create('div', 'scatter-stats');
      div.innerHTML = 'En attente de 3D Fix...';
      return div;
    };
    statsControl.addTo(map);

    map.setView([47.0, 2.0], 6);   // vue initiale : France entiere
  }

  // Remet tout a zero (points, marqueurs, cercles, stats).
  function reset() {
    points.forEach((p) => { if (p.marker) dotLayer.removeLayer(p.marker); });
    points   = [];
    avgLat   = null;
    avgLon   = null;
    horizErr = 0;
    if (dotLayer)     dotLayer.clearLayers();
    if (centerMarker) { centerMarker.remove(); centerMarker = null; }
    ringLayers.forEach((l) => l.remove());
    ringLayers = [];
  }

  // Recalcul direct (deviations a la moyenne courante) : O(n) par point
  // mais numeriquement stable, contrairement a une variance par sommes
  // de carres sur des lat/lon a forte composante entiere.
  function recalcStats() {
    if (points.length === 0) return;
    // Moyenne des coordonnees.
    let sLat = 0, sLon = 0;
    points.forEach((p) => { sLat += p.lat; sLon += p.lon; });
    avgLat = sLat / points.length;
    avgLon = sLon / points.length;

    // Erreur RMS : on convertit les ecarts angulaires en metres.
    // 111320 m par degre de latitude ; en longitude, on multiplie par
    // cos(lat) (les meridiens se resserrent vers les poles).
    let sumErr = 0;
    const mPerDegLon = 111320 * Math.cos(avgLat * Math.PI / 180);
    points.forEach((p) => {
      const dlat = (p.lat - avgLat) * 111320;
      const dlon = (p.lon - avgLon) * mPerDegLon;
      sumErr += dlat * dlat + dlon * dlon;       // somme des carres des distances
    });
    horizErr = Math.sqrt(sumErr / points.length); // racine de la moyenne -> RMS
  }

  // (Re)dessine les cercles de precision autour de la moyenne.
  function updateRings() {
    ringLayers.forEach((l) => l.remove());
    ringLayers = [];
    if (avgLat === null) return;

    PRECISION_RINGS.forEach(({ r, color, dash, label }) => {
      const circle = L.circle([avgLat, avgLon], {
        radius:      r,
        color:       color,
        weight:      1,
        opacity:     0.7,
        fillOpacity: 0,
        dashArray:   dash.join(',') || null,
      }).addTo(map);
      circle.bindTooltip(label, { permanent: false, direction: 'right', className: 'ring-tooltip' });
      ringLayers.push(circle);
    });

    // Si l'erreur depasse 500m, on ajoute un cercle au pas de 500m.
    if (horizErr > 500) {
      const extra = Math.ceil(horizErr / 500) * 500;
      const circle = L.circle([avgLat, avgLon], {
        radius:      extra,
        color:       '#ff6060',
        weight:      1,
        opacity:     0.5,
        fillOpacity: 0,
        dashArray:   '3,4',
      }).addTo(map);
      circle.bindTooltip(extra + 'm', { permanent: false, direction: 'right', className: 'ring-tooltip' });
      ringLayers.push(circle);
    }
  }

  // (Re)place le marqueur vert de la position moyenne.
  function updateCenter() {
    if (avgLat === null) return;
    if (centerMarker) centerMarker.remove();
    centerMarker = L.circleMarker([avgLat, avgLon], {
      radius:      6,
      color:       '#40e090',
      fillColor:   '#40e090',
      fillOpacity: 1,
      weight:      2,
    }).addTo(map);
  }

  // Met a jour l'overlay texte (erreur RMS + nombre d'echantillons).
  function updateStats() {
    if (!statsControl || !statsControl.getContainer()) return;
    statsControl.getContainer().innerHTML =
      'Horiz Error = ' + horizErr.toFixed(2) + 'm<br>' +
      'Samples = ' + points.length;
  }

  // Ajoute une nouvelle position (appele en temps reel a chaque fix 3D).
  function addPoint(lat, lon) {
    if (lat === null || lon === null) return;
    pushPoint(lat, lon);
    recalcStats();
    updateCenter();
    updateStats();
    if (points.length <= 20) map.setView([avgLat, avgLon], 18);   // zoom auto au demarrage
    if (points.length % 10 === 0 || points.length <= 5) updateRings(); // cercles pas a chaque point
  }

  // Recharge un historique complet (au (re)demarrage / reconnexion WS).
  function loadHistory(history) {
    reset();
    if (!history || !history.latitudes || history.latitudes.length === 0) return;

    const n = history.latitudes.length;
    for (let i = 0; i < n; i++) {
      const lat = history.latitudes[i];
      const lon = history.longitudes[i];
      if (lat === null || lon === null) continue;
      pushPoint(lat, lon);
    }
    if (points.length === 0) return;

    recalcStats();
    updateCenter();
    updateRings();
    updateStats();
    map.setView([avgLat, avgLon], 18);
  }

  // A appeler quand l'onglet devient visible : Leaflet doit recalculer
  // la taille de son conteneur (sinon tuiles grises / carte tronquee).
  function draw() {
    if (map) map.invalidateSize();
  }

  // API publique du module.
  return { init, addPoint, loadHistory, draw, reset };

})();
