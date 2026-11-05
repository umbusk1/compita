"""
COMPITA - Actualizar licitaciones vigentes (nov 2026)
=====================================================
El robot diario guarda cada licitación solo el día en que se publica. Si después
la entidad modifica el cronograma (prórroga, enmienda) o la cancela, Compita
se quedaba con la fecha vieja.

Este script revisa en el portal SECP SOLO las licitaciones que algún cliente
tiene en su tablero y que siguen vigentes (o cerraron hace poco), y:
  1. Actualiza la fecha de cierre y el estado en `licitaciones` y `resultados`.
  2. Avisa por correo a cada empresa afectada cuando cambia una fecha de cierre
     o una licitación se cancela o suspende.

Se ejecuta desde GitHub Actions (.github/workflows/actualizar-vigentes.yml).
"""

import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg2
import requests
from playwright.sync_api import sync_playwright

PORTAL_URL = "https://comunidad.comprasdominicana.gob.do/Public/Tendering/ContractNoticeManagement/Index"
DATABASE_URL = os.getenv('DATABASE_URL')
RESEND_API_KEY = os.getenv('RESEND_API_KEY')
SITE_URL = os.getenv('SITE_URL', 'https://compita.do')
FROM_EMAIL = 'Compita Alertas <alertas@compita.umbusk.com>'
ZONA_RD = ZoneInfo('America/Santo_Domingo')

# Estados del portal que significan que la licitación ya no admite ofertas
ESTADOS_CANCELADA = {'Canceled', 'Proceso cancelado', 'Suspended', 'Suspendido'}
MAX_LICITACIONES = 250


def convertir_fecha(texto):
    texto = (texto or '').replace(' (UTC -4 hours)', '').replace(' (UTC -4 horas)', '').strip()
    for fmt in ('%d/%m/%Y %H:%M', '%d/%m/%Y %H:%M:%S', '%d/%m/%Y'):
        try:
            return datetime.strptime(texto, fmt).replace(tzinfo=ZONA_RD)
        except ValueError:
            continue
    return None


def licitaciones_a_revisar(cur):
    """Licitaciones en algún tablero (no descartadas), vigentes o cerradas hace menos de 15 días."""
    cur.execute("""
        SELECT DISTINCT l.id, l.referencia, l.fecha_presentacion, l.estado
        FROM licitaciones l
        JOIN resultados r ON r.licitacion_id = l.id
        WHERE (r.descartada IS NULL OR r.descartada = FALSE)
          AND l.fecha_presentacion > NOW() - INTERVAL '15 days'
          AND COALESCE(l.estado, '') NOT IN ('Awarded', 'Proceso adjudicado y celebrado')
        ORDER BY l.fecha_presentacion ASC
        LIMIT %s
    """, (MAX_LICITACIONES,))
    return cur.fetchall()


def buscar_en_portal(page, referencia):
    """Busca una referencia en el portal y devuelve (fecha_cierre, estado) o None."""
    page.fill('#txtAllWords2Search', referencia)
    page.click('#btnGoButton')
    for _ in range(20):  # hasta ~10 segundos
        time.sleep(0.5)
        for fila in page.query_selector_all('table tbody tr'):
            celdas = fila.query_selector_all('td')
            if len(celdas) < 10:
                continue
            textos = [c.inner_text().strip() for c in celdas]
            for i, t in enumerate(textos):
                # Estructura verificada en el portal: ref, desc, -, publicación, cierre, monto, estado
                if t == referencia and i + 6 < len(textos):
                    return convertir_fecha(textos[i + 4]), textos[i + 6]
    return None


def enviar_avisos(cur, cambios):
    """Un correo por empresa con los cambios de las licitaciones de su tablero."""
    if not cambios or not RESEND_API_KEY:
        return 0
    ids = [c['id'] for c in cambios]
    por_id = {c['id']: c for c in cambios}
    cur.execute("""
        SELECT DISTINCT e.id, e.nombre, u.email, r.licitacion_id
        FROM resultados r
        JOIN empresas e ON e.id = r.empresa_id
        JOIN usuarios u ON u.empresa_id = e.id
        WHERE r.licitacion_id = ANY(%s)
          AND (r.descartada IS NULL OR r.descartada = FALSE)
          AND r.relevancia IN ('ALTA', 'MEDIA')
          AND u.activo = TRUE AND e.activo = TRUE
    """, (ids,))
    empresas = {}
    for emp_id, nombre, email, lic_id in cur.fetchall():
        empresas.setdefault((emp_id, nombre, email), []).append(por_id[lic_id])

    enviados = 0
    for (emp_id, nombre, email), lista in empresas.items():
        filas = ''
        for c in lista:
            if c['cancelada']:
                detalle = f"<strong style='color:#B91C1C;'>{c['estado_nuevo']}</strong> en el portal."
            else:
                detalle = (f"Nuevo cierre: <strong>{c['nueva'].strftime('%d/%m/%Y %I:%M %p')}</strong> "
                           f"(antes: {c['vieja'].astimezone(ZONA_RD).strftime('%d/%m/%Y %I:%M %p') if c['vieja'] else 'sin fecha'}).")
            filas += (f"<div style='border:1px solid #E5E7EB;border-radius:8px;padding:12px;margin:10px 0;'>"
                      f"<p style='margin:0;font-weight:bold;'>{c['referencia']}</p>"
                      f"<p style='margin:6px 0 0 0;color:#374151;'>{detalle}</p></div>")
        html = (f"<div style='font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;'>"
                f"<h2 style='color:#4F46E5;'>📅 Cambios en licitaciones de tu tablero</h2>"
                f"<p>Hola, el portal de compras publicó cambios en {len(lista)} licitación(es) que sigues en Compita:</p>"
                f"{filas}"
                f"<a href='{SITE_URL}/oportunidades.html' style='display:inline-block;background:#4F46E5;color:white;"
                f"padding:12px 24px;text-decoration:none;border-radius:6px;margin-top:10px;font-weight:bold;'>Ver mi tablero →</a>"
                f"<p style='margin-top:24px;font-size:11px;color:#9CA3AF;'>Compita revisa cada día en el portal SECP las licitaciones de tu tablero.</p></div>")
        try:
            r = requests.post('https://api.resend.com/emails',
                              headers={'Authorization': f'Bearer {RESEND_API_KEY}', 'Content-Type': 'application/json'},
                              json={'from': FROM_EMAIL, 'to': [email],
                                    'subject': f'📅 Cambió el cronograma de {len(lista)} licitación(es) de {nombre}',
                                    'html': html}, timeout=20)
            if r.status_code in (200, 201):
                enviados += 1
                print(f"   ✉️  Aviso enviado a {nombre} ({email})")
            else:
                print(f"   ⚠️  Error enviando a {email}: {r.status_code} {r.text[:120]}")
        except Exception as e:
            print(f"   ⚠️  Excepción enviando a {email}: {e}")
    return enviados


def main():
    print('🔄 COMPITA - Actualizar licitaciones vigentes')
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    pendientes = licitaciones_a_revisar(cur)
    print(f'📋 Licitaciones a revisar: {len(pendientes)}')
    if not pendientes:
        return

    cambios, revisadas, no_encontradas = [], 0, 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.set_default_timeout(30000)
        page.goto(PORTAL_URL, timeout=60000)
        page.wait_for_selector('#txtAllWords2Search', timeout=30000)

        for lic_id, referencia, fecha_vieja, estado_viejo in pendientes:
            try:
                encontrado = buscar_en_portal(page, referencia)
            except Exception as e:
                print(f'   ⚠️  {referencia}: error buscando ({e}); se recarga el portal')
                try:
                    page.goto(PORTAL_URL, timeout=60000)
                    page.wait_for_selector('#txtAllWords2Search', timeout=30000)
                except Exception:
                    pass
                continue
            if not encontrado:
                no_encontradas += 1
                continue
            revisadas += 1
            fecha_nueva, estado_nuevo = encontrado

            cambio_fecha = bool(fecha_nueva and fecha_vieja and fecha_nueva != fecha_vieja)
            cambio_estado = bool(estado_nuevo and estado_nuevo != estado_viejo)
            if not (cambio_fecha or cambio_estado):
                continue

            cur.execute("""
                UPDATE licitaciones
                SET fecha_presentacion = COALESCE(%s, fecha_presentacion), estado = %s, actualizado_en = NOW()
                WHERE id = %s
            """, (fecha_nueva, estado_nuevo, lic_id))
            if cambio_fecha:
                cur.execute("UPDATE resultados SET fecha_presentacion = %s WHERE licitacion_id = %s",
                            (fecha_nueva.astimezone(ZONA_RD).date(), lic_id))
            conn.commit()

            cancelada = estado_nuevo in ESTADOS_CANCELADA and estado_viejo not in ESTADOS_CANCELADA
            print(f"   ✏️  {referencia}: "
                  + (f"cierre {fecha_vieja} → {fecha_nueva} " if cambio_fecha else '')
                  + (f"estado {estado_viejo} → {estado_nuevo}" if cambio_estado else ''))
            # Solo se avisa de lo que todavía importa: cierres que aún no pasan
            ahora = datetime.now(ZONA_RD)
            cierre_ref = fecha_nueva or fecha_vieja
            vigente = bool(cierre_ref and cierre_ref > ahora)
            if vigente and (cambio_fecha or cancelada):
                cambios.append({'id': lic_id, 'referencia': referencia, 'vieja': fecha_vieja,
                                'nueva': fecha_nueva, 'estado_nuevo': estado_nuevo, 'cancelada': cancelada})
        browser.close()

    enviados = enviar_avisos(cur, cambios)
    cur.close()
    conn.close()
    print(f'\n✅ Revisadas: {revisadas} | No encontradas: {no_encontradas} | '
          f'Cambios de fecha o cancelaciones: {len(cambios)} | Avisos enviados: {enviados}')


if __name__ == '__main__':
    main()
