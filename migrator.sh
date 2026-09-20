#!/usr/bin/env sh
#
# Lanzador del agente de migracion de Alfresco (plugin dsh-alfresco-migrator) sobre DeepSeek Harness.
#
#   ./migrator.sh "analiza en solo lectura la migracion de data/projects/example.yaml"   # headless
#   ./migrator.sh web [--port 8080] [--no-open]                                          # UI web
#
# Carga `.env`, construye el plugin si falta `dist/`, mapea el modelo al vocabulario de dsh
# (`DEEPSEEK_*`) y arranca dsh con el patch del plugin. Usa el binario `dsh` si esta en el PATH o,
# si no, `npx @deepseek-ai/dsh`. La aprobacion de escrituras por defecto es `deny` (fail-closed):
# en headless el agente solo lee; en web usa `MIGRATOR_APPROVAL=interactive` para aprobar en la UI.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# 1) Configuracion local (no versionada): copia .env.example a .env y rellena.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

# 2) Construye el plugin a demanda.
if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "[migrator] construyendo el plugin..." >&2
  ( cd "$ROOT" && npm install && npm run build )
fi

# 3) El agente dsh usa DEEPSEEK_*; reutilizamos la config del modelo del .env.
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-${OPENAI_API_KEY:-}}"
export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-${OPENAI_BASE_URL:-}}"
export DEEPSEEK_DEFAULT_MODEL="${DEEPSEEK_DEFAULT_MODEL:-${OPENAI_CHAT_OPTIONS_MODEL:-deepseek-v4.1-flash}}"

# 4) Datos de dominio y estado del plugin.
export MIGRATOR_DATA_DIR="${MIGRATOR_DATA_DIR:-$ROOT/data}"
export MIGRATOR_STATE="${MIGRATOR_STATE:-$ROOT/.migrator}"
export MIGRATOR_APPROVAL="${MIGRATOR_APPROVAL:-deny}"

usage() {
  echo "uso: $(basename "$0") <tarea para el agente>" >&2
  echo "     $(basename "$0") web [--port N] [--no-open]" >&2
  echo "ej.: $(basename "$0") \"analiza en solo lectura la migracion de data/projects/example.yaml\"" >&2
}

# Arranca dsh (binario global o via npx).
run_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    exec dsh "$@"
  fi
  echo "[migrator] 'dsh' no esta en el PATH; usando npx @deepseek-ai/dsh" >&2
  exec npx --yes @deepseek-ai/dsh "$@"
}

case "${1:-}" in
  web|--web)
    shift
    run_dsh --profile web --patch "$ROOT/cordis.yml" "$@"
    ;;
  headless|--headless)
    shift
    [ "$#" -gt 0 ] || { usage; exit 2; }
    run_dsh --profile headless --patch "$ROOT/cordis.yml" "$@"
    ;;
  "")
    usage
    exit 2
    ;;
  *)
    run_dsh --profile "${DSH_PROFILE:-headless}" --patch "$ROOT/cordis.yml" "$@"
    ;;
esac
