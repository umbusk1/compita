"""
Diagnóstico de solo lectura de la clasificación sectorial.
Lee .github/pruebas/diagnostico-reportes.json: [{"sector": "TURISMO", "institucion": "Educación"}, ...]
e imprime, para cada caso, el reparto por subsector y una muestra de títulos.
"""
import os, json, psycopg2

consultas = json.load(open(".github/pruebas/diagnostico-reportes.json", encoding="utf-8"))
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
for c in consultas:
    print("\n" + "=" * 90)
    print(f"Sector {c['sector']} · institución contiene «{c['institucion']}»")
    cur.execute("""
        SELECT subsector_ia, COUNT(*), COALESCE(SUM(monto_estimado), 0)
        FROM licitaciones
        WHERE sector_ia = %s AND unidad_compras ILIKE %s AND COALESCE(fecha_publicacion, scrapeado_en) >= '2026-01-01'
        GROUP BY 1 ORDER BY 2 DESC
    """, (c["sector"], f"%{c['institucion']}%"))
    for sub, n, v in cur.fetchall():
        print(f"   {n:5d}  RD${float(v)/1e6:10,.1f} M  {sub}")
    cur.execute("""
        SELECT referencia, subsector_ia, monto_estimado, LEFT(descripcion, 130)
        FROM licitaciones
        WHERE sector_ia = %s AND unidad_compras ILIKE %s AND COALESCE(fecha_publicacion, scrapeado_en) >= '2026-01-01'
        ORDER BY random() LIMIT %s
    """, (c["sector"], f"%{c['institucion']}%", c.get("muestra", 30)))
    for ref, sub, monto, desc in cur.fetchall():
        print(f" - [{sub}] {desc}  ({ref}, RD${float(monto or 0):,.0f})")
    if c.get("mayores"):
        cur.execute("""
            SELECT referencia, unidad_compras, monto_estimado, LEFT(descripcion, 110)
            FROM licitaciones
            WHERE sector_ia = %s AND COALESCE(fecha_publicacion, scrapeado_en) >= %s
              AND COALESCE(fecha_publicacion, scrapeado_en) < %s AND monto_estimado IS NOT NULL
            ORDER BY monto_estimado DESC LIMIT 10
        """, (c["sector"], c["mayores"][0], c["mayores"][1]))
        print(f"   Mayores montos entre {c['mayores'][0]} y {c['mayores'][1]}:")
        for ref, inst, monto, desc in cur.fetchall():
            print(f"   RD${float(monto)/1e9:6.2f} mil M · {inst[:40]} · {desc}  ({ref})")
