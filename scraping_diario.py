"""
COMPITA - Scraping Diario Automático
=====================================
Versión optimizada para ejecutarse diariamente de lunes a sábado a las 7 AM.
Solo carga las primeras páginas (10 clicks) donde están las licitaciones más recientes.

Fecha: 31 de diciembre 2025
Autor: Desarrollo para Moisesp/Compita
"""

import os
import time
from datetime import datetime, timedelta
from decimal import Decimal
import re
from playwright.sync_api import sync_playwright
import psycopg2
from psycopg2.extras import execute_values

# ============================================================================
# CONFIGURACIÓN PARA SCRAPING DIARIO
# ============================================================================

PORTAL_URL = "https://comunidad.comprasdominicana.gob.do/Public/Tendering/ContractNoticeManagement/Index"
MAX_CLICKS = 10  # Solo 10 clicks para licitaciones recientes
HEADLESS = True  # Modo sin interfaz gráfica para GitHub Actions

DATABASE_URL = os.getenv('DATABASE_URL')

# ============================================================================
# FUNCIONES AUXILIARES
# ============================================================================

def limpiar_monto(texto_monto):
    """Convierte texto como "280,000.00 Pesos Dominicanos" a número decimal."""
    if not texto_monto:
        return None, None
    
    numeros = re.findall(r'[\d,\.]+', texto_monto)
    if not numeros:
        return None, None
    
    monto_str = numeros[0].replace(',', '')
    
    moneda = "DOP"
    if "USD" in texto_monto.upper() or "DÓLAR" in texto_monto.upper():
        moneda = "USD"
    
    try:
        monto = Decimal(monto_str)
        return monto, moneda
    except:
        return None, None


def convertir_fecha(texto_fecha):
    """Convierte fecha en formato DD/MM/YYYY HH:MM a datetime."""
    if not texto_fecha:
        return None
    
    try:
        formatos = [
            "%d/%m/%Y %H:%M",
            "%d/%m/%Y %H:%M:%S",
            "%d/%m/%Y",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d"
        ]
        
        for formato in formatos:
            try:
                return datetime.strptime(texto_fecha.strip(), formato)
            except:
                continue
        
        return None
    except:
        return None


def conectar_base_datos():
    """Crea conexión a la base de datos Neon PostgreSQL."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        print("✅ Conexión exitosa a base de datos Neon")
        return conn
    except Exception as e:
        print(f"❌ Error conectando a base de datos: {e}")
        return None


# ============================================================================
# FUNCIÓN PRINCIPAL - SCRAPING DIARIO
# ============================================================================

def scraping_diario():
    """
    Scraping optimizado para ejecución diaria:
    - Solo carga primeras páginas (10 clicks)
    - Modo headless para GitHub Actions
    - Filtra licitaciones de 2026
    """
    
    print("\n" + "="*70)
    print("🚀 SCRAPING DIARIO DE LICITACIONES - " + datetime.now().strftime("%d/%m/%Y %H:%M"))
    print("="*70)
    print(f"📄 Cargando primeras {MAX_CLICKS} páginas (licitaciones más recientes)\n")
    
    licitaciones_encontradas = []
    
    with sync_playwright() as p:
        print("📱 Iniciando navegador (modo headless)...")
        browser = p.chromium.launch(headless=HEADLESS)
        page = browser.new_page()
        page.set_default_timeout(30000)
        
        try:
            print(f"🌐 Navegando al portal...")
            page.goto(PORTAL_URL)
            time.sleep(3)
            
            # ================================================================
            # FASE 1: CARGAR PRIMERAS PÁGINAS
            # ================================================================
            print("\n📥 FASE 1: CARGANDO LICITACIONES RECIENTES")
            print("="*70 + "\n")
            
            clicks_exitosos = 0
            
            while clicks_exitosos < MAX_CLICKS:
                print(f"🔄 Click #{clicks_exitosos + 1}...", end=" ")
                
                boton_encontrado = False
                
                try:
                    boton = page.locator("text='Ver más'").first
                    if boton.is_visible(timeout=2000):
                        boton.click()
                        clicks_exitosos += 1
                        boton_encontrado = True
                        print(f"✅")
                        time.sleep(2)
                except:
                    pass
                
                if not boton_encontrado:
                    try:
                        enlaces = page.query_selector_all("a")
                        for enlace in enlaces:
                            texto = enlace.inner_text().strip()
                            if "Ver más" in texto or "ver más" in texto:
                                enlace.click()
                                clicks_exitosos += 1
                                boton_encontrado = True
                                print(f"✅")
                                time.sleep(2)
                                break
                    except:
                        pass
                
                if not boton_encontrado:
                    print(f"\n   ℹ️  No hay más botón 'Ver más' disponible")
                    break
            
            print(f"\n✅ Se cargaron {clicks_exitosos} páginas adicionales\n")
            
            # ================================================================
            # FASE 2: EXTRAER LICITACIONES
            # ================================================================
            print("="*70)
            print("📊 FASE 2: EXTRAYENDO LICITACIONES")
            print("="*70 + "\n")
            
            time.sleep(2)
            
            page.wait_for_selector("table", timeout=10000)
            filas = page.query_selector_all("table tbody tr")
            
            print(f"✅ Tabla cargada con {len(filas)} filas")
            
            fila_principal = None
            for fila in filas:
                celdas = fila.query_selector_all("td")
                if len(celdas) > 100:
                    fila_principal = celdas
                    print(f"✅ Encontradas {len(celdas)} celdas (aprox. {(len(celdas)-93)//10} licitaciones)\n")
                    break
            
            if not fila_principal:
                print("❌ No se encontró la fila principal")
                return licitaciones_encontradas
            
            print("🔍 Procesando licitaciones...\n")
            
            inicio = 93
            total_procesadas = 0
            
            for i in range(inicio, len(fila_principal), 10):
                try:
                    if i + 8 >= len(fila_principal):
                        break
                    
                    unidad = fila_principal[i].inner_text().strip()
                    referencia = fila_principal[i+1].inner_text().strip()
                    descripcion = fila_principal[i+2].inner_text().strip()
                    fecha_pub = fila_principal[i+4].inner_text().strip()
                    fecha_pres = fila_principal[i+5].inner_text().strip()
                    total_estimado = fila_principal[i+6].inner_text().strip()
                    estado = fila_principal[i+7].inner_text().strip()
                    
                    if not referencia:
                        continue
                    
                    # Obtener URL
                    boton_detalle = fila_principal[i+8].query_selector("a")
                    url_detalle = ""
                    if boton_detalle:
                        href = boton_detalle.get_attribute("href")
                        if href:
                            if href.startswith("/"):
                                url_detalle = f"https://comunidad.comprasdominicana.gob.do{href}"
                            else:
                                url_detalle = href
                    
                    fecha_pub_limpia = fecha_pub.replace(" (UTC -4 horas)", "").strip()
                    fecha_pres_limpia = fecha_pres.replace(" (UTC -4 horas)", "").strip()
                    
                    fecha_publicacion = convertir_fecha(fecha_pub_limpia)
                    fecha_presentacion = convertir_fecha(fecha_pres_limpia)
                    
                    total_procesadas += 1
                    
                    if total_procesadas % 25 == 0:
                        print(f"   📌 Procesadas: {total_procesadas}...")
                    
                    monto, moneda = limpiar_monto(total_estimado)
                    
                    # FILTRAR: Solo 2026+
                    if fecha_presentacion and fecha_presentacion.year >= 2026:
                        licitacion = {
                            'unidad_compras': unidad,
                            'referencia': referencia,
                            'descripcion': descripcion,
                            'fecha_publicacion': fecha_publicacion,
                            'fecha_presentacion': fecha_presentacion,
                            'total_estimado_texto': total_estimado,
                            'monto_estimado': monto,
                            'moneda': moneda,
                            'estado': estado,
                            'url_detalle': url_detalle
                        }
                        
                        licitaciones_encontradas.append(licitacion)
                        
                        if len(licitaciones_encontradas) <= 5:
                            print(f"   ✓ [{len(licitaciones_encontradas)}] {referencia[:40]:<40} | {fecha_pres_limpia[:16]}")
                
                except Exception as e:
                    continue
            
            print(f"\n✅ Procesamiento completado:")
            print(f"   - Total procesadas: {total_procesadas}")
            print(f"   - Licitaciones 2026: {len(licitaciones_encontradas)}")
        
        except Exception as e:
            print(f"\n❌ Error durante scraping: {e}")
            import traceback
            traceback.print_exc()
        
        finally:
            print("\n🔒 Cerrando navegador...")
            browser.close()
    
    return licitaciones_encontradas


# ============================================================================
# GUARDAR EN BASE DE DATOS
# ============================================================================

def guardar_en_base_datos(licitaciones):
    """Guarda las licitaciones en Neon, evitando duplicados."""
    
    if not licitaciones:
        print("\n⚠️  No hay licitaciones nuevas para guardar")
        return
    
    print(f"\n💾 Guardando {len(licitaciones)} licitaciones en base de datos...")
    
    # Filtrar duplicados en memoria
    referencias_vistas = set()
    licitaciones_unicas = []
    duplicados = 0
    
    for lic in licitaciones:
        if lic['referencia'] not in referencias_vistas:
            licitaciones_unicas.append(lic)
            referencias_vistas.add(lic['referencia'])
        else:
            duplicados += 1
    
    if duplicados > 0:
        print(f"⚠️  {duplicados} referencias duplicadas filtradas")
    
    print(f"✅ Insertando {len(licitaciones_unicas)} licitaciones únicas")
    
    conn = conectar_base_datos()
    if not conn:
        return
    
    try:
        cursor = conn.cursor()
        
        valores = []
        for lic in licitaciones_unicas:
            valores.append((
                lic['unidad_compras'],
                lic['referencia'],
                lic['descripcion'],
                lic['fecha_publicacion'],
                lic['fecha_presentacion'],
                lic['total_estimado_texto'],
                lic['monto_estimado'],
                lic['moneda'],
                lic['estado'],
                lic['url_detalle']
            ))
        
        query = """
            INSERT INTO licitaciones (
                unidad_compras, referencia, descripcion, 
                fecha_publicacion, fecha_presentacion, 
                total_estimado_texto, monto_estimado, moneda, 
                estado, url_detalle
            )
            VALUES %s
            ON CONFLICT (referencia) DO UPDATE SET
                estado = EXCLUDED.estado,
                actualizado_en = NOW()
        """
        
        execute_values(cursor, query, valores)
        
        # Contar cuántas son nuevas vs actualizadas
        cursor.execute("SELECT COUNT(*) FROM licitaciones WHERE DATE(creado_en) = CURRENT_DATE")
        nuevas_hoy = cursor.fetchone()[0]
        
        conn.commit()
        
        print(f"✅ Guardado exitoso:")
        print(f"   - Nuevas hoy: {nuevas_hoy}")
        print(f"   - Total procesadas: {len(licitaciones_unicas)}")
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ Error guardando en BD: {e}")
        import traceback
        traceback.print_exc()
        if conn:
            conn.rollback()
            conn.close()


# ============================================================================
# EJECUTAR SCRAPING DIARIO
# ============================================================================

if __name__ == "__main__":
    print("\n" + "🔄 "*35)
    print("COMPITA - SCRAPING DIARIO AUTOMÁTICO")
    print("🔄 "*35 + "\n")
    
    inicio = datetime.now()
    
    # Ejecutar scraping
    licitaciones = scraping_diario()
    
    # Mostrar resumen
    print("\n" + "="*70)
    print("📊 RESUMEN")
    print("="*70)
    print(f"🕐 Hora: {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    print(f"📈 Licitaciones encontradas: {len(licitaciones)}")
    
    # Guardar en BD
    if licitaciones:
        guardar_en_base_datos(licitaciones)
    
    fin = datetime.now()
    duracion = (fin - inicio).total_seconds()
    
    print(f"\n⏱️  Duración total: {duracion:.1f} segundos")
    print("\n✨ Proceso completado exitosamente\n")
