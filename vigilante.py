"""
COMPITA - Vigilante de Sistema (v1)
=====================================
Corre cada 30 minutos vía GitHub Actions.
Revisa la tabla sistema_estado y, si corresponde,
notifica a los usuarios y activa el modal.

Lógica:
  - Si estado = ALERTA_PENDIENTE
    y abortado_por_admin = FALSE
    y han pasado >= 60 minutos desde fecha_alerta_admin
    y es horario de oficina (L-V 8AM-8PM hora Santo Domingo)
    → Envía emails a usuarios, activa modal, cambia estado a SUSPENDIDO

  - En cualquier otro caso: no hace nada.
"""

import os
import requests
import psycopg2
from datetime import datetime, timezone, timedelta

# ============================================================================
# CONFIGURACIÓN
# ============================================================================

DATABASE_URL   = os.getenv('DATABASE_URL')
RESEND_API_KEY = os.getenv('RESEND_API_KEY')
FROM_EMAIL     = 'Compita <noreply@compita.umbusk.com>'

# Zona horaria Santo Domingo (UTC-4, sin horario de verano)
TZ_SD = timezone(timedelta(hours=-4))

# Horario de oficina: lunes(0) a viernes(4), 8:00 a 20:00
HORA_INICIO_OFICINA = 8
HORA_FIN_OFICINA    = 20

# ============================================================================
# CONEXIÓN A BASE DE DATOS
# ============================================================================

def conectar():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except Exception as e:
        print(f"❌ Error conectando a BD: {e}")
        return None

# ============================================================================
# VERIFICAR HORARIO DE OFICINA
# ============================================================================

def es_horario_oficina():
    """
    Retorna True si ahora mismo es lunes-viernes entre 8AM y 8PM
    en la zona horaria de Santo Domingo (UTC-4).
    """
    ahora_sd = datetime.now(TZ_SD)
    dia_semana = ahora_sd.weekday()   # 0=lunes, 6=domingo
    hora_actual = ahora_sd.hour

    es_dia_habil   = dia_semana <= 4   # lunes a viernes
    es_hora_habil  = HORA_INICIO_OFICINA <= hora_actual < HORA_FIN_OFICINA

    print(f"🕐 Hora actual Santo Domingo: {ahora_sd.strftime('%d/%m/%Y %H:%M')} "
          f"(día {dia_semana}, hora {hora_actual})")
    print(f"   Día hábil: {es_dia_habil} | Hora hábil: {es_hora_habil}")

    return es_dia_habil and es_hora_habil

# ============================================================================
# OBTENER ESTADO ACTUAL DEL SISTEMA
# ============================================================================

def obtener_estado_sistema(conn):
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT estado, motivo, fecha_alerta_admin,
                   abortado_por_admin, notificacion_usuarios_enviada
            FROM sistema_estado
            WHERE id = 1
        """)
        row = cursor.fetchone()
        cursor.close()
        if row:
            return {
                'estado':                          row[0],
                'motivo':                          row[1],
                'fecha_alerta_admin':              row[2],
                'abortado_por_admin':              row[3],
                'notificacion_usuarios_enviada':   row[4]
            }
        return None
    except Exception as e:
        print(f"❌ Error leyendo sistema_estado: {e}")
        return None

# ============================================================================
# OBTENER EMAILS DE USUARIOS ACTIVOS
# ============================================================================

def obtener_usuarios_activos(conn):
    """
    Retorna lista de dicts con nombre y email de todos los usuarios
    con plan activo (no cancelado, no expirado).
    """
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT nombre, email
            FROM usuarios
            WHERE plan != 'cancelado'
              AND activo = TRUE
            ORDER BY nombre
        """)
        rows = cursor.fetchall()
        cursor.close()
        usuarios = [{'nombre': r[0], 'email': r[1]} for r in rows]
        print(f"📋 Usuarios activos encontrados: {len(usuarios)}")
        return usuarios
    except Exception as e:
        print(f"❌ Error obteniendo usuarios activos: {e}")
        return []

# ============================================================================
# ENVIAR EMAIL A UN USUARIO
# ============================================================================

def enviar_email_usuario(nombre, email, motivo):
    """
    Envía el aviso de suspensión a un usuario individual vía Resend.
    Retorna True si fue exitoso.
    """
    if not RESEND_API_KEY:
        print("⚠️  RESEND_API_KEY no configurado")
        return False

    descripciones = {
        'portal_inaccesible':    'el portal del gobierno no está accesible en este momento',
        'estructura_modificada': 'el portal del gobierno fue modificado y estamos adaptando el sistema'
    }
    descripcion = descripciones.get(motivo, 'una situación técnica fuera de nuestro control')
    nombre_corto = nombre.split()[0] if nombre else 'estimado usuario'

    html_body = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #2c5f2e; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">Compita — Aviso de Servicio</h2>
      </div>
      <div style="background: #f9f9f9; padding: 24px; border: 1px solid #ddd; border-radius: 0 0 8px 8px;">
        <p>Hola, <strong>{nombre_corto}</strong>.</p>
        <p>
          Te informamos que el servicio de monitoreo de licitaciones de Compita
          se encuentra <strong>temporalmente suspendido</strong> porque
          {descripcion}.
        </p>
        <p>
          Estamos trabajando para restablecer el servicio a la brevedad posible.
          Tan pronto como esté disponible, recibirás una notificación y el
          seguimiento de oportunidades continuará normalmente.
        </p>
        <p>
          Lamentamos los inconvenientes que esto pueda causarte.
          Tu suscripción <strong>no se verá afectada</strong> durante
          este período de suspensión.
        </p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
        <p style="color: #999; font-size: 12px;">
          Este mensaje fue generado automáticamente por el sistema de
          notificaciones de Compita. Si tienes preguntas, responde a este
          correo y te atenderemos.
        </p>
      </div>
    </div>
    """

    try:
        response = requests.post(
            'https://api.resend.com/emails',
            headers={
                'Authorization': f'Bearer {RESEND_API_KEY}',
                'Content-Type':  'application/json'
            },
            json={
                'from':    FROM_EMAIL,
                'to':      [email],
                'subject': '⚠️ Compita: Servicio temporalmente suspendido',
                'html':    html_body
            },
            timeout=15
        )
        return response.status_code in [200, 201]
    except Exception as e:
        print(f"   ❌ Error enviando a {email}: {e}")
        return False

# ============================================================================
# ACTIVAR SUSPENSIÓN COMPLETA
# ============================================================================

def activar_suspension(conn, motivo, usuarios):
    """
    Envía emails a todos los usuarios activos,
    activa el modal y cambia el estado a SUSPENDIDO.
    """
    print(f"\n📧 Enviando notificaciones a {len(usuarios)} usuarios...")

    enviados  = 0
    fallidos  = 0
    for u in usuarios:
        ok = enviar_email_usuario(u['nombre'], u['email'], motivo)
        if ok:
            enviados += 1
            print(f"   ✅ {u['email']}")
        else:
            fallidos += 1
            print(f"   ❌ {u['email']} — falló")

    print(f"\n📊 Emails: {enviados} enviados, {fallidos} fallidos")

    # Actualizar DB: estado SUSPENDIDO + modal activo
    try:
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE sistema_estado SET
                estado                        = 'SUSPENDIDO',
                modal_activo                  = TRUE,
                notificacion_usuarios_enviada = TRUE,
                fecha_notificacion_usuarios   = NOW(),
                actualizado_en                = NOW()
            WHERE id = 1
        """)
        conn.commit()
        cursor.close()
        print("✅ Estado cambiado a SUSPENDIDO y modal activado en DB")
    except Exception as e:
        print(f"❌ Error actualizando DB a SUSPENDIDO: {e}")
        conn.rollback()

# ============================================================================
# MAIN
# ============================================================================

def main():
    print("\n" + "="*60)
    print("🔍 COMPITA - VIGILANTE DE SISTEMA")
    print(f"🕐 Inicio: {datetime.now().strftime('%d/%m/%Y %H:%M')} UTC")
    print("="*60 + "\n")

    conn = conectar()
    if not conn:
        print("❌ No se pudo conectar a la base de datos. Abortando.")
        return

    # 1. Leer estado actual
    estado = obtener_estado_sistema(conn)
    if not estado:
        print("❌ No se pudo leer sistema_estado. Abortando.")
        conn.close()
        return

    print(f"📊 Estado actual del sistema: {estado['estado']}")

    # 2. Solo actuar si está en ALERTA_PENDIENTE
    if estado['estado'] != 'ALERTA_PENDIENTE':
        print(f"ℹ️  Estado '{estado['estado']}' — nada que hacer.")
        conn.close()
        return

    # 3. Verificar que el Admin no haya abortado
    if estado['abortado_por_admin']:
        print("✋ Admin abortó la notificación — no se envía nada.")
        conn.close()
        return

    # 4. Verificar que ya pasó 1 hora desde la alerta al Admin
    fecha_alerta = estado['fecha_alerta_admin']
    if not fecha_alerta:
        print("⚠️  No hay fecha de alerta al Admin registrada. Esperando próxima ejecución.")
        conn.close()
        return

    ahora_utc = datetime.now(timezone.utc)

    # psycopg2 devuelve datetime con tzinfo si la columna es TIMESTAMPTZ
    if fecha_alerta.tzinfo is None:
        fecha_alerta = fecha_alerta.replace(tzinfo=timezone.utc)

    minutos_transcurridos = (ahora_utc - fecha_alerta).total_seconds() / 60
    print(f"⏱️  Minutos desde alerta al Admin: {minutos_transcurridos:.1f}")

    if minutos_transcurridos < 60:
        restantes = 60 - minutos_transcurridos
        print(f"⏳ Faltan {restantes:.1f} minutos para cumplir la hora de gracia. Esperando.")
        conn.close()
        return

    # 5. Verificar horario de oficina
    if not es_horario_oficina():
        print("🌙 Fuera de horario de oficina (L-V 8AM-8PM). Esperando próxima ejecución.")
        conn.close()
        return

    # 6. Todo listo — activar suspensión
    print("\n🚨 Condiciones cumplidas — activando suspensión del servicio...")
    motivo   = estado['motivo'] or 'portal_inaccesible'
    usuarios = obtener_usuarios_activos(conn)

    if not usuarios:
        print("⚠️  No hay usuarios activos para notificar.")
        # Aun así activamos el modal
        try:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE sistema_estado SET
                    estado                        = 'SUSPENDIDO',
                    modal_activo                  = TRUE,
                    notificacion_usuarios_enviada = TRUE,
                    fecha_notificacion_usuarios   = NOW(),
                    actualizado_en                = NOW()
                WHERE id = 1
            """)
            conn.commit()
            cursor.close()
            print("✅ Modal activado (sin usuarios que notificar)")
        except Exception as e:
            print(f"❌ Error activando modal: {e}")
    else:
        activar_suspension(conn, motivo, usuarios)

    conn.close()
    print("\n✅ Vigilante completado.\n")


if __name__ == "__main__":
    main()