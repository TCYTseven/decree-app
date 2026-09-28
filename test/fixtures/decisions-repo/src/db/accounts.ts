import { query } from "./index.js";

export interface Account {
  id: string;
  balanceCents: number;
}

export function getAccount(id: string): Promise<Account[]> {
  return query<Account>("select id, balance_cents as \"balanceCents\" from accounts where id = $1", [id]);
}
