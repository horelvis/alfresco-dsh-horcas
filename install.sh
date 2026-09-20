#!/usr/bin/env sh
#
# Instalador del agente de migracion de Alfresco (plugin dsh-alfresco-migrator).
#
#   ./install.sh
#
# Instala dependencias, construye el plugin, prepara `.env` a partir de `.env.example` y enlaza el
# lanzador `migrator` en un directorio del PATH (PREFIX, por defecto ~/.local/bin).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX="${PREFIX:-$HOME/.local/bin}"

command -v node >/dev/null 2>&1 || { echo "[instalador] falta node (>=20)" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "[instalador] falta npm" >&2; exit 1; }

echo "[instalador] instalando dependencias del plugin..."
( cd "$ROOT" && npm install )

echo "[instalador] construyendo el plugin..."
( cd "$ROOT" && npm run build )

if [ ! -f "$ROOT/.env" ] && [ -f "$ROOT/.env.example" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "[instalador] creado .env desde .env.example (rellena credenciales y modelo)."
fi

chmod +x "$ROOT/migrator.sh" "$ROOT/install.sh"
mkdir -p "$PREFIX"
ln -sf "$ROOT/migrator.sh" "$PREFIX/migrator"
echo "[instalador] lanzador instalado: $PREFIX/migrator"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "[instalador] anade $PREFIX al PATH para usar 'migrator' directamente." ;;
esac

if ! command -v dsh >/dev/null 2>&1; then
  echo "[instalador] AVISO: 'dsh' no esta en el PATH; instala DeepSeek Harness (npm i -g @deepseek-ai/dsh)." >&2
fi
