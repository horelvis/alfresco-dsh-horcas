#!/usr/bin/env sh
#
# Instalador remoto de `alfresco-dsh-horcas` desde GitHub, sin clonar a mano.
#
#   curl -fsSL https://raw.githubusercontent.com/horelvis/dsh-alfresco-migrator/main/bootstrap.sh | sh
#
# Clona (o actualiza) el repo en $MIGRATOR_HOME y ejecuta su install.sh.
set -eu

REPO="${MIGRATOR_REPO:-https://github.com/horelvis/dsh-alfresco-migrator.git}"
DIR="${MIGRATOR_HOME:-$HOME/.local/share/alfresco-dsh-horcas}"

command -v git >/dev/null 2>&1 || { echo "[bootstrap] falta git" >&2; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "[bootstrap] actualizando $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "[bootstrap] clonando en $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
exec ./install.sh
