// Auth state do Baileys persistido no PostgreSQL.
// Cada loja tem seu próprio conjunto de credenciais, prefixadas com lojaId.
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

export async function useDatabaseAuthState(sql: any, lojaId: string) {
  const prefix = `${lojaId}:`;

  async function readData(id: string): Promise<any | null> {
    const rows = await sql`SELECT value FROM baileys_auth_state WHERE id = ${prefix + id}`;
    if (!rows[0]) return null;
    return JSON.parse(rows[0].value, BufferJSON.reviver);
  }

  async function writeData(id: string, data: any): Promise<void> {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await sql`
      INSERT INTO baileys_auth_state (id, value)
      VALUES (${prefix + id}, ${value})
      ON CONFLICT (id) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
    `;
  }

  async function removeData(id: string): Promise<void> {
    await sql`DELETE FROM baileys_auth_state WHERE id = ${prefix + id}`;
  }

  const creds = (await readData('creds')) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const data: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData(`${type}-${id}`);
              if (value !== null) data[id] = value;
            }),
          );
          return data;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          const tasks: Promise<void>[] = [];
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, value] of Object.entries(ids ?? {})) {
              tasks.push(
                value != null
                  ? writeData(`${type}-${id}`, value)
                  : removeData(`${type}-${id}`),
              );
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
  };
}
