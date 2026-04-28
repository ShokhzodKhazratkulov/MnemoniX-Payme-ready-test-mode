
import express, { Request, Response } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import bodyParser from "body-parser";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Initialize Supabase Admin client
const supabase = createClient(
  process.env.VITE_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ""
);

app.use(bodyParser.json());

// Payme Merchant API Handler
app.post("/api/payme", async (req: Request, res: Response) => {
  const { method, params, id } = req.body;
  const authHeader = req.headers.authorization;

  // Basic Auth Check
  // Payme sends: Authorization: Basic Base64(Payme:Key)
  const paymeKey = process.env.PAYME_KEY;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.json({ id, error: { code: -32504, message: "Error auth" } });
  }

  // Payme Protocol Implementation
  try {
    switch (method) {
      case "CheckPerformTransaction":
        return await handleCheckPerform(params, id, res);
      case "CreateTransaction":
        return await handleCreateTransaction(params, id, res);
      case "PerformTransaction":
        return await handlePerformTransaction(params, id, res);
      case "CancelTransaction":
        return await handleCancelTransaction(params, id, res);
      case "CheckTransaction":
        return await handleCheckTransaction(params, id, res);
      default:
        return res.json({ id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (err) {
    console.error("Payme API Error:", err);
    return res.json({ id, error: { code: -31008, message: "Internal Server Error" } });
  }
});

// --- Payme Method Handlers ---

async function handleCheckPerform(params: any, id: any, res: any) {
  const { amount, account } = params;
  const orderId = account.order_id;

  // Check if payment already exists
  const { data: payment } = await supabase.from('payments').select('*').eq('order_id', orderId).single();

  if (!payment) {
    return res.json({ id, error: { code: -31050, message: "Order not found" } });
  }

  if (payment.amount !== amount) {
    return res.json({ id, error: { code: -31050, message: "Incorrect amount" } });
  }

  return res.json({
    id,
    result: {
      allow: true,
      detail: {
        order_id: orderId,
        description: `MnemoniX Premium: ${payment.package_type}`
      }
    }
  });
}

async function handleCreateTransaction(params: any, id: any, res: any) {
  const { id: paymeId, time, amount, account } = params;
  const orderId = account.order_id;

  const { data: payment } = await supabase.from('payments').select('*').eq('order_id', orderId).single();

  if (!payment) {
    return res.json({ id, error: { code: -31050, message: "Order not found" } });
  }

  // Check if transaction already exists
  if (payment.payme_transaction_id && payment.payme_transaction_id !== paymeId) {
    return res.json({ id, error: { code: -31099, message: "Transaction already exists" } });
  }

  // Update payment with payme transaction ID
  await supabase.from('payments').update({
    payme_transaction_id: paymeId,
    status: 'pending'
  }).eq('order_id', orderId);

  return res.json({
    id,
    result: {
      create_time: Date.now(),
      transaction: payment.id,
      state: 1
    }
  });
}

async function handlePerformTransaction(params: any, id: any, res: any) {
  const { id: paymeId } = params;

  const { data: payment } = await supabase.from('payments').select('*').eq('payme_transaction_id', paymeId).single();

  if (!payment) {
    return res.json({ id, error: { code: -31003, message: "Transaction not found" } });
  }

  if (payment.status === 'paid') {
    return res.json({
      id,
      result: {
        perform_time: new Date(payment.updated_at).getTime(),
        transaction: payment.id,
        state: 2
      }
    });
  }

  // FULFILLMENT: Update subscription in user profile
  const months = payment.package_type === '1_month' ? 1 : payment.package_type === '3_months' ? 3 : 6;
  const expiryDate = new Date();
  expiryDate.setMonth(expiryDate.getMonth() + months);

  // Update Profile
  await supabase.from('profiles').update({
    subscription_tier: 'PREMIUM',
    subscription_expires_at: expiryDate.toISOString()
  }).eq('id', payment.user_id);

  // Update Payment Status
  const { data: updatedPayment } = await supabase.from('payments').update({
    status: 'paid',
    updated_at: new Date().toISOString()
  }).eq('id', payment.id).select().single();

  return res.json({
    id,
    result: {
      perform_time: Date.now(),
      transaction: payment.id,
      state: 2
    }
  });
}

async function handleCancelTransaction(params: any, id: any, res: any) {
  const { id: paymeId, reason } = params;

  const { data: payment } = await supabase.from('payments').select('*').eq('payme_transaction_id', paymeId).single();

  if (!payment) {
    return res.json({ id, error: { code: -31003, message: "Transaction not found" } });
  }

  await supabase.from('payments').update({
    status: 'cancelled',
    updated_at: new Date().toISOString()
  }).eq('id', payment.id);

  return res.json({
    id,
    result: {
      cancel_time: Date.now(),
      transaction: payment.id,
      state: -1
    }
  });
}

async function handleCheckTransaction(params: any, id: any, res: any) {
  const { id: paymeId } = params;

  const { data: payment } = await supabase.from('payments').select('*').eq('payme_transaction_id', paymeId).single();

  if (!payment) {
    return res.json({ id, error: { code: -31003, message: "Transaction not found" } });
  }

  return res.json({
    id,
    result: {
      create_time: new Date(payment.created_at).getTime(),
      perform_time: payment.status === 'paid' ? new Date(payment.updated_at).getTime() : 0,
      cancel_time: payment.status === 'cancelled' ? new Date(payment.updated_at).getTime() : 0,
      transaction: payment.id,
      state: payment.status === 'paid' ? 2 : payment.status === 'cancelled' ? -1 : 1,
      reason: null
    }
  });
}

// --- Vite and SPA Fallback ---

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
