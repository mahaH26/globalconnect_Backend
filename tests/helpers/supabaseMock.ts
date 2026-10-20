type Result = { data: any; error: any };

const results: Record<string, Result> = {};
export const payloads: Record<string, any> = {};

export function setResult(key: string, data: any, error: any = null) {
  results[key] = { data, error };
}

export function resetDb() {
  for (const k of Object.keys(results)) delete results[k];
  for (const k of Object.keys(payloads)) delete payloads[k];
}

function builder(table: string) {
  let op: string | null = null;
  const key = () => `${table}:${op ?? "select"}`;
  const out = () => results[key()] ?? { data: null, error: null };
  const b: any = {};

  for (const m of ["select", "insert", "update", "delete"]) {
    b[m] = (arg?: any) => {
      if (!op) op = m;
      if ((m === "insert" || m === "update") && op === m) payloads[key()] = arg;
      return b;
    };
  }
  for (const m of ["eq", "neq", "in", "gte", "lte", "order", "limit"]) {
    b[m] = () => b;
  }
  b.single = async () => out();
  b.maybeSingle = async () => out();
  b.then = (ok: any, fail: any) => Promise.resolve(out()).then(ok, fail);
  return b;
}

export const supabase = {
  from: (table: string) => builder(table),
  auth: { getUser: jest.fn() },
};
