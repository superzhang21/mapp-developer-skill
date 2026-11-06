# 脱敏审计 + 打包：bash scripts/package.sh [输出目录]
# 审计不通过则拒绝打包。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="${1:-$ROOT/../dist}"
ZIP_NAME="mapp-developer-skill.zip"

cd "$ROOT"

echo "== 脱敏检查 =="
# 拦绝对路径、邮箱、手机号、密钥形态；example.* 示例域名除外。
# 扫全部文本文件，只跳过含检测正则字面量的 selftest.py / package.sh。
FAIL=0
SCAN_ARGS="--include=*.md --include=*.py --include=*.mjs --include=*.ts --include=*.json --include=*.yaml --include=*.css --include=*.html --include=*.sh --include=*.txt --include=*.svg --include=LICENSE --exclude=selftest.py --exclude=package.sh"

# shellcheck disable=SC2086
if grep -rInE '/home/[^/[:space:]]+|/Users/[^/[:space:]]+|C:\\\\Users\\\\[^\\[:space:]]+|AppData' $SCAN_ARGS . 2>/dev/null | grep -v '<用户名>' | grep -v 'C:\\Users\\<' | grep -v '\[\^' | grep -q .; then
  echo "✗ 发现本地绝对路径"
  # shellcheck disable=SC2086
  grep -rInE '/home/[^/[:space:]]+|/Users/[^/[:space:]]+|C:\\\\Users\\\\[^\\[:space:]]+|AppData' $SCAN_ARGS . 2>/dev/null | grep -v '<用户名>' | grep -v '\[\^' | head -10
  FAIL=1
fi

# shellcheck disable=SC2086
if grep -rInohE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' $SCAN_ARGS . 2>/dev/null | grep -v 'example\.com' | grep -v 'example\.org' | grep -v 'example\.net' | grep -q .; then
  echo "✗ 发现疑似真实邮箱（example.* 示例域名除外）"
  FAIL=1
fi

# shellcheck disable=SC2086
if grep -rInE '(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)' $SCAN_ARGS . 2>/dev/null | grep -q .; then
  echo "✗ 发现疑似手机号"
  FAIL=1
fi

# shellcheck disable=SC2086
if grep -rIlE 'sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC )?PRIVATE KEY' $SCAN_ARGS . >/dev/null 2>&1; then
  echo "✗ 发现疑似密钥"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "脱敏检查未通过，拒绝打包。"
  exit 1
fi
echo "✓ 脱敏检查通过（通用模式，未含任何具体人名/项目名）"

echo
echo "== 语法自检 =="
node --check scripts/validate.mjs && echo "✓ validate.mjs"
node --check scripts/pack.mjs && echo "✓ pack.mjs"
node --check scripts/check_zip.mjs && echo "✓ check_zip.mjs"
python3 -c "import ast,sys; ast.parse(open('scripts/sync_upstream.py',encoding='utf-8').read())" \
  && echo "✓ sync_upstream.py"
python3 -c "import ast,sys; ast.parse(open('scripts/scaffold.py',encoding='utf-8').read())" \
  && echo "✓ scaffold.py"
python3 -c "import ast,sys; ast.parse(open('scripts/evolve.py',encoding='utf-8').read())" \
  && echo "✓ evolve.py"

echo
echo "== 打包 =="
mkdir -p "$OUT"
rm -f "$OUT/$ZIP_NAME"

# zip 需包含顶层目录 mapp-developer-skill/
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/mapp-developer-skill"
cp -r . "$STAGE/mapp-developer-skill/"
rm -rf "$STAGE/mapp-developer-skill/.git" "$STAGE/mapp-developer-skill/node_modules"
find "$STAGE/mapp-developer-skill" -type d -name __pycache__ -prune -exec rm -rf {} +

cd "$STAGE"
if command -v zip >/dev/null 2>&1; then
  zip -qr "$OUT/$ZIP_NAME" mapp-developer-skill -x '*.DS_Store'
else
  python - "$OUT/$ZIP_NAME" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk("mapp-developer-skill"):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
        for f in files:
            p = os.path.join(root, f)
            z.write(p, p)
PY
fi

cd "$ROOT"
SIZE=$(wc -c < "$OUT/$ZIP_NAME")
echo "✓ $OUT/$ZIP_NAME  ($((SIZE / 1024)) KiB)"
