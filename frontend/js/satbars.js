'use strict';
// ============================================================
// satbars.js - Barres de signal satellites (Canvas2D, HiDPI)
// ============================================================
// Dessine, pour chaque satellite recu, une barre verticale dont la
// hauteur represente le rapport signal/bruit (SNR, en dB). Les
// satellites effectivement utilises dans le calcul de position
// (tracked) sont opaques ; les autres sont attenues. Couleur par
// constellation. Module autonome expose via la "constante" SatBars
// (pattern IIFE : variables internes privees, API publique en bas).
// ============================================================

const SatBars = (() => {

  // Palette par constellation (memes teintes dans tous les modules).
  const COLORS = {
    GPS:     '#5aacff',
    GLONASS: '#e05050',
    Galileo: '#40e090',
    BeiDou:  '#f0a030',
    GNSS:    '#b06cff',
    Unknown: '#7f8c8d',
  };

  const BAR_W   = 32;   // largeur d'une barre (px logiques)
  const BAR_GAP = 5;    // espace entre deux barres
  const LABEL_H = 20;   // hauteur reservee en bas pour le label PRN
  const SNR_MAX = 50;   // SNR de reference pour une barre pleine (dB)

  let canvas = null;        // element <canvas>
  let ctx    = null;        // contexte de dessin 2D
  let W = 0, H = 0;          // dimensions logiques (CSS px)
  let lastSats = [];         // derniere liste recue (pour redessiner au resize)

  // Memorise le canvas et son contexte. Appele une fois au demarrage.
  function init(canvasEl) {
    canvas = canvasEl;
    ctx    = canvas.getContext('2d');
  }

  // cssW / cssH : taille CSS voulue. On fixe le backing store a la
  // resolution physique (devicePixelRatio) puis on remet le repere en
  // pixels CSS via setTransform -> rendu net sur ecran Retina.
  function resize(cssW, cssH) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;       // 1 sur ecran standard, 2+ sur Retina
    W = Math.max(0, Math.floor(cssW));               // dimensions logiques memorisees
    H = Math.max(0, Math.floor(cssH));
    canvas.width        = Math.round(W * dpr);       // backing store en pixels physiques
    canvas.height       = Math.round(H * dpr);
    canvas.style.width  = W + 'px';                  // taille d'affichage en pixels CSS
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);          // on dessine ensuite en coordonnees CSS
    draw(lastSats);                                  // redessine immediatement le dernier etat
  }

  // Dessine l'ensemble des barres a partir de la liste de satellites.
  function draw(satellites) {
    if (!ctx || W === 0 || H === 0) return;          // pas encore dimensionne
    lastSats = satellites;                           // memorise pour un futur resize

    // Tri : par constellation (ordre fixe), puis par SNR decroissant.
    const sorted = [...satellites].sort((a, b) => {
      const order = { GPS: 0, GLONASS: 1, Galileo: 2, BeiDou: 3, GNSS: 4, Unknown: 5 };
      const oa = order[a.system] !== undefined ? order[a.system] : 9;
      const ob = order[b.system] !== undefined ? order[b.system] : 9;
      if (oa !== ob) return oa - ob;
      return b.snr - a.snr;
    });

    const barAreaH = H - LABEL_H - 4;                // hauteur utile pour les barres

    // Fond
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#080d14';
    ctx.fillRect(0, 0, W, H);

    // Grille horizontale SNR
    // Lignes de repere a 10/20/30/40 dB avec leur valeur a gauche.
    ctx.strokeStyle = '#1e3a5f';
    ctx.lineWidth   = 1;
    [10, 20, 30, 40].forEach((snr) => {
      const y = barAreaH - (snr / SNR_MAX) * barAreaH;
      ctx.beginPath();
      ctx.moveTo(48, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillStyle = '#4a6a90';
      ctx.font      = '10px "Share Tech Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(snr, 44, y + 4);
    });

    // Legende (coin haut-droite)
    // Rappel du code couleur GPS / GLONASS.
    ['GPS', 'GLONASS'].forEach((sys, i) => {
      const lx = W - 105;
      const ly = 12 + i * 16;
      ctx.fillStyle = COLORS[sys];
      ctx.fillRect(lx, ly, 12, 12);
      ctx.fillStyle = '#90aace';
      ctx.font      = '11px "Share Tech Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('= ' + sys, lx + 16, ly + 10);
    });

    // Barres
    const startX = 50;                               // marge a gauche (apres l'axe SNR)
    sorted.forEach((sat, i) => {
      const x = startX + i * (BAR_W + BAR_GAP);
      if (x + BAR_W > W - 110) return;               // ne deborde pas sous la legende

      const snr   = Math.min(sat.snr || 0, SNR_MAX); // borne a SNR_MAX
      const barH  = (snr / SNR_MAX) * barAreaH;       // hauteur proportionnelle
      const y     = barAreaH - barH;                  // origine en haut -> on part du bas
      const color = COLORS[sat.system] || COLORS.Unknown;

      // Barre : opaque si tracke, attenuee sinon.
      ctx.globalAlpha = sat.tracked ? 1.0 : 0.4;
      ctx.fillStyle   = color;
      ctx.fillRect(x, y, BAR_W, barH);

      // Valeur SNR au-dessus de la barre (si non nulle).
      if (snr > 0) {
        ctx.globalAlpha = 1;
        ctx.fillStyle   = sat.tracked ? '#e8eeff' : '#5a7a9a';
        ctx.font        = 'bold 11px "Share Tech Mono", monospace';
        ctx.textAlign   = 'center';
        ctx.fillText(snr, x + BAR_W / 2, Math.max(y - 3, 12)); // jamais hors du canvas
      }

      // Numero de PRN sous la barre.
      ctx.globalAlpha = 1;
      ctx.fillStyle   = sat.tracked ? '#c8e8ff' : '#4a6a90';
      ctx.font        = 'bold 12px "Share Tech Mono", monospace';
      ctx.textAlign   = 'center';
      ctx.fillText(sat.prn, x + BAR_W / 2, H - 4);
    });

    ctx.globalAlpha = 1;                             // remise a l'etat neutre
  }

  // API publique du module.
  return { init, resize, draw };

})();
