"""
backfill_precios.py
-------------------
Script de backfill de precios históricos para Compita.
Se ejecuta manualmente desde GitHub Actions.
"""

import os
import re
import json
import zipfile
import tempfile
import requests
import psycopg2
from pypdf import PdfReader
from playwright.sync_api import sync_playwright
import io

DATABASE_URL      = os.environ["DATABASE_URL"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
LOTE_SIZE         = int(os.environ.get("LOTE_SIZE", "50"))


# ── PASO 1: Licitaciones pendientes ──────────────────────────────────────────

def obtener_pendientes():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    cur.execute("""
        SELECT l.id, l.referencia, l.descripcion
        FROM   licitaciones l
        WHERE  l.estado = 'Proceso adjudicado y celebrado'
          AND  NOT EXISTS (
                   SELECT 1 FROM precios_referencia p
                   WHERE  p.licitacion_id = l.id
               )
        ORDER  BY l.id
        LIMIT  %s
    """, (LOTE_SIZE,))
    filas = cur.fetchall()
    cur.close()
    conn.close()
    print(f"✅ {len(filas)} licitaciones pendientes en este lote.")
    return filas


# ── PASO 2: Descargar ZIP con Playwright ─────────────────────────────────────

def descargar_zip(referencia, carpeta):
    zip_path = os.path.join(carpeta, "procedimiento.zip")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(accept_downloads=True)
        context.set_default_timeout(120000)
        page = context.new_page()

        try:
            url = "https://comunidad.comprasdominicana.gob.do/Public/Tendering/ContractNoticeManagement/Index"
            page.goto(url, timeout=90000)
            page.wait_for_timeout(5000)
            print("  Portal cargado")

            campo = page.locator('#txtAllWords2Search')
            campo.wait_for(state='visible', timeout=10000)
            campo.clear()
            campo.fill(referencia)

            boton_encontrado = False
            for selector in ['input[type="button"][value="Buscar"]', 'input[value="Buscar"]']:
                try:
                    btn = page.locator(selector).first
                    if btn.is_visible(timeout=5000):
                        btn.click()
                        boton_encontrado = True
                        break
                except:
                    pass
            if not boton_encontrado:
                campo.press('Enter')

            page.wait_for_timeout(3000)

            for selector in ['text=Buscar resultados por', 'a:has-text("Borrar")']:
                try:
                    if page.locator(selector).first.is_visible(timeout=10000):
                        break
                except:
                    pass

            page.wait_for_timeout(3000)

            resultado = None
            for xpath in [
                f'//td[contains(text(), "{referencia}")]',
                f'//td[text()="{referencia}"]',
                f'//*[contains(text(), "{referencia}")]',
                f'//td[normalize-space(text())="{referencia}"]',
            ]:
                try:
                    loc = page.locator(f'xpath={xpath}').first
                    if loc.is_visible(timeout=10000):
                        resultado = loc
                        break
                except:
                    continue

            if not resultado:
                print(f"  ❌ No encontrado en portal: {referencia}")
                browser.close()
                return None

            fila = resultado.locator('xpath=ancestor::tr')
            boton_detalle = None
            for sel in [
                'a[title="Detalle"]', 'a[id*="lnkDetailLink"]',
                'xpath=.//a[@title="Detalle"]', 'xpath=.//a[text()="Detalle"]',
                'a:has-text("Detalle")', '*:has-text("Detalle")'
            ]:
                try:
                    btn = fila.locator(sel).first
                    if btn.count() > 0:
                        boton_detalle = btn
                        break
                except:
                    continue

            if not boton_detalle:
                print(f"  ❌ Botón Detalle no encontrado: {referencia}")
                browser.close()
                return None

            boton_detalle.scroll_into_view_if_needed()
            page.wait_for_timeout(2000)
            boton_detalle.click()
            page.wait_for_timeout(5000)

            pages = context.pages
            if len(pages) > 1:
                page = pages[-1]

            page.wait_for_timeout(3000)
            print(f"  Buscando iframe... ({len(page.frames)} frames)")

            iframe_ok = None
            for frame in page.frames:
                try:
                    if frame.locator('#tbToolBar_btnTbDownload').count() > 0:
                        iframe_ok = frame
                        print("  iframe encontrado por botón")
                        break
                except:
                    continue

            if not iframe_ok:
                for frame in page.frames:
                    try:
                        body = frame.locator('body').text_content(timeout=5000)
                        if body and referencia in body:
                            iframe_ok = frame
                            print("  iframe encontrado por contenido")
                            break
                    except:
                        continue

            if not iframe_ok:
                print(f"  ❌ iframe no encontrado: {referencia}")
                browser.close()
                return None

            boton = None
            for sel in [
                '#tbToolBar_btnTbDownload',
                'input[id="tbToolBar_btnTbDownload"]',
                'input[title="Descargar procedimiento"]',
                'input[value="Descargar procedimiento"]',
                'input[type="button"][value="Descargar procedimiento"]'
            ]:
                try:
                    b = iframe_ok.locator(sel).first
                    if b.count() > 0:
                        boton = b
                        break
                except:
                    continue

            if not boton:
                print(f"  ❌ Botón descarga no encontrado: {referencia}")
                browser.close()
                return None

            with page.expect_download(timeout=90000) as dl_info:
                boton.click()

            dl = dl_info.value
            dl.save_as(zip_path)
            browser.close()

            if not os.path.exists(zip_path):
                return None

            mb = os.path.getsize(zip_path) / (1024 * 1024)
            print(f"  📦 ZIP descargado: {mb:.1f} MB")
            return zip_path

        except Exception as e:
            print(f"  ❌ Error Playwright [{referencia}]: {e}")
            try:
                browser.close()
            except:
                pass
            return None


# ── PASO 3: Extraer PDFs de 3_Ofertas/ ───────────────────────────────────────

PALABRAS_INCLUIR = ['oferta', 'cotiz', 'econom', 'precio', 'propuesta']
PALABRAS_EXCLUIR = [
    'registro', 'mercantil', 'tss', 'dgii', 'constancia',
    'tecnic', 'rpe', 'rnc', 'cedula', 'pasaporte',
    'balance', 'financ', 'declaracion'
]


def es_oferta_economica(nombre_pdf):
    n = nombre_pdf.lower()

    if 'ranl' in n:
        return False

    for palabra in PALABRAS_EXCLUIR:
        if palabra in n:
            return False

    for palabra in PALABRAS_INCLUIR:
        if palabra in n:
            return True

    if n in ('oferta.pdf', 'ofertas.pdf'):
        return True

    return True


def extraer_pdfs_ofertas(zip_path):
    todos = []
    filtrados = []
    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for nombre in zf.namelist():
                if re.search(r'3_Ofer', nombre, re.IGNORECASE) and nombre.lower().endswith('.pdf'):
                    base = os.path.basename(nombre)
                    todos.append(base)
                    if es_oferta_economica(base):
                        filtrados.append((base, zf.read(nombre)))
    except Exception as e:
        print(f"  ❌ Error abriendo ZIP: {e}")

    descartados = [n for n in todos if n not in [f[0] for f in filtrados]]
    print(f"  📄 PDFs en 3_Ofertas/: {len(todos)} total → {len(filtrados)} ofertas económicas")
    if descartados:
        print(f"  🗑️  Descartados: {', '.join(descartados)}")
    return filtrados


# ── PASO 4: Parsear PDF con Claude ────────────────────────────────────────────

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

Si un campo no está disponible, usa null. Si la moneda no está indicada, asume DOP."""


def parsear_oferta(nombre_pdf, pdf_bytes):
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        if reader.is_encrypted:
            print(f"    ⚠️ PDF protegido: {nombre_pdf}")
            return None

        texto = ""
        for pg in reader.pages:
            try:
                t = pg.extract_text()
                if t:
                    texto += t + "\n"
            except:
                continue

        if not texto.strip():
            print(f"    ⚠️ PDF sin texto extraíble: {nombre_pdf}")
            return None

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
            print(f"    ⚠️ Claude API error {resp.status_code}: {resp.text[:200]}")
            return None

        texto_resp = resp.json()['content'][0]['text']
        texto_resp = texto_resp.replace('```json', '').replace('```', '').strip()
        inicio = texto_resp.find('{')
        fin    = texto_resp.rfind('}')
        if inicio == -1 or fin == -1:
            return None
        return json.loads(texto_resp[inicio:fin+1])

    except Exception as e:
        print(f"    ⚠️ Error parseando {nombre_pdf}: {e}")
        return None


# ── PASO 5: Guardar en Neon ───────────────────────────────────────────────────

def guardar_items(lid, referencia, descripcion, datos, nombre_pdf):
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
                lid, referencia, descripcion,
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


# ── ORQUESTADOR ───────────────────────────────────────────────────────────────

def main():
    pendientes  = obtener_pendientes()
    total_items = 0
    total_ok    = 0
    total_error = 0

    for (lid, referencia, descripcion) in pendientes:
        print(f"\n🔍 [{lid}] {referencia} — {(descripcion or '')[:60]}")

        with tempfile.TemporaryDirectory() as tmpdir:
            zip_path = descargar_zip(referencia, tmpdir)
            if not zip_path:
                total_error += 1
                continue

            pdfs = extraer_pdfs_ofertas(zip_path)
            if not pdfs:
                print("  ⚠️ Sin PDFs de ofertas — licitación omitida")
                total_error += 1
                continue

            items_licitacion = 0
            for nombre_pdf, pdf_bytes in pdfs:
                print(f"  📊 {nombre_pdf}")
                datos = parsear_oferta(nombre_pdf, pdf_bytes)
                if datos:
                    n = guardar_items(lid, referencia, descripcion, datos, nombre_pdf)
                    items_licitacion += n
                    print(f"    ✅ {n} ítems guardados")

            total_items += items_licitacion
            total_ok    += 1

    print(f"""
══════════════════════════════════════
BACKFILL COMPLETADO
  Licitaciones procesadas : {total_ok}
  Licitaciones con error  : {total_error}
  Ítems insertados        : {total_items}
══════════════════════════════════════""")


if __name__ == "__main__":
    main()
