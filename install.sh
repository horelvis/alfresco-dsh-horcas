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
PROFILE="${PROFILE:-web}"

command -v node >/dev/null 2>&1 || { echo "[instalador] falta node (>=20)" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "[instalador] falta npm" >&2; exit 1; }

echo "[instalador] instalando dependencias del plugin..."
( cd "$ROOT" && npm install )

echo "[instalador] construyendo el plugin..."
( cd "$ROOT" && npm run build )

# Registra el plugin como capa (bundle) del perfil de dsh, si dsh y pnpm estan disponibles.
if command -v dsh >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  echo "[instalador] registrando el plugin en el perfil '$PROFILE' de dsh..."
  if ! dsh plugin --profile "$PROFILE" add "$ROOT"; then
    echo "[instalador] AVISO: no se pudo registrar en el perfil; el lanzador usara --patch." >&2
  fi
else
  echo "[instalador] AVISO: dsh o pnpm no disponibles; el lanzador usara --patch." >&2
fi

if [ ! -f "$ROOT/.env" ] && [ -f "$ROOT/.env.example" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "[instalador] creado .env desde .env.example (rellena credenciales y modelo)."
fi

chmod +x "$ROOT/alfresco-dsh-horcas" "$ROOT/install.sh"

# Comando global `alfresco-dsh-horcas`: `npm link` si es posible; si no, symlink en PREFIX.
if ( cd "$ROOT" && npm link >/dev/null 2>&1 ); then
  echo "[instalador] comando instalado: alfresco-dsh-horcas (via npm link)"
else
  mkdir -p "$PREFIX"
  ln -sf "$ROOT/alfresco-dsh-horcas" "$PREFIX/alfresco-dsh-horcas"
  echo "[instalador] comando enlazado: $PREFIX/alfresco-dsh-horcas"
  case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *) echo "[instalador] anade $PREFIX al PATH para usar 'alfresco-dsh-horcas'." ;;
  esac
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "[instalador] AVISO: 'dsh' no esta en el PATH; instala DeepSeek Harness (npm i -g @deepseek-ai/dsh)." >&2
fi

# ---------------------------------------------------------------------------
# Contexto entre chats: habilita la BUSQUEDA en sesiones previas (session_search) en el patch del
# perfil. El bundle base trae `session-query-sqlite` con `openAt: never` (busqueda deshabilitada) y no
# incluye la tool; aqui se sobrescribe con un indice durable y se inserta la tool por RUTA ABSOLUTA al
# fork (el perfil resuelve bundles desde el dsh global, que no tiene el paquete).
# ---------------------------------------------------------------------------
DSH_HARNESS_DIR="${DSH_HARNESS_DIR:-}"
if [ -z "$DSH_HARNESS_DIR" ] && [ -n "${DSH_BIN:-}" ]; then
  DSH_HARNESS_DIR=$(printf '%s' "$DSH_BIN" | sed -e 's/^node //' -e 's#/apps/cli/.*##')
fi
DSH_HARNESS_DIR="${DSH_HARNESS_DIR:-$HOME/git/deepseek-harness}"
TOOL_TSQ="$DSH_HARNESS_DIR/packages/session-query/tool-session-query/lib/index.js"

# true si el patch del perfil ya tiene entradas (ignora comentarios y un `[]`).
patch_has_content() {
  [ -f "$1" ] || return 1
  grep -vE '^[[:space:]]*(#|$)' "$1" | grep -vqE '^\[\][[:space:]]*$'
}

configure_profile_session_search() {
  prof="$1"
  [ -d "$HOME/.dsh/profiles/$prof" ] || return 0
  patch="$HOME/.dsh/profiles/$prof/cordis.patch.yml"
  if [ -f "$patch" ] && grep -q 'tool-session-query' "$patch" 2>/dev/null; then
    echo "[instalador] perfil '$prof': session-search ya configurado."
    return 0
  fi
  if [ ! -f "$TOOL_TSQ" ]; then
    echo "[instalador] AVISO: no existe $TOOL_TSQ; session-search NO se habilita en '$prof'." >&2
    echo "[instalador]        define DSH_HARNESS_DIR con la ruta del fork y reinstala." >&2
    return 0
  fi
  if patch_has_content "$patch"; then
    printf '\n' >> "$patch"
  else
    printf '# Patch generado por install.sh: busqueda en sesiones previas + tools.\n' > "$patch"
  fi
  cat >> "$patch" <<EOF
- id: session-query-sqlite
  config:
    path: $HOME/.dsh/session-query.sqlite
    openAt: first-search

- insert:
    - id: tool-session-query
      name: $TOOL_TSQ
EOF
  echo "[instalador] perfil '$prof': session-search habilitado ($TOOL_TSQ)."
}

configure_profile_session_search "$PROFILE"
[ "$PROFILE" = "headless" ] || configure_profile_session_search headless
