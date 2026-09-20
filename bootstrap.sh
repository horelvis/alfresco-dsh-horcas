#!/usr/bin/env sh
#
# Instalador remoto de `alfresco-dsh-horcas`.
#
# El repo es PRIVADO, asi que necesitas autenticacion. Con `gh` autenticado:
#
#   curl -fsSL -H "Authorization: Bearer $(gh auth token)" \
#     https://raw.githubusercontent.com/horelvis/dsh-alfresco-migrator/main/bootstrap.sh | sh
#
# O clona primero y ejecuta install.sh:
#
#   gh repo clone horelvis/dsh-alfresco-migrator ~/.local/share/alfresco-dsh-horcas -- --depth 1
#   ~/.local/share/alfresco-dsh-horcas/install.sh
#
# Clona (o actualiza) el repo en $MIGRATOR_HOME y ejecuta su install.sh.
set -eu

SLUG="${MIGRATOR_SLUG:-horelvis/dsh-alfresco-migrator}"
REPO="${MIGRATOR_REPO:-https://github.com/$SLUG.git}"
DIR="${MIGRATOR_HOME:-$HOME/.local/share/alfresco-dsh-horcas}"

if [ -d "$DIR/.git" ]; then
  echo "[bootstrap] actualizando $DIR"
  git -C "$DIR" pull --ff-only
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "[bootstrap] clonando $SLUG con gh en $DIR"
  mkdir -p "$(dirname "$DIR")"
  gh repo clone "$SLUG" "$DIR" -- --depth 1
else
  command -v git >/dev/null 2>&1 || { echo "[bootstrap] falta git (o gh autenticado)" >&2; exit 1; }
  echo "[bootstrap] clonando $REPO en $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
exec ./install.sh
