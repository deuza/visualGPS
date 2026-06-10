#!/bin/sh
# ============================================================
# install.sh - Installation visualGPS sur Debian
# ============================================================
# Script interactif, a lancer en root. Deroule :
#   1. verification de Node.js (>= 16)
#   2. detection / saisie du device serie GPS
#   3. saisie du port WebSocket (synchronise ensuite dans le front)
#   4. creation de l'utilisateur systeme dedie (groupe dialout)
#   5. copie du backend + npm install
#   6. deploiement du frontend dans /var/www/html
#   7. generation et activation de l'unit systemd (durcie)
# Le service n'est PAS demarre automatiquement (cf. resume final).
# ============================================================
set -e   # stoppe au premier echec non gere

# Sources (a cote de ce script) et destinations sur le systeme.
BACKEND_SRC="$(cd "$(dirname "$0")/backend" && pwd)"
FRONTEND_SRC="$(cd "$(dirname "$0")/frontend" && pwd)"
BACKEND_DEST="/opt/visualgps"
FRONTEND_DEST="/var/www/html/visualGPS"
SERVICE_FILE="/etc/systemd/system/visualgps.service"
SERVICE_USER="visualgps"

# ---- Root ? -----------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "[ERR] Ce script doit etre lance en root" >&2
  exit 1
fi

# ---- Node.js ----------------------------------------------
echo "[*] Verification Node.js..."
if ! command -v node > /dev/null 2>&1; then
  echo "[ERR] Node.js non trouve. Installer avec : apt install nodejs npm" >&2
  exit 1
fi
NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 16 ]; then
  echo "[ERR] Node.js >= 16 requis (actuel : $NODE_VER)" >&2
  exit 1
fi
echo "[OK] Node.js $NODE_VER"

# ---- Detection automatique du device GPS ------------------
echo "[*] Recherche du device GPS serie..."

detect_gps_device() {
  for dev in /dev/ttyUSB0 /dev/ttyUSB1 /dev/ttyAMA0 /dev/ttyS0 /dev/serial0; do
    if [ -e "$dev" ]; then
      echo "$dev"
      return 0
    fi
  done
  return 1
}

GPS_DEVICE=""

if DETECTED=$(detect_gps_device); then
  printf "    Detecte : %s\n" "$DETECTED"
  printf "    Utiliser ce device ? [O/n] : "
  read -r REPLY
  case "$REPLY" in
    n|N) GPS_DEVICE="" ;;
    *)   GPS_DEVICE="$DETECTED" ;;
  esac
fi

if [ -z "$GPS_DEVICE" ]; then
  printf "    Entrer le chemin du device GPS [/dev/ttyUSB0] : "
  read -r GPS_DEVICE
  if [ -z "$GPS_DEVICE" ]; then
    GPS_DEVICE="/dev/ttyUSB0"
  fi
fi

echo "[OK] Device GPS : $GPS_DEVICE"

# ---- Port WebSocket ---------------------------------------
printf "[*] Port WebSocket [8765] : "
read -r WS_PORT
if [ -z "$WS_PORT" ]; then
  WS_PORT="8765"
fi
case "$WS_PORT" in
  ''|*[!0-9]*) echo "[ERR] Port invalide : $WS_PORT" >&2; exit 1 ;;
esac
echo "[OK] Port WebSocket : $WS_PORT"

# ---- Utilisateur systeme ----------------------------------
if ! id "$SERVICE_USER" > /dev/null 2>&1; then
  echo "[*] Creation utilisateur $SERVICE_USER..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
usermod -aG dialout "$SERVICE_USER"
echo "[OK] Utilisateur $SERVICE_USER (groupe dialout)"

# ---- Backend ----------------------------------------------
echo "[*] Installation backend dans $BACKEND_DEST..."
mkdir -p "$BACKEND_DEST"
cp "$BACKEND_SRC/server.js"    "$BACKEND_DEST/"
cp "$BACKEND_SRC/package.json" "$BACKEND_DEST/"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$BACKEND_DEST"

echo "[*] Installation des dependances npm..."
cd "$BACKEND_DEST"
npm install --omit=dev --quiet
chown -R "$SERVICE_USER":"$SERVICE_USER" "$BACKEND_DEST"
echo "[OK] Backend installe"

# ---- Frontend ---------------------------------------------
echo "[*] Installation frontend dans $FRONTEND_DEST..."
mkdir -p "$FRONTEND_DEST"
cp -r "$FRONTEND_SRC/." "$FRONTEND_DEST/"

# Synchroniser le port WS du frontend avec celui choisi pour le backend.
# Sans ca, le front taperait toujours 8765 quel que soit le port serveur.
sed -i "s|^const WS_PORT = .*|const WS_PORT = ${WS_PORT}; // synchronise par install.sh|" \
  "$FRONTEND_DEST/js/app.js"

chown -R www-data:www-data "$FRONTEND_DEST" 2>/dev/null || true
find "$FRONTEND_DEST" -type d -exec chmod 755 {} +
find "$FRONTEND_DEST" -type f -exec chmod 644 {} +
echo "[OK] Frontend installe"

# ---- Service systemd (genere avec les bonnes valeurs) -----
echo "[*] Installation service systemd..."
cat > "$SERVICE_FILE" << ENDSVC
[Unit]
Description=visualGPS - NMEA WebSocket backend
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=visualgps
Group=dialout

WorkingDirectory=/opt/visualgps

# GPS_WS_HOST=0.0.0.0 : ecoute sur toutes les interfaces (acces LAN).
# Mettre 127.0.0.1 pour restreindre a la boucle locale. Voir README.
Environment="GPS_DEVICE=${GPS_DEVICE}"
Environment="GPS_BAUD=9600"
Environment="GPS_WS_PORT=${WS_PORT}"
Environment="GPS_WS_HOST="127.0.0.1"

ExecStart=/usr/bin/node /opt/visualgps/server.js

Restart=on-failure
RestartSec=5
TimeoutStopSec=5

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
ReadWritePaths=/tmp

StandardOutput=journal
StandardError=journal
SyslogIdentifier=visualgps

[Install]
WantedBy=multi-user.target
ENDSVC

systemctl daemon-reload
systemctl enable visualgps
echo "[OK] Service visualgps active"

# ---- Resume -----------------------------------------------
echo ""
echo "=============================================="
echo " Installation visualGPS terminee"
echo "=============================================="
echo " Backend    : $BACKEND_DEST"
echo " Frontend   : $FRONTEND_DEST"
echo " Device GPS : $GPS_DEVICE"
echo " Port WS    : $WS_PORT (ecoute sur 0.0.0.0 / toutes interfaces)"
echo ""
echo " Par defaut le dashboard n'est accessible QUE depuis la machine"
echo " elle-meme. Pour le servir sur le LAN ou en HTTPS, voir le README"
echo " (section nginx + warning exposition)."
echo ""
echo " Demarrer  : systemctl start visualgps"
echo " Logs      : journalctl -u visualgps -f"
echo ""
echo " Modifier la config plus tard :"
echo "   vi $SERVICE_FILE"
echo "   systemctl daemon-reload && systemctl restart visualgps"
echo "=============================================="
