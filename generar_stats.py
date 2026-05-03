"""
COMPITA - Generador de Estadísticas para Landing Page
======================================================
Consulta la base de datos Neon y genera stats-2026.json
para actualizar el grafico del landing page automaticamente.
"""

import os
import json
from datetime import datetime
import psycopg2

DATABASE_URL = os.getenv('DATABASE_URL')

def conectar_base_datos():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        print("Conexion exitosa a base de datos Neon")
        return conn
    except Exception as e:
        print(f"Error conectando a base de datos: {e}")
        return None


def generar_estadisticas():
    print("\n" + "="*70)
    print("GENERANDO ESTADISTICAS PARA LANDING PAGE")
    print("="*70 + "\n")

    conn = conectar_base_datos()
    if not conn:
        print("No se pudo conectar a la base de datos")
        return False

    try:
        cursor = conn.cursor()

        # ================================================================
        # 1. TOTAL DE LICITACIONES 2026
        # ================================================================
        cursor.execute("""
            SELECT COUNT(*)
            FROM licitaciones
            WHERE EXTRACT(YEAR FROM fecha_presentacion) >= 2026
        """)
        total_licitaciones = cursor.fetchone()[0]
        print(f"Total licitaciones 2026: {total_licitaciones}")

        # ================================================================
        # 2. LICITACIONES POR ESTADO
        # ================================================================
        cursor.execute("""
            SELECT estado, COUNT(*)
            FROM licitaciones
            WHERE EXTRACT(YEAR FROM fecha_presentacion) >= 2026
            GROUP BY estado
        """)
        estados = dict(cursor.fetchall())
        abiertas = sum(count for estado, count in estados.items()
                       if estado not in ['Cerrado', 'Cancelado', 'Adjudicado'])
        print(f"Licitaciones abiertas: {abiertas}")

        # ================================================================
        # 3. LICITACIONES POR DIA (para el grafico)
        # ================================================================
        cursor.execute("""
            SELECT DATE(fecha_presentacion) as fecha, COUNT(*) as cantidad
            FROM licitaciones
            WHERE EXTRACT(YEAR FROM fecha_presentacion) >= 2026
            GROUP BY DATE(fecha_presentacion)
            ORDER BY fecha
        """)
        por_dia_raw = cursor.fetchall()
        por_dia = []
        for fecha, cantidad in por_dia_raw:
            por_dia.append({
                'fecha': fecha.strftime('%Y-%m-%d'),
                'cantidad': cantidad
            })
        print(f"Dias con licitaciones: {len(por_dia)}")

        # ================================================================
        # 4. PROMEDIO DIARIO
        # ================================================================
        promedio_diario = round(total_licitaciones / len(por_dia), 1) if por_dia else 0
        print(f"Promedio diario: {promedio_diario}")

        # ================================================================
        # 5. COMPETITIVIDAD POR TIPO DE PROCEDIMIENTO
        # ================================================================
        GRUPOS = {
            'LPN': 'competitivo',
            'LPI': 'competitivo',
            'CP':  'competitivo',
            'SI':  'competitivo',
            'CM':  'competitivo',
            'CD':  'directa',
        }

        # Query A: totales reales por tipo (sin filtro de fechas)
        # Se usa para el pie chart — incluye todos los registros
        cursor.execute("""
            SELECT
                SPLIT_PART(referencia, '-', 3) AS tipo,
                COUNT(*) AS total
            FROM licitaciones
            WHERE fecha_presentacion IS NOT NULL
            GROUP BY tipo
            ORDER BY total DESC
        """)
        totales_por_tipo = {row[0]: row[1] for row in cursor.fetchall()}

        # Query B: percentiles solo para competitivos
        # Requiere fecha_presentacion >= scrapeado_en para calcular dias validos
        cursor.execute("""
            SELECT
                SPLIT_PART(referencia, '-', 3) AS tipo,
                ROUND(AVG(EXTRACT(DAY FROM (
                    fecha_presentacion - scrapeado_en
                ))))::int AS prom,
                PERCENTILE_CONT(0.25) WITHIN GROUP
                    (ORDER BY EXTRACT(DAY FROM (
                        fecha_presentacion - scrapeado_en
                    )))::int AS p25,
                PERCENTILE_CONT(0.50) WITHIN GROUP
                    (ORDER BY EXTRACT(DAY FROM (
                        fecha_presentacion - scrapeado_en
                    )))::int AS med,
                PERCENTILE_CONT(0.75) WITHIN GROUP
                    (ORDER BY EXTRACT(DAY FROM (
                        fecha_presentacion - scrapeado_en
                    )))::int AS p75
            FROM licitaciones
            WHERE fecha_presentacion IS NOT NULL
              AND scrapeado_en IS NOT NULL
              AND fecha_presentacion >= scrapeado_en
              AND SPLIT_PART(referencia, '-', 3) IN ('LPN','LPI','CP','SI','CM')
            GROUP BY tipo
        """)
        percentiles = {row[0]: row[1:] for row in cursor.fetchall()}

        tipos = []
        pe_total = 0

        for tipo, total in totales_por_tipo.items():
            if tipo.startswith('PE'):
                grupo = 'excepcion'
                pe_total += total
            elif tipo in GRUPOS:
                grupo = GRUPOS[tipo]
            else:
                grupo = 'otro'

            entrada = {
                'tipo':  tipo,
                'total': total,
                'grupo': grupo,
            }
            if grupo == 'competitivo' and tipo in percentiles:
                prom, p25, med, p75 = percentiles[tipo]
                entrada['prom'] = prom or 0
                entrada['p25']  = p25  or 0
                entrada['med']  = med  or 0
                entrada['p75']  = p75  or 0

            tipos.append(entrada)

        print(f"Tipos de procedimiento encontrados: {len(tipos)}")
        print(f"PE* total: {pe_total}")

        total_todos_tipos = sum(t['total'] for t in tipos)
        competitividad = {
            'actualizado': datetime.now().strftime('%Y-%m-%d'),
            'total':       total_todos_tipos,
            'tipos':       tipos,
            'pe_total':    pe_total,
        }

        # ================================================================
        # 6. GENERAR JSON FINAL
        # ================================================================
        stats = {
            'ultima_actualizacion': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'stats': {
                'total':           total_licitaciones,
                'por_estado':      {'abiertas': abiertas, 'todas': estados},
                'promedio_diario': promedio_diario,
            },
            'por_dia':        por_dia,
            'competitividad': competitividad,
        }

        with open('stats-2026.json', 'w', encoding='utf-8') as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)

        print(f"\nArchivo stats-2026.json generado exitosamente")
        print(f"Tamano: {len(json.dumps(stats))} bytes")

        cursor.close()
        conn.close()
        return True

    except Exception as e:
        print(f"\nError generando estadisticas: {e}")
        import traceback
        traceback.print_exc()
        if conn:
            conn.close()
        return False


if __name__ == "__main__":
    exito = generar_estadisticas()
    if exito:
        print("\nProceso completado exitosamente\n")
    else:
        print("\nProceso fallo\n")
        exit(1)