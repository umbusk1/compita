"""
backfill_parsear.py
-------------------
Etapa 2 del backfill de precios históricos.
Lee PDFs guardados en ofertas_pendientes, los parsea con Claude
y guarda los precios en precios_referencia.

Variables de entorno requeridas (secrets de GitHub):
  DATABASE_URL      — conexión a Neon
  ANTHROPIC_API_KEY — clave de Claude API
  LOTE_SIZE         — cuántos PDFs procesar (default: 100)
"""

import os
import json
import requests
import psycopg2
import io
from pypdf import PdfReader

DATABASE_URL      = os.environ["DATABASE_URL"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
LOTE_SIZE         = int(os.environ.get("LOTE_SIZE", "100"))


# ── PASO 1: Obtener PDFs pendientes de procesar ───────────────────────────────

def obtener_pendientes():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    cur.execute("""
        SELECT id, licitacion_id, referencia, nombre_procedimiento, nombre_pdf, pdf_bytes
        FROM   ofertas_pendientes
        WHERE  procesado = FALSE
        ORDER  BY licitacion_id, id
        LIMIT  %s
    """, (LOTE_SIZE,))
    filas = cur.fetchall()
    cur.close()
    conn.close()
    print(f"✅ {len(filas)} PDFs pendientes de parsear.")
    return filas


# ── PASO 2: Extraer texto del PDF ─────────────────────────────────────────────

def extraer_texto(pdf_bytes):
    try:
        reader = PdfReader(io.BytesIO(bytes(pdf_bytes)))
        if reader.is_encrypted:
            return None
        texto = ""
        for pg in reader.pages:
            try:
                t = pg.extract_text()
                if t:
                    texto += t + "\n"
            except:
                continue
        return texto.strip() or None
    except Exception as e:
        print(f"    ⚠️ Error extrayendo texto: {e}")
        return None


# ── PASO 3: Parsear con Claude ────────────────────────────────────────────────

PROMPT_PARSEO = """Eres un extractor de datos de ofertas económicas de licitaciones públicas dominicanas.
Extrae TODOS los ítems de la tabla de precios y devuelve ÚNICAMENTE JSON válido, sin texto adicional:

{
  "ofertante": "Nombre completo de la empresa ofertante",
  "items": [
    {
      "item_numero": "1",
      "descripcion": "Descripción completa del ítem",
      "unidad_medida": "Unidad",
      "cantidad": 10,
      "precio_unitario": 1500.00,
      "itbis": 270.00,
      "precio_total": 15000.00,
      "moneda": "DOP"
    }
  ]
}

Si un campo no está disponible usa null. Si la moneda no está indicada asume DOP.
Si el documento no contiene una tabla de precios devuelve: {"ofertante": null, "items": []}"""


def parsear_con_claude(texto):
    try:
        headers = {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
        }
        payload = {
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 4000,
            "messages": [{
                "role": "user",
                "content": PROMPT_PARSEO + "\n\nDocumento:\n" + texto[:80000]
            }]
        }
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers=headers, json=payload, timeout=120
        )
        if resp.status_code != 200:
            print(f"    ⚠️ Claude API error {resp.status_code}")
            return None

        texto_resp = resp.json()['content'][0]['text']
        texto_resp = texto_resp.replace('```json', '').replace('```', '').strip()
        inicio = texto_resp.find('{')
        fin    = texto_resp.rfind('}')
        if inicio == -1 or fin == -1:
            return None
        return json.loads(texto_resp[inicio:fin+1])

    except Exception as e:
        print(f"    ⚠️ Error llamando Claude: {e}")
        return None


# ── PASO 4: Guardar en precios_referencia ─────────────────────────────────────

def guardar_precios(licitacion_id, referencia, nombre_procedimiento, datos, nombre_pdf):
    if not datos or not datos.get("items"):
        return 0

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    n    = 0

    for item in datos["items"]:
        try:
            cur.execute("""
                INSERT INTO precios_referencia
                    (licitacion_id, numero_procedimiento, nombre_procedimiento,
                     ofertante, item_numero, descripcion, unidad_medida,
                     cantidad, precio_unitario, itbis, precio_total,
                     moneda, fuente_pdf)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                licitacion_id,
                referencia,
                nombre_procedimiento,
                datos.get("ofertante"),
                item.get("item_numero"),
                item.get("descripcion"),
                item.get("unidad_medida"),
                item.get("cantidad"),
                item.get("precio_unitario"),
                item.get("itbis"),
                item.get("precio_total"),
                item.get("moneda", "DOP"),
                nombre_pdf
            ))
            n += 1
        except Exception as e:
            print(f"      ⚠️ Error insertando ítem: {e}")
            conn.rollback()

    conn.commit()
    cur.close()
    conn.close()
    return n


# ── PASO 5: Marcar PDF como procesado ────────────────────────────────────────

def marcar_procesado(fila_id):
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    cur.execute("""
        UPDATE ofertas_pendientes
        SET    procesado = TRUE,
               procesado_at = NOW()
        WHERE  id = %s
    """, (fila_id,))
    conn.commit()
    cur.close()
    conn.close()


# ── ORQUESTADOR ───────────────────────────────────────────────────────────────

def main():
    pendientes   = obtener_pendientes()
    total_items  = 0
    total_ok     = 0
    total_sin_texto   = 0
    total_sin_precios = 0

    for (fila_id, lid, referencia, nombre_proc, nombre_pdf, pdf_bytes) in pendientes:
        print(f"\n📄 [{lid}] {referencia} — {nombre_pdf}")

        # Extraer texto
        texto = extraer_texto(pdf_bytes)
        if not texto:
            print(f"  ⚠️ Sin texto extraíble — marcando como procesado")
            marcar_procesado(fila_id)
            total_sin_texto += 1
            continue

        # Parsear con Claude
        datos = parsear_con_claude(texto)
        if not datos or not datos.get("items"):
            print(f"  ⚠️ Sin ítems de precio — marcando como procesado")
            marcar_procesado(fila_id)
            total_sin_precios += 1
            continue

        # Guardar precios
        n = guardar_precios(lid, referencia, nombre_proc, datos, nombre_pdf)
        print(f"  ✅ {n} ítems guardados — ofertante: {datos.get('ofertante', '?')[:50]}")
        total_items += n
        total_ok    += 1

        # Marcar como procesado
        marcar_procesado(fila_id)

    print(f"""
══════════════════════════════════════
PARSEO COMPLETADO
  PDFs con precios    : {total_ok}
  PDFs sin texto      : {total_sin_texto}
  PDFs sin precios    : {total_sin_precios}
  Ítems insertados    : {total_items}
══════════════════════════════════════""")


if __name__ == "__main__":
    main()