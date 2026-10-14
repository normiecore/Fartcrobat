#!/usr/bin/env bash
# Third reader: Apache PDFBox 3.0.5 decrypts every created file with the recipient's .p12 and must
# report the same pages, text, annotations, outline, fields, attachments, title and XMP as it does
# for the plain source.  Usage: verify/pdfbox_all.sh [filter]
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
JAR="$HERE/thirdparty/dl/pdfbox-app-3.0.5.jar"
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
run() { java -cp "$JAR" "$HERE/thirdparty/PdfBoxCheck.java" "$@" 2>&1 | grep -v -e JAVA_TOOL -e '^[A-Z][a-z][a-z] [0-9]* 20' -e '^INFO:' -e '^WARNING:'; }
mkdir -p "$HERE/out/checks"
for f in "$HERE"/out/*.pdf; do
  tag=$(basename "$f" .pdf)
  [[ -n "${1:-}" && "$tag" != *"$1"* ]] && continue
  name=${tag%%.*}
  plain="$HERE/out/checks/$name.plain.pdfbox.txt"
  [[ -s "$plain" ]] || run "${IN[$name]}" > "$plain"
  keys=(r1)
  [[ "$tag" == *r1r2* || "$tag" == *r1Xr2* ]] && keys=(r1 r2)
  for k in "${keys[@]}"; do
    out="$HERE/out/checks/$tag.$k.pdfbox.txt"
    run "$f" "$HERE/keys/$k.p12" spike "$k" > "$out"
    enc=$(head -1 "$out")
    if diff <(grep -v '^encryption:' "$out") "$plain" > /dev/null; then res="SAME AS PLAIN"; else res="DIFFERS: $(diff <(grep -v '^encryption:' "$out") "$plain" | grep '^[<>]' | cut -c1-110 | head -2 | tr '\n' ' ')"; fi
    printf '%-26s key %-3s PDFBox: %s | %s\n' "$tag" "$k" "$res" "${enc#encryption: }"
  done
done
# a key that is not a recipient must be refused
run "$HERE/out/text.B.r1.pdf" "$HERE/keys/stranger.p12" spike stranger | head -2 | sed 's/^/stranger key on text.B.r1: /'
