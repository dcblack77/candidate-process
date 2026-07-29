#!/usr/bin/env bash
# Smoke test E2E del flujo canónico (BLUEPRINT §11) contra la API real y el
# modelo Gemma local. Requiere: API corriendo en 127.0.0.1:3010 (pnpm dev:api)
# y llama.cpp sirviendo el modelo en LLM_BASE_URL (por defecto :8080).
#
# Uso: bash scripts/smoke.sh
# Al terminar, cierra el proceso y purga todos los datos de prueba.
set -euo pipefail

API="http://127.0.0.1:3010"
FIXTURE="apps/api/test/fixtures/cv-sample.txt"
PASS=0
FAIL=0

check() { # check <descripcion> <esperado> <obtenido>
    if [ "$2" = "$3" ]; then
        PASS=$((PASS + 1)); echo "  ✓ $1"
    else
        FAIL=$((FAIL + 1)); echo "  ✗ $1 (esperado $2, obtenido $3)"
    fi
}

json() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1" ; }

echo "== 0. Salud =="
HEALTH=$(curl -s "$API/health")
check "health status ok" "ok" "$(echo "$HEALTH" | json .status)"
check "health db" "true" "$(echo "$HEALTH" | json .db)"
check "health llm (modelo arriba)" "true" "$(echo "$HEALTH" | json .llm)"

echo "== 1. Crear proceso =="
curl -s -X POST "$API/process" -H 'content-type: application/json' \
    -d '{"roleTitle":"Smoke Backend TS","roleContext":"Equipo serverless AWS"}' > /dev/null
check "segundo proceso rechazado" "409" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/process" -H 'content-type: application/json' -d '{"roleTitle":"otro"}')"

echo "== 2. Alta de candidato =="
CAND=$(curl -s -X POST "$API/candidates" -H 'content-type: application/json' -d '{"name":"Smoke Uno"}' | json .id)
check "candidato creado" "36" "${#CAND}"

echo "== 3. Extract CV (modelo real) =="
EXTRACT=$(curl -s -X POST "$API/candidates/$CAND/cv/extract" -F "file=@$FIXTURE")
check "estado summarized" "summarized" "$(echo "$EXTRACT" | json .analysisStatus)"
check "archivo no persistido" "true" "$(echo "$EXTRACT" | json .fileDeleted)"

echo "== 4. Analyze (modelo real) =="
ANALYZE=$(curl -s -X POST "$API/candidates/$CAND/analyze" -H 'content-type: application/json' -d '{}')
FINAL=$(echo "$ANALYZE" | json .finalScore)
check "finalScore numérico" "number" "$(node -pe "typeof $FINAL")"
# Recalcular la fórmula §06 a mano y compararla con el backend
RECALC=$(echo "$ANALYZE" | node -e "
const a=JSON.parse(require('fs').readFileSync(0,'utf8')).suggestedScores;
console.log(Math.round((a.adaptability.score*0.30+a.fundamentals.score*0.25+a.depth.score*0.20+a.production.score*0.15+a.stack.score*0.10)*100)/100);")
check "fórmula ponderada §06" "$RECALC" "$FINAL"

echo "== 5. Preguntas de entrevista (modelo real) =="
QUESTIONS=$(curl -s -X POST "$API/candidates/$CAND/questions" -H 'content-type: application/json' -d '{"count":3}')
check "3 preguntas generadas" "3" "$(echo "$QUESTIONS" | json .questions.length)"
check "bloque completo (idealAnswer)" "string" \
    "$(echo "$QUESTIONS" | node -e 'const q=JSON.parse(require("fs").readFileSync(0,"utf8")).questions[0];console.log(typeof q.idealAnswer)')"

echo "== 6. Edición manual y notas privadas =="
check "PATCH score" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/candidates/$CAND/score" -H 'content-type: application/json' -d '{"adaptability":5}')"
check "POST notes" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/candidates/$CAND/notes" -H 'content-type: application/json' -d '{"notes":"SMOKE-NOTA-PRIVADA"}')"

echo "== 7. Ranking =="
RANKING=$(curl -s "$API/ranking")
check "candidato en posición 1" "1" "$(echo "$RANKING" | json '.entries[0].position')"
check "pesos presentes" "0.3" "$(echo "$RANKING" | json .weights.adaptability)"

echo "== 8. Export (defaults seguros) =="
EXPORT=$(curl -s -X POST "$API/export" -H 'content-type: application/json' -d '{}')
check "formato markdown" "markdown" "$(echo "$EXPORT" | json .format)"
check "nota privada EXCLUIDA por defecto" "false" \
    "$(echo "$EXPORT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).content.includes("SMOKE-NOTA-PRIVADA"))')"

# Mismo export en formato estructurado: lo que consume la vista de impresión
# (/export/print) para generar el PDF con el navegador.
PRINT=$(curl -s -X POST "$API/export" -H 'content-type: application/json' -d '{"format":"structured"}')
check "formato structured" "structured" "$(echo "$PRINT" | json .format)"
check "filename .pdf" "true" \
    "$(echo "$PRINT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).filename.endsWith(".pdf"))')"
check "nota privada EXCLUIDA del JSON" "false" \
    "$(echo "$PRINT" | node -e 'console.log(require("fs").readFileSync(0,"utf8").includes("SMOKE-NOTA-PRIVADA"))')"

echo "== 9. Cierre y purga =="
check "close sin confirmación rechazado" "400" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/process/close" -H 'content-type: application/json' -d '{}')"
CLOSE=$(curl -s -X POST "$API/process/close" -H 'content-type: application/json' -d '{"confirmDelete":true}')
check "proceso borrado" "true" "$(echo "$CLOSE" | json .deleted)"
check "sin proceso activo tras cierre" "404" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$API/process")"

echo
echo "Resultado: $PASS OK, $FAIL fallos"
[ "$FAIL" -eq 0 ]
