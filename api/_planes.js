// api/_planes.js — Fuente única de verdad sobre los planes de Compita (nov 2026)
//
// El guion bajo al inicio del nombre hace que Vercel NO lo publique como una
// función propia: es solo código compartido que importan los demás archivos de /api.
// Antes, cada archivo tenía su propia lista de planes y no coincidían entre sí
// (por eso Gold y Platinum recibían menos historial que Business, por ejemplo).

import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// NOMBRES DE PLAN
// ---------------------------------------------------------------------------
// 'prueba_gratis' es un nombre antiguo de 'free_trial'. Se tratan como el mismo plan.
export const PLAN_TITANIUM = 'enterprise_titanium';

export function normalizarPlan(plan) {
  return plan === 'prueba_gratis' ? 'free_trial' : plan;
}

// Planes que dan acceso a las funciones Business (descargar y analizar pliegos).
export const PLANES_BUSINESS_O_SUPERIOR = [
  'business', 'free_trial', 'enterprise',
  'enterprise_gold', 'enterprise_platinum', PLAN_TITANIUM,
];

export function tieneAccesoBusiness(plan) {
  return PLANES_BUSINESS_O_SUPERIOR.includes(normalizarPlan(plan));
}

// ---------------------------------------------------------------------------
// TOPES DEL PLAN TITANIUM
// ---------------------------------------------------------------------------
// Titanium es un plan especial que NO se vende: lo asigna un administrador desde
// el backoffice, con una fecha de vencimiento, a personas invitadas (por ejemplo,
// asesores de licitaciones). Tiene las funciones de Platinum, pero con topes.
// Para cambiar un tope, se cambia aquí (y el texto de cuenta.html que lo muestra).
export const TOPES_TITANIUM = {
  zip: 20,           // descargas de pliego en PDF por mes
  analisis: 15,      // análisis de pliego con IA por mes
  agente_033: 5,     // formularios F033 por mes
  agente_sprint: 5,  // Coach + Reporte + Prompt para KanbanBonsai, por mes
};

/**
 * Devuelve las capacidades y límites según el plan.
 * enterprise = tratado igual que enterprise_platinum (compatibilidad con Wilkin).
 */
export function capacidadesPlan(planBruto) {
  const plan = normalizarPlan(planBruto);
  const esPlatinum = ['enterprise_platinum', 'enterprise'].includes(plan);
  const esGold     = plan === 'enterprise_gold';
  const esBusiness = ['business', 'free_trial'].includes(plan);
  const esTitanium = plan === PLAN_TITANIUM;

  return {
    // Botones 1 y 2
    zip_ilimitado:             esPlatinum || esGold,
    analisis_ilimitado:        esPlatinum || esGold,
    zip_limite:                esBusiness ? 10 : (esTitanium ? TOPES_TITANIUM.zip : (esPlatinum || esGold ? 9999 : 0)),
    analisis_limite:           esBusiness ?  5 : (esTitanium ? TOPES_TITANIUM.analisis : (esPlatinum || esGold ? 9999 : 0)),
    // Botón 3 — Agente 033
    agente_033_disponible:     esPlatinum || esGold || esTitanium,
    agente_033_ilimitado:      esPlatinum,
    agente_033_limite_mes:     esGold ? 5 : (esTitanium ? TOPES_TITANIUM.agente_033 : (esPlatinum ? 9999 : 0)),
    // Botón 4 — Agente Sprint (Coach + Reporte) + KanbanBonsai IA
    // Todos comparten el mismo contador agente_sprint en uso_mensual
    agente_sprint_disponible:  esPlatinum || esTitanium,
    agente_sprint_limite_mes:  esPlatinum ? 5 : (esTitanium ? TOPES_TITANIUM.agente_sprint : 0),
    // Perfil Licitador (documentos habilitantes)
    perfil_licitador:          esPlatinum || esTitanium,
  };
}

// ---------------------------------------------------------------------------
// FAMILIAS UNSPSC E HISTORIAL
// ---------------------------------------------------------------------------
// Estándar: 2 familias y 30 días de historial. Todos los demás planes: 5 familias y 90 días.
export function maxFamiliasPlan(plan) {
  return tieneAccesoBusiness(plan) ? 5 : 2;
}

export function diasHistorialPlan(plan) {
  return tieneAccesoBusiness(plan) ? 90 : 30;
}

// ---------------------------------------------------------------------------
// VENCIMIENTO DEL ACCESO
// ---------------------------------------------------------------------------
// La prueba gratuita y el plan Titanium tienen fecha de fin (columna trial_fin).
// Esta función es la que decide, EN EL SERVIDOR, si el acceso ya terminó.
// Antes solo el navegador lo comprobaba, y se podía saltar.
export function planConVencimiento(plan) {
  const p = normalizarPlan(plan);
  return p === 'free_trial' || p === PLAN_TITANIUM;
}

export function accesoVencido(empresa, ahora = new Date()) {
  if (!empresa || !planConVencimiento(empresa.plan)) return false;
  if (!empresa.trial_fin) return false; // sin fecha: no se bloquea a nadie por un dato faltante
  const fin = empresa.trial_fin instanceof Date ? empresa.trial_fin : new Date(empresa.trial_fin);
  if (isNaN(fin.getTime())) return false;
  // El acceso incluye el día final completo.
  const finDelDia = new Date(fin.toISOString().slice(0, 10) + 'T23:59:59.999Z');
  return ahora > finDelDia;
}

// ---------------------------------------------------------------------------
// PASE PARA EL SERVICIO DE ANÁLISIS (Railway)
// ---------------------------------------------------------------------------
// El servicio que descarga y analiza pliegos vive aparte (Railway) y antes aceptaba
// a cualquiera. Ahora, cuando el usuario tiene cupo, este archivo le entrega un pase
// firmado que vale 20 minutos y solo para esa función. Railway lo verifica.
// Se activa definiendo SERVICIO_TOKEN_SECRET (la misma clave) en Vercel y en Railway.
export function emitirTokenServicio({ empresaId, permisos }) {
  const secreto = process.env.SERVICIO_TOKEN_SECRET;
  if (!secreto) return null;
  return jwt.sign(
    { empresa_id: empresaId, permisos, jti: randomUUID() },
    secreto,
    { algorithm: 'HS256', expiresIn: '20m' }
  );
}
