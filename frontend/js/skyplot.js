'use strict';
// ============================================================
// skyplot.js - Sky plot polaire (Canvas2D, HiDPI)
// - Disques colores GPS/GLONASS
// - Symbole "antenne" + carre rouge pour les trackes
// - Lignes DOP (convex hull des sats trackes, approximation VISUELLE :
//   le vrai DOP vient des trames GSA)
// - Rose des vents 8 points + legende
// ============================================================
// Vue du ciel en projection polaire : le zenith (90 deg d'elevation)
// est au centre, l'horizon (0 deg) au bord. L'azimut donne l'angle
// (Nord en haut, sens horaire). Chaque satellite est un disque place
// selon (elevation, azimut). Module autonome (IIFE), API en bas.
// ============================================================

const SkyPlot = (() => {

  // Palette par constellation (identique aux autres modules).
  const COLORS = {
    GPS:     '#5aacff',
    GLONASS: '#e05050',
    Galileo: '#40e090',
    BeiDou:  '#f0a030',
    GNSS:    '#b06cff',
    Unknown: '#7f8c8d',
  };

  // Points cardinaux et leur azimut (en degres) pour la rose des vents.
  const CARDINALS = [
    { label: 'N',  az: 0   }, { label: 'NE', az: 45  },
    { label: 'E',  az: 90  }, { label: 'SE', az: 135 },
    { label: 'S',  az: 180 }, { label: 'SO', az: 225 },
    { label: 'O',  az: 270 }, { label: 'NO', az: 315 },
  ];

  let canvas = null;
  let ctx    = null;
  let S = 0;                 // taille logique (CSS px, carre)
  let cx = 0, cy = 0, radius = 0;  // centre du disque et rayon de l'horizon
  let lastSats = [];               // derniere liste recue (redraw au resize)

  // Memorise canvas + contexte (appele une fois au demarrage).
  function init(canvasEl) {
    canvas = canvasEl;
    ctx    = canvas.getContext('2d');
  }

  // cssSize : cote du carre en pixels CSS. Backing store a la
  // resolution physique (devicePixelRatio), repere remis en px CSS.
  function resize(cssSize) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    S = Math.max(0, Math.floor(cssSize));
    canvas.width        = Math.round(S * dpr);   // backing store physique
    canvas.height       = Math.round(S * dpr);
    canvas.style.width  = S + 'px';              // taille CSS
    canvas.style.height = S + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);      // dessin en coordonnees CSS
    cx     = S / 2;                              // centre = zenith
    cy     = S / 2;
    radius = S / 2 - 32;                         // marge pour les labels cardinaux
    draw(lastSats);
  }

  // Projette (elevation, azimut) en coordonnees ecran (x, y).
  // - elevation bornee a [0, 90] ; 90 -> centre, 0 -> bord (r = radius).
  // - azimut : 0 = Nord (vers le haut), sens horaire.
  //   x = cx + r*sin(az), y = cy - r*cos(az)  (y vers le bas a l'ecran).
  function satToXY(elevation, azimuth) {
    const el = Math.max(0, Math.min(90, elevation));
    const az = azimuth * Math.PI / 180;          // degres -> radians
    const r  = radius * (1 - el / 90);           // plus c'est haut, plus c'est pres du centre
    return { x: cx + r * Math.sin(az), y: cy - r * Math.cos(az) };
  }

  // ---- Convex hull (Andrew monotone chain) -----------------
  // Produit l'enveloppe convexe d'un nuage de points. Utilise ici
  // pour tracer une "toile" reliant les satellites trackes : plus la
  // surface est large et bien repartie, meilleure est la geometrie
  // (PDOP bas). C'est une indication VISUELLE, pas le vrai DOP.

  // Produit vectoriel (OA x OB) : signe = orientation du virage en B.
  function cross(O, A, B) {
    return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  }

  // Andrew monotone chain : tri par x (puis y), puis construction des
  // chaines inferieure et superieure en retirant les virages non
  // convexes. Complexite O(n log n).
  function convexHull(points) {
    if (points.length < 2) return points;
    const sorted = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();   // on retire le dernier point de chaque chaine...
    lower.pop();   // ...car il est partage avec l'autre chaine (eviter le doublon)
    return lower.concat(upper);
  }

  // ---- Symbole "antenne" + carre rouge ---------------------
  // Petit pictogramme dessine au-dessus d'un satellite tracke :
  // deux montants, une barre horizontale, surmontes d'un carre rouge.
  function drawAntenna(x, y, satRadius) {
    const top  = y - satRadius - 5;   // base de l'antenne, juste au-dessus du disque
    const barH = 7;                   // hauteur des montants
    const barW = 3;                   // demi-largeur de la barre horizontale
    const gap  = 3;                   // ecart entre les deux montants

    ctx.strokeStyle = '#e8eeff';
    ctx.lineWidth   = 1.5;

    ctx.beginPath(); ctx.moveTo(x - gap, top); ctx.lineTo(x - gap, top - barH); ctx.stroke(); // montant gauche
    ctx.beginPath(); ctx.moveTo(x + gap, top); ctx.lineTo(x + gap, top - barH); ctx.stroke(); // montant droit
    ctx.beginPath(); ctx.moveTo(x - gap - barW, top); ctx.lineTo(x + gap + barW, top); ctx.stroke(); // barre

    const sq = 5;                     // carre rouge au sommet
    ctx.fillStyle = '#e84040';
    ctx.fillRect(x - sq / 2, top - barH - sq - 1, sq, sq);
  }

  // ---- Legende ---------------------------------------------
  // Quatre entrees en bas a gauche : geometrie DOP, satellite tracke,
  // GPS, GLONASS.
  function drawLegend() {
    const lx    = 8;        // marge gauche
    const ly    = S - 8;    // ligne de base (bas du canvas)
    const lineH = 16;       // interligne

    ctx.font         = '10px "Share Tech Mono", monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';

    // 1) Trait pointille -> geometrie DOP
    ctx.strokeStyle = 'rgba(120,190,255,0.85)';
    ctx.lineWidth   = 1.6;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(lx, ly - lineH * 3 + 4);
    ctx.lineTo(lx + 18, ly - lineH * 3 + 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#7aaace';
    ctx.fillText('= Geometrie DOP', lx + 22, ly - lineH * 3 + 4);

    // 2) Carre rouge -> satellite tracke
    ctx.fillStyle = '#e84040';
    ctx.fillRect(lx + 5, ly - lineH * 2 - 2, 8, 8);
    ctx.fillStyle = '#7aaace';
    ctx.fillText('= Satellite tracke', lx + 22, ly - lineH * 2 + 2);

    // 3) Disque bleu -> GPS
    ctx.beginPath();
    ctx.arc(lx + 9, ly - lineH + 4, 6, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.GPS;
    ctx.fill();
    ctx.fillStyle = '#7aaace';
    ctx.fillText('= GPS', lx + 22, ly - lineH + 4);

    // 4) Disque rouge -> GLONASS
    ctx.beginPath();
    ctx.arc(lx + 9, ly + 4, 6, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.GLONASS;
    ctx.fill();
    ctx.fillStyle = '#7aaace';
    ctx.fillText('= GLONASS', lx + 22, ly + 4);

    ctx.textBaseline = 'alphabetic';   // remise a la valeur par defaut
  }

  // ---- Draw principal --------------------------------------
  // Trace, dans l'ordre : fond, cercles d'elevation, zenith, axes et
  // labels cardinaux, toile DOP, satellites, puis legende.
  function draw(satellites) {
    if (!ctx || S === 0) return;
    lastSats = satellites;

    // Fond
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#080d14';
    ctx.fillRect(0, 0, S, S);

    // Cercles d'elevation
    // Anneaux concentriques a 0/30/60 deg, avec leur valeur annotee.
    [
      { el: 0,  color: '#2a4a70', lw: 1.5 },   // horizon (cercle exterieur)
      { el: 30, color: '#1e3a5f', lw: 1   },
      { el: 60, color: '#1e3a5f', lw: 1   },
    ].forEach(({ el, color, lw }) => {
      const r = radius * (1 - el / 90);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.strokeStyle = color;
      ctx.lineWidth   = lw;
      ctx.stroke();
      if (el > 0) {
        ctx.fillStyle    = '#3a6090';
        ctx.font         = '10px "Share Tech Mono", monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(el + '\u00b0', cx, cy - r + 12);   // \u00b0 = degre
      }
    });

    // Zenith
    // Petit point central (elevation 90 deg).
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
    ctx.fillStyle = '#2a4a70';
    ctx.fill();

    // Axes cardinaux
    // Rayons depuis le centre ; trait plein pour N/E/S/O, pointille
    // pour les diagonales.
    CARDINALS.forEach(({ az }) => {
      const azRad = az * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + radius * 0.95 * Math.sin(azRad), cy - radius * 0.95 * Math.cos(azRad));
      if (az % 90 === 0) { ctx.strokeStyle = '#1e3a5f'; ctx.setLineDash([]);     ctx.lineWidth = 1; }
      else               { ctx.strokeStyle = '#152a40'; ctx.setLineDash([3, 5]); ctx.lineWidth = 1; }
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Labels cardinaux
    // Texte place juste au-dela de l'horizon ; N/E/S/O plus gros.
    CARDINALS.forEach(({ label, az }) => {
      const azRad  = az * Math.PI / 180;
      const dist   = radius + 20;
      const isMain = az % 90 === 0;
      ctx.fillStyle    = isMain ? '#90c8ff' : '#4a7aaa';
      ctx.font         = isMain ? 'bold 13px "Share Tech Mono", monospace'
                                : '10px "Share Tech Mono", monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx + dist * Math.sin(azRad), cy - dist * Math.cos(azRad));
    });
    ctx.textBaseline = 'alphabetic';

    // ---- Lignes DOP (convex hull des sats trackes) ---------
    // On ne garde que les trackes ayant une position valide.
    const tracked = satellites.filter((s) => s.tracked &&
      s.elevation !== undefined && s.azimuth !== undefined);

    if (tracked.length >= 3) {
      // 3 sats ou plus : polygone (enveloppe convexe), trait pointille bien
      // visible + leger remplissage pour materialiser la surface couverte.
      const hull = convexHull(tracked.map((s) => satToXY(s.elevation, s.azimuth)));
      ctx.beginPath();
      ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(120,190,255,0.85)';
      ctx.lineWidth   = 1.6;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(90,172,255,0.12)';
      ctx.fill();
    } else if (tracked.length === 2) {
      // 2 sats : simple segment.
      const p0 = satToXY(tracked[0].elevation, tracked[0].azimuth);
      const p1 = satToXY(tracked[1].elevation, tracked[1].azimuth);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.strokeStyle = 'rgba(120,190,255,0.85)';
      ctx.lineWidth   = 1.6;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- Satellites ----------------------------------------
    // Un disque par satellite ; les trackes sont plus gros, opaques,
    // avec un halo, l'antenne et un label PRN.
    satellites.forEach((sat) => {
      if (sat.elevation === undefined || sat.azimuth === undefined) return;
      const { x, y } = satToXY(sat.elevation, sat.azimuth);
      const color    = COLORS[sat.system] || COLORS.Unknown;
      const r        = sat.tracked ? 9 : 6;        // rayon du disque

      if (sat.tracked) {
        // Halo translucide (suffixe '22' = alpha ~0.13 en hexa).
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
        ctx.fillStyle = color + '22';
        ctx.fill();
      }

      // Disque principal (plein si tracke, translucide '44' sinon).
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle   = sat.tracked ? color : color + '44';
      ctx.fill();
      ctx.strokeStyle = sat.tracked ? '#ffffff22' : 'transparent';
      ctx.lineWidth   = 1;
      ctx.stroke();

      if (sat.tracked) drawAntenna(x, y, r);

      // Label PRN sous le disque.
      ctx.fillStyle    = sat.tracked ? '#c8e8ff' : '#4a6a90';
      ctx.font         = 'bold 10px "Share Tech Mono", monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(sat.prn, x, y + r + 12);
    });

    drawLegend();
  }

  // API publique du module.
  return { init, resize, draw };

})();
