#!/usr/bin/env bash
# Freezes mac/serve.py and the server's files into one folder with PyInstaller:
# mac/build/dist/unblent-server/, whose program unblent-server needs no Python on the
# machine. The build has its own throwaway virtual environment under mac/build, never
# the repository's .venv. PYTHON picks the interpreter (default python3).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
build="$repo/mac/build"
stage="$build/stage"
venv="$build/venv"
python="${PYTHON:-python3}"

rm -rf "$stage" "$build/dist" "$build/work"
mkdir -p "$stage"

if [ ! -x "$venv/bin/python" ]; then
  "$python" -m venv "$venv"
fi
"$venv/bin/pip" install -q --upgrade pip
"$venv/bin/pip" install -q -r "$repo/requirements.txt" pyinstaller

# The server is shipped as its own source files, not compiled into the program: its
# routers are loaded from files (server/main.py) and read schema files and pages that
# sit beside them. Tests and caches stay out.
for dir in server components vendor tokens bus store editor composer pages; do
  rsync -a --exclude tests/ --exclude __pycache__/ --exclude '*.pyc' "$repo/$dir/" "$stage/$dir/"
done
mkdir -p "$stage/mac/books"
cp "$repo/mac/books/meditations.epub" "$stage/mac/books/"

# Because the routers are loaded from files, PyInstaller cannot see what they import:
# every module they and the server entry import is named here, read from their source.
# A read loop rather than mapfile, which the bash 3.2 that macOS ships does not have.
hidden=()
while IFS= read -r line; do hidden+=("$line"); done < <("$venv/bin/python" - "$stage" <<'PY'
import ast, importlib.util, sys
from pathlib import Path
names = set()
for path in Path(sys.argv[1]).glob("**/*.py"):
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module)
            # `from xml.etree import ElementTree` imports a submodule, not a name.
            for alias in node.names:
                try:
                    if importlib.util.find_spec(f"{node.module}.{alias.name}"):
                        names.add(f"{node.module}.{alias.name}")
                except ModuleNotFoundError:
                    pass
for name in sorted(names):
    # collections.abc lives in PyInstaller's base library, where its hidden-import lookup fails.
    if name.split(".")[0] not in {"server", "components"} and name != "collections.abc":
        print(f"--hidden-import={name}")
PY
)

data_args=()
for dir in server components vendor tokens bus store editor composer pages mac; do
  data_args+=("--add-data=$stage/$dir:$dir")
done

"$venv/bin/pyinstaller" --noconfirm --clean --onedir --console \
  --name unblent-server \
  --distpath "$build/dist" --workpath "$build/work" --specpath "$build" \
  --collect-submodules uvicorn \
  --exclude-module server --exclude-module components \
  "${hidden[@]}" "${data_args[@]}" \
  "$repo/mac/serve.py"

echo "Built $build/dist/unblent-server/unblent-server ($(du -sh "$build/dist/unblent-server" | cut -f1))"
