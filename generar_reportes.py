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
from concurrent.futures import ThreadPoolExecutor

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
        "subtitulo": "Hoteles, salones y catering para eventos del Estado, además de infraestructura turística",
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
          ADD COLUMN IF NOT EXISTS clasificado_en TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS monto_plausible BOOLEAN,
          ADD COLUMN IF NOT EXISTS monto_revisado_en TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS monto_nota TEXT
    """)


def clasificar_lote(lote):
    """Devuelve [(id, sector, subsector)] para un lote de hasta 80 licitaciones."""
    opciones = "\n".join(f"- {sector}: " + " | ".join(subs) for sector, subs in SECTORES.items())
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
        return []
    validos = {s: set(subs) for s, subs in SECTORES.items()}
    salida = []
    for linea in respuesta.splitlines():
        partes = [p.strip() for p in linea.split("|")]
        if len(partes) != 3 or not partes[0].isdigit():
            continue
        n, sector, sub = int(partes[0]), partes[1].upper(), partes[2]
        if not (1 <= n <= len(lote)) or sector not in validos:
            continue
        if sub not in validos[sector]:
            sub = "Otros" if sector == "OTRO" else SECTORES[sector][0]
        salida.append((lote[n - 1]["id"], sector, sub))
    return salida


def clasificar_pendientes(conn, historial=False):
    """Clasifica las abiertas sin clasificar. Con historial=True, todas las de 2026."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    if historial:
        cur.execute("""
            SELECT id, referencia, descripcion, unidad_compras FROM licitaciones
            WHERE clasificado_en IS NULL AND fecha_presentacion >= '2026-01-01'
              AND substring(upper(referencia) from '-([A-Z]+)-[0-9]{4}-[0-9]+\\s*$') IN ('LPN','LPI','CP','CM','SI','SO')
            ORDER BY fecha_presentacion DESC LIMIT 30000
        """)
    else:
        cur.execute("""
            SELECT id, referencia, descripcion, unidad_compras FROM licitaciones
            WHERE fecha_presentacion > NOW() AND clasificado_en IS NULL
              AND substring(upper(referencia) from '-([A-Z]+)-[0-9]{4}-[0-9]+\\s*$') IN ('LPN','LPI','CP','CM','SI','SO')
            ORDER BY fecha_presentacion ASC LIMIT 1500
        """)
    pendientes = [l for l in cur.fetchall() if modalidad(l["referencia"]) in COMPETITIVAS]
    print(f"Por clasificar{' (historial)' if historial else ''}: {len(pendientes)}")
    lotes = [pendientes[i:i + 80] for i in range(0, len(pendientes), 80)]
    total = 0
    with ThreadPoolExecutor(max_workers=6 if historial else 3) as pool:
        for k, resultado in enumerate(pool.map(clasificar_lote, lotes)):
            cur2 = conn.cursor()
            for lid, sector, sub in resultado:
                cur2.execute(
                    "UPDATE licitaciones SET sector_ia=%s, subsector_ia=%s, clasificado_en=NOW() WHERE id=%s",
                    (sector, sub, lid),
                )
            conn.commit()
            total += len(resultado)
            if (k + 1) % 10 == 0 or k + 1 == len(lotes):
                print(f"   {k + 1}/{len(lotes)} lotes, {total} clasificadas")
    return total


# ----------------------------------------------------------------------------
# 1b. REVISIÓN DE MONTOS GRANDES
# Algunos montos del portal están mal capturados (por ejemplo, RD$8,500 millones
# por "un gredal"). La IA revisa cada monto grande una sola vez; si no es creíble
# para lo que describe la licitación, se excluye de las sumas.
# ----------------------------------------------------------------------------

UMBRAL_REVISION = 500_000_000


def revisar_montos(conn):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT id, referencia, unidad_compras, descripcion, monto_estimado
        FROM licitaciones
        WHERE sector_ia IS NOT NULL AND monto_revisado_en IS NULL
          AND COALESCE(moneda, 'DOP') = 'DOP' AND monto_estimado >= %s
        ORDER BY monto_estimado DESC
    """, (UMBRAL_REVISION,))
    pendientes = cur.fetchall()
    print(f"Montos grandes por revisar: {len(pendientes)}")
    for i in range(0, len(pendientes), 30):
        lote = pendientes[i:i + 30]
        lista = "\n".join(
            f"{k + 1}. [{(l['unidad_compras'] or '')[:60]}] {(l['descripcion'] or '').strip()[:220]} — RD${float(l['monto_estimado']):,.0f}"
            for k, l in enumerate(lote)
        )
        prompt = f"""Revisa estos montos estimados de licitaciones públicas de República Dominicana (pesos dominicanos).
Para cada una, decide si el monto es CREÍBLE para lo que se describe, o si parece un error de captura
(por ejemplo, ceros de más: un solo equipo, un servicio pequeño o un suministro menor por cientos o miles de millones).
Obras grandes (carreteras, acueductos, hospitales, programas nacionales, contratos plurianuales) sí pueden costar miles de millones.

{lista}

Responde una línea por licitación, en este formato exacto y sin nada más:
número|SI o NO|razón breve (máximo 12 palabras)"""
        respuesta = llamar_claude(MODELO_CLASIFICADOR, prompt, 2500)
        if not respuesta:
            continue
        cur2 = conn.cursor()
        for linea in respuesta.splitlines():
            partes = [p.strip() for p in linea.split("|")]
            if len(partes) < 2 or not partes[0].isdigit():
                continue
            n = int(partes[0])
            if not (1 <= n <= len(lote)) or partes[1].upper() not in ("SI", "SÍ", "NO"):
                continue
            plausible = partes[1].upper() != "NO"
            nota = partes[2][:200] if len(partes) > 2 else ""
            cur2.execute(
                "UPDATE licitaciones SET monto_plausible=%s, monto_nota=%s, monto_revisado_en=NOW() WHERE id=%s",
                (plausible, nota, lote[n - 1]["id"]),
            )
        conn.commit()

    # Lista pública de los montos descartados, para poder revisarlos
    cur.execute("""
        SELECT referencia, unidad_compras, LEFT(descripcion, 200) AS descripcion, monto_estimado, monto_nota
        FROM licitaciones WHERE monto_plausible = FALSE ORDER BY monto_estimado DESC
    """)
    dudosos = [{"referencia": r["referencia"], "institucion": r["unidad_compras"], "descripcion": r["descripcion"],
                "monto": float(r["monto_estimado"]), "nota": r["monto_nota"]} for r in cur.fetchall()]
    os.makedirs(CARPETA, exist_ok=True)
    with open(os.path.join(CARPETA, "montos-dudosos.json"), "w", encoding="utf-8") as fh:
        json.dump({"actualizado": datetime.now(ZONA_RD).isoformat(), "montos": dudosos}, fh, ensure_ascii=False, indent=1)
    print(f"Montos excluidos por dudosos: {len(dudosos)}")
    for d in dudosos[:15]:
        print(f"   RD${d['monto']/1e6:,.1f} M · {d['referencia']} · {d['descripcion'][:70]} · {d['nota']}")


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

Reglas: exactamente 3 oraciones, en español claro y concreto. Destaca 2 o 3 oportunidades por institución y monto, y menciona cuántas cierran pronto.
Usa solo los datos de arriba: no inventes cifras, fechas ni instituciones. Sin comillas dobles, sin títulos, sin viñetas, sin saludos."""
    texto = llamar_claude(MODELO_RESUMEN, prompt, 600)
    return (texto or "").strip().replace('"', "«")


def formato_monto(valor, moneda):
    if not valor:
        return "Monto no indicado"
    simbolo = "US$" if (moneda or "").upper() in ("USD", "US$") else "RD$"
    v = float(valor)
    if v >= 1_000_000_000:
        return f"{simbolo}{v / 1_000_000_000:,.1f} mil millones".replace(".0 mil", " mil")
    if v >= 1_000_000:
        return f"{simbolo}{v / 1_000_000:,.1f} millones".replace(".0 millones", " millones")
    return f"{simbolo}{v:,.0f}"


MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


def texto_fecha(f):
    return f"{f.day} de {MESES[f.month - 1]}"


MAX_MONTO_CREIBLE = 50_000_000_000  # montos mayores suelen ser errores de captura


def subsector_de(clave, sector, subsector):
    if clave != "mipymes" or sector == "OTRO":
        return subsector
    return "Construcción" if sector == "CONSTRUCCION" else "Turismo, hotelería y gastronomía"


def pertenece(clave, sector, referencia):
    if clave == "construccion":
        return sector == "CONSTRUCCION"
    if clave == "turismo":
        return sector == "TURISMO"
    return modalidad(referencia) in SIMPLIFICADAS_MIPYME


def mercado(conn, clave):
    """Historial del sector desde enero de 2026: por mes, quién compra, plazos y subsectores."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT referencia, unidad_compras, monto_estimado, moneda, sector_ia, subsector_ia, monto_plausible,
               COALESCE(fecha_publicacion, scrapeado_en) AS publicada, fecha_presentacion
        FROM licitaciones
        WHERE sector_ia IS NOT NULL
          AND COALESCE(fecha_publicacion, scrapeado_en) >= '2026-01-01'
    """)
    filas = [f for f in cur.fetchall() if pertenece(clave, f["sector_ia"], f["referencia"])]

    def valor(f):
        if not f["monto_estimado"] or (f["moneda"] or "DOP") != "DOP" or f["monto_plausible"] is False:
            return 0.0
        v = float(f["monto_estimado"])
        return v if v <= MAX_MONTO_CREIBLE else 0.0

    ahora = datetime.now(ZONA_RD)
    meses = {}
    for m in range(1, ahora.month + 1):
        meses[f"{ahora.year}-{m:02d}"] = {"mes": f"{ahora.year}-{m:02d}", "etiqueta": MESES[m - 1][:3].capitalize(),
                                          "cantidad": 0, "valor": 0.0}
    inst, subs, plazos = {}, {}, []
    for f in filas:
        pub = a_rd(f["publicada"])
        clave_mes = f"{pub.year}-{pub.month:02d}"
        v = valor(f)
        if clave_mes in meses:
            meses[clave_mes]["cantidad"] += 1
            meses[clave_mes]["valor"] += v
        nombre = (f["unidad_compras"] or "Sin nombre").strip()
        i = inst.setdefault(nombre, {"nombre": nombre, "cantidad": 0, "valor": 0.0})
        i["cantidad"] += 1; i["valor"] += v
        sub = subsector_de(clave, f["sector_ia"], f["subsector_ia"])
        s = subs.setdefault(sub, {"nombre": sub, "cantidad": 0, "valor": 0.0})
        s["cantidad"] += 1; s["valor"] += v
        if f["fecha_presentacion"] and f["publicada"]:
            dias = (a_rd(f["fecha_presentacion"]) - pub).total_seconds() / 86400
            if 0 <= dias <= 180:
                plazos.append(dias)

    plazos.sort()
    def pct(p):
        return round(plazos[min(len(plazos) - 1, int(p * len(plazos)))]) if plazos else None

    def redondear(lista):
        for x in lista:
            x["valor"] = round(x["valor"])
            x["valor_texto"] = formato_monto(x["valor"], "DOP") if x["valor"] else "—"
        return lista

    total_valor = sum(valor(f) for f in filas)
    print(f"   Mercado {clave}: {len(filas)} licitaciones desde enero, {formato_monto(total_valor, 'DOP')}")
    return {
        "desde": "enero de 2026",
        "total": {"cantidad": len(filas), "valor": round(total_valor), "valor_texto": formato_monto(total_valor, "DOP")},
        "meses": redondear(list(meses.values())),
        "instituciones": redondear(sorted(inst.values(), key=lambda x: -x["cantidad"])[:10]),
        "subsectores": redondear(sorted(subs.values(), key=lambda x: -x["cantidad"])),
        "plazo": {"mediana": pct(0.5), "p25": pct(0.25), "p75": pct(0.75), "muestras": len(plazos)},
    }


def generar_reporte(conn, clave):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT referencia, descripcion, unidad_compras, monto_estimado, moneda,
               fecha_presentacion, url_detalle, sector_ia, subsector_ia, monto_plausible
        FROM licitaciones
        WHERE fecha_presentacion > NOW()
          AND sector_ia IS NOT NULL
          AND COALESCE(estado, '') NOT IN ('Canceled', 'Proceso cancelado', 'Suspended',
                                           'Suspendido', 'Awarded', 'NonAwarded', 'Proceso desierto')
        ORDER BY fecha_presentacion ASC
    """)
    filas = cur.fetchall()
    filas = [f for f in filas if pertenece(clave, f["sector_ia"], f["referencia"])]

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
            "monto_texto": formato_monto(f["monto_estimado"], f["moneda"])
                           + (" (monto por verificar)" if f["monto_plausible"] is False else ""),
            "monto_dudoso": f["monto_plausible"] is False,
            "cierre": cierre.isoformat(),
            "cierre_texto": texto_fecha(cierre) + cierre.strftime(", %-I:%M %p").lower().replace("am", "a.m.").replace("pm", "p.m."),
            "dias": max(0, (cierre.date() - ahora.date()).days),
            "subsector": subsector_de(clave, f["sector_ia"], f["subsector_ia"]),
            "modalidad": modalidad(f["referencia"]),
            "url": f["url_detalle"] or "",
        })

    valor = sum(i["monto"] for i in items
                if i["monto"] and i["moneda"] in ("DOP", "RD$", "") and not i["monto_dudoso"])
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
    destacadas = sorted(items, key=lambda i: -((i["monto"] or 0) if not i["monto_dudoso"] else 0))
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
        "mercado": mercado(conn, clave),
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
    if os.getenv("HISTORIAL") == "1":
        clasificar_pendientes(conn, historial=True)
    revisar_montos(conn)
    for clave in REPORTES:
        generar_reporte(conn, clave)
    conn.close()


if __name__ == "__main__":
    main()
