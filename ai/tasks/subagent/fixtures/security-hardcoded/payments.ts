// Shipped in the mobile JS bundle.
const PAYMENTS_BASE_URL = 'https://payments.example.com/v1';
const PAYMENTS_MERCHANT_SECRET = 'live_merchant_9f8e7d6c5b4a3210fedcba98';

export async function createRefund(orderId: string, amountCents: number) {
  const res = await fetch(`${PAYMENTS_BASE_URL}/refunds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Merchant-Secret': PAYMENTS_MERCHANT_SECRET },
    body: JSON.stringify({ orderId, amountCents }),
  });
  if (!res.ok) throw new Error(`refund failed: ${res.status}`);
  return res.json();
}
