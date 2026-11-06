"""
COMPITA - Reportes sectoriales gratuitos
=========================================
1. Clasifica con IA (Claude Haiku) cada licitación abierta y competitiva en un
   sector y subsector. Lo guarda en la tabla licitaciones para no repetirlo.
2. Genera un JSON por reporte en data/reportes/ (construccion, turismo, mipymes),
   que leen las páginas públicas compita.do/reportes/<sector> y los correos.

Se ejecuta en GitHub Actions después del scraping. Necesita DATABASE_URL y
ANTHROPIC_API_KEY.
"""

import os
import re
import json
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras
import requests

DATABASE_URL = os.getenv("DATABASE_URL")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
MODELO_CLASIFICADOR = "claude-haiku-5-5"
MODELO_RESUMEN = "claude-sonnet-5"
ZONA_RD = ZoneInfo("America/Santo_Domingo")
CARPETA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "reportes")

# Modalidades competitivas (la modalidad es el código antes del año en la referencia)
COMPETITIVAS = {"LPN", "LPI", "CP", "CM", "SI", "SO"}
SIMPLIFICADAS_MIPYME = {"CM", "CP"}

SECTORES = {
    "CONSTRUCCION": [
        "Obras civiles e infraestructura",
        "Edificaciones y viviendas",
        "Rehabilitación y mantenimiento de edificaciones",
        "Materiales y equipos de construcción",
        "Diseño, supervisión y estudios técnicos",
    ],
    "TURISMO": [
        "Alojamiento y hospedaje",
        "Alimentación, catering y restaurantes",
        "Eventos y actividades",
        "Infraestructura y servicios turísticos",
        "Promoción y gestión turística",
    ],
    "OTRO": [
        "Suministros de oficina y papelería",
        "Mobiliario y equipamiento",
        "Tecnología e informática",
        "Salud y equipos médicos",
        "Alimentos y bebidas",
        "Limpieza, seguridad y servicios generales",
        "Vehículos, combustible y transporte",
        "Consultoría y servicios profesionales",
        "Capacitación y formación",
        "Comunicación, publicidad e imprenta",
        "Textiles, uniformes y calzado",
        "Otros",
    ],
}

REPORTES = {
    "construccion": {
        "titulo": "Construcción",
        "subtitulo": "Obras, edificaciones, mantenimiento, materiales y estudios técnicos",
    },
    "turismo": {
        "titulo": "Turismo, hotelería y gastronomía",
        "subtitulo": "Alojamiento, alimentación, eventos e infraestructura turística",
    },
    "mipymes": {
        "titulo": "Oportunidades para MIPYMES",
        "subtitulo": "Compras Menores y Comparaciones de Precios de todos los rubros, "
                     "las modalidades simplificadas donde una empresa pequeña puede competir",
    },
}


def modalidad(referencia):
    m = re.search(r"-([A-Z]+)-\d{4}-\d+\s*$", (referencia or "").upper())
    return m.group(1) if m else ""


def llamar_claude(modelo, prompt, max_tokens):
    for intento in range(3):
        try:
            r = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": modelo,
                    "max_tokens": max_tokens,
                    "thinking": {"type": "disabled"},
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=180,
            )
            if r.status_code == 200:
                partes = r.json().get("content", [])
                return "".join(p.get("text", "") for p in partes if p.get("type") == "text")
            print(f"   Claude respondió {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"   Error llamando a Claude: {e}")
        time.sleep(5 * (intento + 1))
    return None


# ----------------------------------------------------------------------------
# 1. CLASIFICACIÓN
# ----------------------------------------------------------------------------

def asegurar_columnas(cur):
    cur.execute("""
        ALTER TABLE licitaciones
          ADD COLUMN IF NOT EXISTS sector_ia TEXT,
          ADD COLUMN IF NOT EXISTS subsector_ia TEXT,
          ADD COLUMN IF NOT EXISTS clasificado_en TIMESTAMPTZ
    """)


def clasificar_pendientes(conn):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT id, referencia, descripcion, unidad_compras
        FROM licitaciones
        WHERE fecha_presentacion > NOW()
          AND clasificado_en IS NULL
        ORDER BY fecha_presentacion ASC
        LIMIT 1500
    """)
    pendientes = [l for l in cur.fetchall() if modalidad(l["referencia"]) in COMPETITIVAS]
    print(f"Por clasificar: {len(pendientes)}")

    opciones = "\n".join(
        f"- {sector}: " + " | ".join(subs) for sector, subs in SECTORES.items()
    )
    total = 0
    for i in range(0, len(pendientes), 80):
        lote = pendientes[i:i + 80]
        lista = "\n".join(
            f"{k + 1}. {(l['descripcion'] or '').strip()[:220]} [{(l['unidad_compras'] or '')[:60]}]"
            for k, l in enumerate(lote)
        )
        prompt = f"""Clasifica cada licitación pública de República Dominicana en UN sector y UN subsector de esta lista:
{opciones}

Criterios:
- CONSTRUCCION: obras, edificaciones, rehabilitación o mantenimiento de inmuebles, materiales y equipos de construcción, diseño o supervisión de obras.
- TURISMO: hospedaje, alimentación preparada, catering, restaurantes, eventos, infraestructura o promoción turística. La compra de alimentos sin preparar va a OTRO, "Alimentos y bebidas".
- Todo lo demás va a OTRO con el subsector que mejor encaje.

LICITACIONES:
{lista}

Responde una línea por licitación, en este formato exacto y sin nada más:
número|SECTOR|subsector"""
        respuesta = llamar_claude(MODELO_CLASIFICADOR, prompt, 4000)
        if not respuesta:
            print("   Lote sin respuesta; se reintentará en la próxima corrida")
            continue
        validos = {s: set(subs) for s, subs in SECTORES.items()}
        cur2 = conn.cursor()
        for linea in respuesta.splitlines():
            partes = [p.strip() for p in linea.split("|")]
            if len(partes) != 3 or not partes[0].isdigit():
                continue
            n, sector, sub = int(partes[0]), partes[1].upper(), partes[2]
            if not (1 <= n <= len(lote)) or sector not in validos:
                continue
            if sub not in validos[sector]:
                sub = "Otros" if sector == "OTRO" else SECTORES[sector][0]
            cur2.execute(
                "UPDATE licitaciones SET sector_ia=%s, subsector_ia=%s, clasificado_en=NOW() WHERE id=%s",
                (sector, sub, lote[n - 1]["id"]),
            )
            total += 1
        conn.commit()
        print(f"   Lote {i // 80 + 1}: clasificadas hasta ahora {total}")
    return total


# ----------------------------------------------------------------------------
# 2. REPORTES
# ----------------------------------------------------------------------------

def a_rd(fecha):
    if fecha is None:
        return None
    if fecha.tzinfo is None:
        fecha = fecha.replace(tzinfo=timezone.utc)
    return fecha.astimezone(ZONA_RD)


def resumen_ia(titulo, kpis, items):
    if not items:
        return ""
    muestra = "\n".join(
        f"- {it['institucion']}: {it['descripcion'][:150]} | {it['monto_texto']} | cierra {it['cierre_texto']} | {it['subsector']}"
        for it in items[:20]
    )
    prompt = f"""Eres el editor de Compita, un servicio que vigila las compras públicas de República Dominicana.
Escribe el párrafo de apertura del reporte "{titulo}" de hoy, para empresarios del sector.

Datos: {kpis['abiertas']} licitaciones abiertas, valor estimado total {kpis['valor_texto']}, {kpis['cierran_7_dias']} cierran en los próximos 7 días.
Algunas de ellas:
{muestra}

Reglas: entre 3 y 4 oraciones, en español claro y concreto. Destaca 2 o 3 oportunidades por institución y monto, y menciona cuántas cierran pronto.
Usa solo los datos de arriba: no inventes cifras, fechas ni instituciones. Sin comillas dobles, sin títulos, sin viñetas, sin saludos."""
    texto = llamar_claude(MODELO_RESUMEN, prompt, 600)
    return (texto or "").strip().replace('"', "«")


def formato_monto(valor, moneda):
    if not valor:
        return "Monto no indicado"
    simbolo = "US$" if (moneda or "").upper() in ("USD", "US$") else "RD$"
    v = float(valor)
    if v >= 1_000_000:
        return f"{simbolo}{v / 1_000_000:,.1f} millones".replace(".0 millones", " millones")
    return f"{simbolo}{v:,.0f}"


MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


def texto_fecha(f):
    return f"{f.day} de {MESES[f.month - 1]}"


def generar_reporte(conn, clave):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT referencia, descripcion, unidad_compras, monto_estimado, moneda,
               fecha_presentacion, url_detalle, sector_ia, subsector_ia
        FROM licitaciones
        WHERE fecha_presentacion > NOW()
          AND sector_ia IS NOT NULL
          AND COALESCE(estado, '') NOT IN ('Canceled', 'Proceso cancelado', 'Suspended',
                                           'Suspendido', 'Awarded', 'NonAwarded', 'Proceso desierto')
        ORDER BY fecha_presentacion ASC
    """)
    filas = cur.fetchall()
    if clave == "construccion":
        filas = [f for f in filas if f["sector_ia"] == "CONSTRUCCION"]
    elif clave == "turismo":
        filas = [f for f in filas if f["sector_ia"] == "TURISMO"]
    else:
        filas = [f for f in filas if modalidad(f["referencia"]) in SIMPLIFICADAS_MIPYME]

    ahora = datetime.now(ZONA_RD)
    items = []
    for f in filas:
        cierre = a_rd(f["fecha_presentacion"])
        items.append({
            "referencia": f["referencia"],
            "institucion": (f["unidad_compras"] or "").strip(),
            "descripcion": (f["descripcion"] or "").strip(),
            "monto": float(f["monto_estimado"]) if f["monto_estimado"] else None,
            "moneda": f["moneda"] or "DOP",
            "monto_texto": formato_monto(f["monto_estimado"], f["moneda"]),
            "cierre": cierre.isoformat(),
            "cierre_texto": texto_fecha(cierre) + cierre.strftime(", %-I:%M %p").lower().replace("am", "a.m.").replace("pm", "p.m."),
            "dias": max(0, (cierre.date() - ahora.date()).days),
            "subsector": f["subsector_ia"] if clave != "mipymes" else (
                f["subsector_ia"] if f["sector_ia"] == "OTRO" else
                ("Construcción" if f["sector_ia"] == "CONSTRUCCION" else "Turismo, hotelería y gastronomía")),
            "modalidad": modalidad(f["referencia"]),
            "url": f["url_detalle"] or "",
        })

    valor = sum(i["monto"] for i in items if i["monto"] and i["moneda"] in ("DOP", "RD$", ""))
    kpis = {
        "abiertas": len(items),
        "valor_total": round(valor),
        "valor_texto": formato_monto(valor, "DOP"),
        "cierran_7_dias": sum(1 for i in items if i["dias"] <= 7),
    }
    conteo = {}
    for i in items:
        conteo[i["subsector"]] = conteo.get(i["subsector"], 0) + 1
    subsectores = sorted(({"nombre": k, "cantidad": v} for k, v in conteo.items()),
                         key=lambda s: -s["cantidad"])

    # Para el resumen, las de mayor monto primero
    destacadas = sorted(items, key=lambda i: -(i["monto"] or 0))
    datos = {
        "clave": clave,
        "titulo": REPORTES[clave]["titulo"],
        "subtitulo": REPORTES[clave]["subtitulo"],
        "actualizado": ahora.isoformat(),
        "actualizado_texto": texto_fecha(ahora) + " de " + str(ahora.year),
        "kpis": kpis,
        "resumen": resumen_ia(REPORTES[clave]["titulo"], kpis, destacadas),
        "subsectores": subsectores,
        "licitaciones": items[:300],
    }
    os.makedirs(CARPETA, exist_ok=True)
    with open(os.path.join(CARPETA, f"{clave}.json"), "w", encoding="utf-8") as fh:
        json.dump(datos, fh, ensure_ascii=False, indent=1)
    print(f"Reporte {clave}: {kpis['abiertas']} abiertas, {kpis['valor_texto']}, "
          f"{kpis['cierran_7_dias']} cierran en 7 días")


def main():
    if not DATABASE_URL or not ANTHROPIC_API_KEY:
        raise SystemExit("Faltan DATABASE_URL o ANTHROPIC_API_KEY")
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    asegurar_columnas(cur)
    conn.commit()
    clasificar_pendientes(conn)
    for clave in REPORTES:
        generar_reporte(conn, clave)
    conn.close()


if __name__ == "__main__":
    main()
