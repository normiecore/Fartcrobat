#!/usr/bin/env bash
# Runs the pyHanko and MuPDF-bridge checks on every file in out/ and prints one line per check.
# Usage: verify/verify_all.sh [filter]   (set VERBOSE=1 to see the full check output)
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PY="$HERE/../../security/venv/bin/python"
FIX=/home/user/Fartcrobat/tests/fixtures
declare -A IN=(
  [text]=$FIX/text.pdf [form]=$FIX/form.pdf [attachments]=$FIX/navigation/attachments.pdf
  [hiddeninfo]=$FIX/redact/hidden-info.pdf [tagged]=$FIX/edit-text/office-report.pdf
  [signed]=$FIX/forms-fill/signed.pdf [layers]=$FIX/navigation/layers.pdf
  [allfields]=$FIX/forms-fill/all-fields.pdf [objstm]=$HERE/fixtures/objstm.pdf
  [big50]=$HERE/fixtures/big50.pdf [long150]=$FIX/compare/long-old.pdf
  [sigtext]=$HERE/fixtures/signed-text.pdf [frompw]=$HERE/fixtures/encrypted-plain.pdf
  [gen2]=$HERE/fixtures/gen2.pdf [indirect]=$HERE/fixtures/indirect-string.pdf
  [saveback]=$HERE/fixtures/saveback-expected.pdf
)
mkdir -p "$HERE/out/checks"
for f in "$HERE"/out/*.pdf; do
  tag=$(basename "$f" .pdf)
  [[ -n "${1:-}" && "$tag" != *"$1"* ]] && continue
  name=${tag%%.*}
  keys=(r1)
  [[ "$tag" == *r1r2* || "$tag" == *r1Xr2* ]] && keys=(r1 r2)
  for k in "${keys[@]}"; do
    log="$HERE/out/checks/$tag.$k"
    "$PY" -I "$HERE/verify/pyhanko_check.py" "${IN[$name]}" "$f" "$HERE/keys/$k.crt" "$HERE/keys/$k.key" > "$log.pyhanko.txt" 2>&1
    py=$(grep -h '^RESULT' "$log.pyhanko.txt" || echo "RESULT: ERROR $(tail -1 "$log.pyhanko.txt")")
    nd=$(grep -ho 'differences: [0-9]*+*' "$log.pyhanko.txt")
    emp=$(grep -ho 'unencrypted (<>): [0-9]*' "$log.pyhanko.txt" | grep -o '[0-9]*$')
    perm=$(grep -ho 'permissions 0x[0-9a-f]*' "$log.pyhanko.txt" | head -1)
    node "$HERE/verify/mupdf_check.mjs" "${IN[$name]}" "$f" "$HERE/keys/$k.crt" "$HERE/keys/$k.key" > "$log.mupdf.txt" 2>&1
    mu=$(grep -h '^RESULT' "$log.mupdf.txt" || echo "RESULT: ERROR $(tail -1 "$log.mupdf.txt")")
    printf '%-26s key %-3s pyHanko: %-34s (%s, %s, empty<> %s) | MuPDF bridge: %s\n' "$tag" "$k" "${py#RESULT: }" "$nd" "$perm" "${emp:-?}" "${mu#RESULT: }"
    [[ -n "${VERBOSE:-}" ]] && cat "$log.pyhanko.txt" "$log.mupdf.txt"
  done
done
