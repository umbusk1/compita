// api/stripe-portal.js - Portal de facturación de Stripe
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Verificar JWT Token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  const userId = decoded.userId;

  try {
    // Obtener email del usuario
    const userResult = await pool.query(
      `SELECT email FROM usuarios WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userResult.rows[0];

    // Buscar Customer en Stripe
    const customers = await stripe.customers.list({
      email: user.email,
      limit: 1
    });

    if (customers.data.length === 0) {
      return res.status(404).json({
        error: 'No tienes una cuenta de facturación activa. Suscríbete primero a un plan.'
      });
    }

    const customer = customers.data[0];

    // Crear sesión del Portal de Facturación
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${req.headers.origin}/cuenta.html`
    });

    return res.status(200).json({
      portal_url: session.url
    });

  } catch (error) {
    console.error('Error creando portal de facturación:', error);
    return res.status(500).json({ error: 'Error al acceder al portal de facturación' });
  }
}