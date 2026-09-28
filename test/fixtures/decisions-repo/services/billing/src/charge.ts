export interface Charge {
  id: string;
  idempotencyKey: string;
  amountCents: number;
}

export function chargeKey(accountId: string, invoiceId: string): string {
  return `${accountId}:${invoiceId}`;
}
