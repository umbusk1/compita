"""
COMPITA - Diagnóstico de Scraping
===================================
¿Cuántas licitaciones hay realmente en el portal?

- NO guarda nada en la base de datos
- Hace clicks en "Ver más" sin límite hasta que desaparezca el botón
- Reporta cuántas licitaciones de 2026 existen en total
- Reporta cuántos clicks fueron necesarios

Ejecutar manualmente desde GitHub Actions → workflow_dispatch
"""

import time
from datetime import datetime
from playwright.sync_api import sync_playwright

PORTAL_URL = "https://comunidad.comprasdominicana.gob.do/Public/Tendering/ContractNoticeManagement/Index"
HEADLESS = True

def diagnostico():
    print("\n" + "="*70)
    print("🔍 COMPITA - DIAGNÓSTICO DE SCRAPING")
    print(f"🕐 Inicio: {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    print("="*70)
    print("⚠️  Modo diagnóstico: NO se guarda nada en la BD\n")

    with sync_playwright() as p:
        print("📱 Iniciando navegador...")
        browser = p.chromium.launch(headless=HEADLESS)
        page = browser.new_page()
        page.set_default_timeout(30000)

        try:
            print(f"🌐 Navegando al portal...")
            page.goto(PORTAL_URL)

            print("⏳ Esperando tabla inicial...")
            try:
                page.wait_for_selector("table tbody tr", timeout=15000)
                print("✅ Tabla inicial cargada\n")
            except Exception as e:
                print(f"⚠️  Advertencia: {e}\n")

            time.sleep(5)

            # ================================================================
            # CLICKS SIN LÍMITE — hasta que desaparezca el botón
            # ================================================================
            print("🔄 Haciendo clicks en 'Ver más' sin límite...")
            print("   (esto puede tomar varios minutos)\n")

            clicks_exitosos = 0
            intentos_fallidos = 0
            MAX_INTENTOS_FALLIDOS = 3

            while intentos_fallidos < MAX_INTENTOS_FALLIDOS:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                time.sleep(1)

                boton_encontrado = False

                # Intento 1: selectores directos
                selectores = [
                    "text='Ver más'",
                    "text='ver más'",
                    "text='VER MÁS'",
                    "a:has-text('Ver más')",
                    "button:has-text('Ver más')",
                    "[onclick*='VerMas']",
                    "[onclick*='vermas']"
                ]
                for selector in selectores:
                    try:
                        boton = page.locator(selector).first
                        if boton.is_visible(timeout=2000):
                            boton.scroll_into_view_if_needed()
                            time.sleep(0.5)
                            boton.click()
                            clicks_exitosos += 1
                            boton_encontrado = True
                            intentos_fallidos = 0
                            print(f"   ✅ Click #{clicks_exitosos}")
                            time.sleep(5)
                            break
                    except:
                        continue

                # Intento 2: búsqueda manual en todos los enlaces
                if not boton_encontrado:
                    try:
                        enlaces = page.query_selector_all("a, button")
                        for enlace in enlaces:
                            try:
                                texto = enlace.inner_text().strip().lower()
                                if "ver más" in texto or "ver mas" in texto:
                                    if enlace.is_visible():
                                        enlace.scroll_into_view_if_needed()
                                        time.sleep(0.5)
                                        enlace.click()
                                        clicks_exitosos += 1
                                        boton_encontrado = True
                                        intentos_fallidos = 0
                                        print(f"   ✅ Click #{clicks_exitosos} (búsqueda manual)")
                                        time.sleep(5)
                                        break
                            except:
                                continue
                    except:
                        pass

                # Intento 3: JavaScript
                if not boton_encontrado:
                    try:
                        resultado = page.evaluate("""
                            () => {
                                const elementos = Array.from(document.querySelectorAll('a, button'));
                                for (let elem of elementos) {
                                    const texto = elem.innerText || elem.textContent || '';
                                    if (texto.toLowerCase().includes('ver más') || texto.toLowerCase().includes('ver mas')) {
                                        elem.click();
                                        return true;
                                    }
                                }
                                return false;
                            }
                        """)
                        if resultado:
                            clicks_exitosos += 1
                            boton_encontrado = True
                            intentos_fallidos = 0
                            print(f"   ✅ Click #{clicks_exitosos} (JavaScript)")
                            time.sleep(5)
                    except:
                        pass

                if not boton_encontrado:
                    intentos_fallidos += 1
                    print(f"   ⚠️  Botón no encontrado (intento {intentos_fallidos}/{MAX_INTENTOS_FALLIDOS})")
                    time.sleep(3)

            print(f"\n✅ Botón 'Ver más' desapareció después de {clicks_exitosos} clicks")
            print("   → Todas las licitaciones del portal están ahora cargadas\n")

            # ================================================================
            # CONTAR LICITACIONES
            # ================================================================
            print("="*70)
            print("📊 CONTANDO LICITACIONES...")
            print("="*70)

            time.sleep(2)

            try:
                page.wait_for_selector("table", timeout=10000)
            except:
                pass

            filas = page.query_selector_all("table tbody tr")

            fila_principal = None
            for fila in filas:
                celdas = fila.query_selector_all("td")
                if len(celdas) > 100:
                    fila_principal = celdas
                    break

            if not fila_principal:
                print("❌ No se encontró la fila principal de datos")
                return

            total_celdas = len(fila_principal)
            total_filas_aprox = (total_celdas - 93) // 10

            print(f"   Total celdas en tabla: {total_celdas}")
            print(f"   Licitaciones estimadas: ~{total_filas_aprox}\n")

            # Contar exactamente cuántas son de 2026
            count_2026 = 0
            count_otras = 0
            count_sin_fecha = 0
            años_encontrados = {}

            inicio_datos = 93
            for i in range(inicio_datos, total_celdas, 10):
                try:
                    if i + 5 >= total_celdas:
                        break

                    fecha_pres_texto = fila_principal[i+5].inner_text().strip()
                    fecha_limpia = fecha_pres_texto.replace(" (UTC -4 hours)", "").replace(" (UTC -4 horas)", "").strip()

                    if not fecha_limpia:
                        count_sin_fecha += 1
                        continue

                    # Extraer año
                    año = None
                    partes = fecha_limpia.split("/")
                    if len(partes) >= 3:
                        try:
                            año = int(partes[2][:4])
                        except:
                            pass

                    if año:
                        años_encontrados[año] = años_encontrados.get(año, 0) + 1
                        if año >= 2026:
                            count_2026 += 1
                        else:
                            count_otras += 1
                    else:
                        count_sin_fecha += 1

                except:
                    count_sin_fecha += 1
                    continue

            # ================================================================
            # REPORTE FINAL
            # ================================================================
            print("="*70)
            print("📋 REPORTE FINAL DE DIAGNÓSTICO")
            print("="*70)
            print(f"\n🔢 Clicks en 'Ver más' realizados: {clicks_exitosos}")
            print(f"📄 Total licitaciones en portal:   ~{total_filas_aprox}")
            print(f"✅ Licitaciones de 2026:           {count_2026}")
            print(f"📅 Licitaciones de años anteriores:{count_otras}")
            print(f"❓ Sin fecha legible:               {count_sin_fecha}")
            print(f"\n📊 Distribución por año:")
            for año, cantidad in sorted(años_encontrados.items(), reverse=True):
                print(f"   {año}: {cantidad} licitaciones")

            print(f"\n💡 CONCLUSIÓN:")
            if clicks_exitosos <= 10:
                print(f"   El límite actual de MAX_CLICKS=10 es SUFICIENTE.")
                print(f"   El portal tiene pocas licitaciones disponibles.")
            else:
                print(f"   ⚠️  El límite actual de MAX_CLICKS=10 es INSUFICIENTE.")
                print(f"   Se necesitan al menos {clicks_exitosos} clicks para ver todo.")
                print(f"   Recomendación: cambiar MAX_CLICKS a {clicks_exitosos + 5}")

            print("\n" + "="*70)
            print(f"🕐 Fin: {datetime.now().strftime('%d/%m/%Y %H:%M')}")
            print("="*70 + "\n")

        except Exception as e:
            print(f"\n❌ Error durante diagnóstico: {e}")
            import traceback
            traceback.print_exc()

        finally:
            print("🔒 Cerrando navegador...")
            browser.close()


if __name__ == "__main__":
    diagnostico()