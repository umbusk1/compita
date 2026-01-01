"""
COMPITA - Generador de Estadísticas para Landing Page
======================================================
Consulta la base de datos Neon y genera stats-2026.json
para actualizar el gráfico del landing page automáticamente.

Fecha: 01 de enero 2026
Autor: Desarrollo para Moisesp/Compita
"""

import os
import json
from datetime import datetime
import psycopg2
from collections import defaultdict

DATABASE_URL = os.getenv('DATABASE_URL')

def conectar_base_datos():
    """Crea conexión a la base de datos Neon PostgreSQL."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        print("✅ Conexión exitosa a base de datos Neon")
        return conn
    except Exception as e:
        print(f"❌ Error conectando a base de datos: {e}")
        return None


def generar_estadisticas():
    """
    Genera el archivo stats-2026.json con:
    - Total de licitaciones
    - Por estado (abiertas)
    - Promedio diario
    - Licitaciones por día
    """
    
    print("\n" + "="*70)
    print("📊 GENERANDO ESTADÍSTICAS PARA LANDING PAGE")
    print("="*70 + "\n")
    
    conn = conectar_base_datos()
    if not conn:
        print("❌ No se pudo conectar a la base de datos")
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
        print(f"📈 Total licitaciones 2026: {total_licitaciones}")
        
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
        
        # Calcular abiertas (todo lo que no sea "Cerrado" o "Cancelado")
        abiertas = sum(count for estado, count in estados.items() 
                      if estado not in ['Cerrado', 'Cancelado', 'Adjudicado'])
        
        print(f"✅ Licitaciones abiertas: {abiertas}")
        print(f"📋 Por estado: {estados}")
        
        # ================================================================
        # 3. LICITACIONES POR DÍA (para el gráfico)
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
        
        print(f"📅 Días con licitaciones: {len(por_dia)}")
        
        # ================================================================
        # 4. CALCULAR PROMEDIO DIARIO
        # ================================================================
        if len(por_dia) > 0:
            promedio_diario = round(total_licitaciones / len(por_dia), 1)
        else:
            promedio_diario = 0
        
        print(f"📊 Promedio diario: {promedio_diario}")
        
        # ================================================================
        # 5. GENERAR JSON
        # ================================================================
        stats = {
            "ultima_actualizacion": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            "stats": {
                "total": total_licitaciones,
                "por_estado": {
                    "abiertas": abiertas,
                    "todas": estados
                },
                "promedio_diario": promedio_diario
            },
            "por_dia": por_dia
        }
        
        # Guardar archivo
        with open('stats-2026.json', 'w', encoding='utf-8') as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
        
        print(f"\n✅ Archivo stats-2026.json generado exitosamente")
        print(f"📁 Ubicación: ./stats-2026.json")
        print(f"📊 Tamaño: {len(json.dumps(stats))} bytes")
        
        cursor.close()
        conn.close()
        
        return True
        
    except Exception as e:
        print(f"\n❌ Error generando estadísticas: {e}")
        import traceback
        traceback.print_exc()
        
        if conn:
            conn.close()
        
        return False


if __name__ == "__main__":
    print("\n" + "📊 "*35)
    print("COMPITA - GENERADOR DE ESTADÍSTICAS")
    print("📊 "*35 + "\n")
    
    exito = generar_estadisticas()
    
    if exito:
        print("\n✨ Proceso completado exitosamente\n")
    else:
        print("\n❌ Proceso falló\n")
        exit(1)